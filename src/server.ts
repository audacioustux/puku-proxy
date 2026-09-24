/**
 * Bun HTTP server: OpenAI-compatible API surface over puku-agent-sdk.
 *
 * Routes:
 *   GET  /healthz             → liveness
 *   GET  /v1/models           → model list
 *   POST /v1/chat/completions → translates OpenAI request to puku query()
 *
 * Streaming responses use text/event-stream with the OpenAI SSE chunk shape.
 */

import { proxyChatCompletion } from "./proxy.ts";
import {
  ChatRequestSchema,
  findUnsupportedFields,
  type ChatRequest,
  type OpenAICompletion,
  type OpenAIError,
} from "./openai.ts";
import {
  assistantToCompletion,
  streamWasTruncated,
  translateStream,
  newStreamingState,
  sseDone,
  sseEncode,
  usageFromRecord,
} from "./translate.ts";
import { healthResponse } from "./health.ts";
import { loadAuthTokens, verifyRequest } from "./auth.ts";
import { getModelList, startModelListRefresh } from "./models.ts";
import { debug, debugEnabled, nextRequestId } from "./debug.ts";

/**
 * Largest accepted request body, in bytes. Override with
 * `PUKU_PROXY_MAX_BODY_BYTES`.
 *
 * Each chat request spawns a puku-cli subprocess, so an oversized prompt is an
 * expensive request and worth bounding. The default is 5MB: agent traffic
 * carrying long tool-call histories is legitimately large — production logs
 * show conversations of 175 messages — and rejecting those is worse than
 * serving them. Tune it rather than removing it.
 */
const MAX_REQUEST_BODY_BYTES = (() => {
  const raw = process.env["PUKU_PROXY_MAX_BODY_BYTES"];
  if (!raw) return 5_000_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[config] PUKU_PROXY_MAX_BODY_BYTES="${raw}" is not a positive number; using 5000000`
    );
    return 5_000_000;
  }
  return parsed;
})();

// ---- Helpers ----

function jsonError(message: string, type: string, status: number): Response {
  const body: OpenAIError = { error: { message, type, param: null, code: null } };
  return Response.json(body, { status, headers: { "content-type": "application/json" } });
}

function jsonOk<T>(body: T, status = 200): Response {
  return Response.json(body, { status, headers: { "content-type": "application/json" } });
}

/**
 * Whether a thrown error is just the client hanging up.
 *
 * Bun aborts `req.signal` on disconnect and the SDK surfaces that as
 * `AbortError: Transport aborted`. It is ordinary traffic — a user closing a
 * tab — not a server fault, and there is no longer anyone to send an error
 * frame to. Treating it as a failure produced ~90 log lines per disconnect
 * (the whole DOMException constant table, logged twice).
 */
function isClientDisconnect(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && err.name === "AbortError";
}

/**
 * One line per completed request, always emitted.
 *
 * Previously only `/v1/chat/completions` successes logged anything, and only
 * under PUKU_PROXY_DEBUG: 401s, 400s, 404s and oversized-body rejections were
 * entirely invisible, so a client seeing an error had no server-side trace to
 * correlate against.
 */
function logRequest(
  id: string,
  req: Request,
  status: number,
  startedAt: number,
  note?: string
): void {
  const ms = Date.now() - startedAt;
  const path = new URL(req.url).pathname;
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  const line = `[${id}] ${level} ${req.method} ${path} ${status} ${ms}ms${note ? ` — ${note}` : ""}`;
  if (status >= 500) console.error(line);
  else console.warn(line);
}

// ---- Route handlers ----

async function handleModels(): Promise<Response> {
  return jsonOk(getModelList());
}

export async function handleChat(req: Request): Promise<Response> {
  const id = nextRequestId();
  const startedAt = Date.now();
  if (debugEnabled) {
    debug(id, `entry method=${req.method} url=${new URL(req.url).pathname}`);
    debug(
      id,
      `req.signal.aborted=${req.signal?.aborted ?? "no-signal"} reason=${JSON.stringify(req.signal?.reason)}`
    );
  }

  // 1. Parse + validate.
  //
  // Read the body ourselves rather than relying solely on Bun's
  // maxRequestBodySize: that drops the connection mid-upload, which reaches
  // the caller as an opaque socket error (undici: UND_ERR_SOCKET "other side
  // closed") and logs nothing here. An explicit check returns a real 413 the
  // client can act on, and leaves a trace.
  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch (err) {
    logRequest(id, req, 400, startedAt, "could not read request body");
    return jsonError("could not read request body", "invalid_request_error", 400);
  }
  if (bodyText.length > MAX_REQUEST_BODY_BYTES) {
    const mb = (bodyText.length / 1_000_000).toFixed(1);
    logRequest(id, req, 413, startedAt, `body ${mb}MB exceeds limit`);
    return jsonError(
      `request body is ${mb}MB, which exceeds the ${(MAX_REQUEST_BODY_BYTES / 1_000_000).toFixed(1)}MB limit ` +
        `(raise PUKU_PROXY_MAX_BODY_BYTES to allow larger requests)`,
      "invalid_request_error",
      413
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    logRequest(id, req, 400, startedAt, "invalid JSON");
    return jsonError("request body must be valid JSON", "invalid_request_error", 400);
  }

  const unsupported = findUnsupportedFields(raw);
  if (unsupported.length > 0) {
    console.warn(`[${id}] ignoring unsupported fields: ${unsupported.join(", ")}`);
  }

  const parsed = ChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    logRequest(id, req, 400, startedAt, "schema validation failed");
    return jsonError(
      `validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      "invalid_request_error",
      400
    );
  }
  const body = parsed.data;

  if (debugEnabled) {
    debug(id, `parsed model=${body.model} stream=${body.stream} messages=${body.messages.length}`);
  }

  // 2. Dispatch.
  if (body.stream) {
    return streamChat(body, req.signal, id);
  }
  return await nonStreamChat(body, req.signal, id);
}

async function nonStreamChat(
  body: Parameters<typeof ChatRequestSchema.parse>[0],
  signal: AbortSignal | undefined,
  id: string
): Promise<Response> {
  const validated = ChatRequestSchema.parse(body);
  let assistantMessage: unknown = null;
  let resultUsage: Record<string, number> | undefined;

  try {
    for await (const msg of proxyChatCompletion(validated, signal)) {
      if (typeof msg !== "object" || msg === null) continue;
      const m = msg as { type?: string; usage?: Record<string, number> };
      if (m.type === "assistant") {
        assistantMessage = msg;
      } else if (m.type === "result" && m.usage) {
        // `result.usage` carries the authoritative token counts; the
        // assistant message's usage is often empty in non-streaming mode.
        resultUsage = m.usage;
      }
    }
  } catch (err) {
    if (isClientDisconnect(err, signal)) {
      console.log(`[${id}] client disconnected before completion`);
      return jsonError("client disconnected", "invalid_request_error", 499);
    }
    debug(id, `non-stream error (signal.aborted=${signal?.aborted}):`, err);
    console.error(`[${id}] non-stream error:`, err instanceof Error ? err.message : err);
    return jsonError(
      err instanceof Error ? err.message : String(err),
      "server_error",
      500
    );
  }

  if (!assistantMessage) {
    return jsonError("puku did not return an assistant message", "server_error", 502);
  }

  const completion: OpenAICompletion = assistantToCompletion(
    assistantMessage as Parameters<typeof assistantToCompletion>[0],
    validated.model
  );
  // Prefer result.usage over assistant.message.usage if both exist.
  if (resultUsage) {
    const input = resultUsage["input_tokens"] ?? 0;
    const output = resultUsage["output_tokens"] ?? 0;
    completion.usage = {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
    };
  }
  return jsonOk(completion);
}

/**
 * `upstream` is injectable purely as a test seam: it defaults to the real
 * puku call, and a test can substitute a paced async iterable to assert that
 * chunks leave this function as they arrive rather than in one batch.
 */
export function streamChat(
  body: Parameters<typeof ChatRequestSchema.parse>[0],
  signal: AbortSignal | undefined,
  id: string,
  upstream: (
    req: ChatRequest,
    signal: AbortSignal | undefined
  ) => AsyncIterable<unknown> = proxyChatCompletion
): Response {
  const validated = ChatRequestSchema.parse(body);
  const state = newStreamingState(validated.model);

  if (debugEnabled) {
    debug(
      id,
      `entering streamChat: signal.aborted=${signal?.aborted} reason=${JSON.stringify(signal?.reason)}`
    );
  }

  let heartbeatCount = 0;
  let lastChunkAt = Date.now();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const write = (s: string) => controller.enqueue(encoder.encode(s));
      const markChunk = () => {
        lastChunkAt = Date.now();
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // SSE keep-alive: puku-cli can take 10-30s to produce its first token,
      // during which the SSE stream has nothing to send. Traefik / Dokploy's
      // edge will close the connection on its idle timeout (default ~30s),
      // killing the request before any data flows. Emit an SSE comment
      // (lines starting with `:` are ignored by OpenAI clients and SSE
      // parsers) every 15s while we're still buffering the upstream messages.
      const heartbeat = setInterval(() => {
        heartbeatCount += 1;
        try {
          write(": keep-alive\n\n");
          debug(
            id,
            `heartbeat #${heartbeatCount} Δt=${Date.now() - lastChunkAt}ms`
          );
        } catch {
          // controller already closed; that's fine, the timer just needs to stop
        }
      }, 15_000);

      // Translate and emit each upstream message as it arrives. The
      // translator is a state machine: it carries usage forward across
      // messages and emits exactly one close-out, so nothing here needs the
      // whole stream in hand. Buffering used to defeat the point of
      // `stream: true` — the client saw one burst after the full generation.
      let emitted = 0;
      try {
        // translateStream owns the terminal chunk, so it cannot be skipped.
        for await (const chunk of translateStream(upstream(validated, signal), state)) {
          write(sseEncode(chunk));
          markChunk();
          emitted += 1;
          if (emitted === 1) {
            debug(id, `first chunk out after ${Date.now() - startedAt}ms`);
          }
        }
      } catch (err) {
        if (isClientDisconnect(err, signal)) {
          // Nobody is listening; terminate the stream and move on. One line,
          // no stack: this is expected traffic.
          console.log(`[${id}] client disconnected after ${emitted} chunks`);
          clearInterval(heartbeat);
          try {
            write(sseDone());
          } catch {
            // controller already closed — the usual case here
          }
          close();
          return;
        }
        debug(
          id,
          `stream error after ${heartbeatCount} heartbeats, ${emitted} chunks, signal.aborted=${signal?.aborted}, signal.reason=${JSON.stringify(signal?.reason)}:`,
          err
        );
        console.error(`[${id}] stream error:`, err instanceof Error ? err.message : err);
        // Surface the error as a normal data frame: the OpenAI SDKs only
        // parse `data:`, so a bare `event: error` is invisible to them.
        const errPayload: OpenAIError = {
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: "server_error",
            param: null,
            code: null,
          },
        };
        try {
          write(sseEncode(errPayload));
          // Always terminate the stream. Without [DONE] a waiting client
          // hangs until its own timeout rather than surfacing the error.
          write(sseDone());
          markChunk();
        } catch {
          // controller may already be closed if the client disconnected
        }
        clearInterval(heartbeat);
        close();
        return;
      }
      clearInterval(heartbeat);

      // Upstream ended without signalling end-of-generation, so whatever the
      // client received is a partial answer. Surface it as an error rather
      // than letting a truncated response look complete.
      if (streamWasTruncated(state)) {
        debug(id, `upstream truncated after ${emitted} chunks`);
        console.error(`[${id}] upstream ended without message_stop or result`);
        const truncPayload: OpenAIError = {
          error: {
            message: "upstream ended before completing the response",
            type: "server_error",
            param: null,
            code: "incomplete_response",
          },
        };
        try {
          write(sseEncode(truncPayload));
          markChunk();
        } catch {
          // controller may already be closed if the client disconnected
        }
      }

      write(sseDone());
      markChunk();
      debug(
        id,
        `stream done: ${emitted} chunks in ${Date.now() - startedAt}ms, ${heartbeatCount} heartbeats`
      );
      close();
    },
  });

  const responseHeaders = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };
  if (debugEnabled) debug(id, `responding 200 with SSE headers: ${JSON.stringify(responseHeaders)}`);
  return new Response(stream, {
    status: 200,
    headers: responseHeaders,
  });
}

// ---- Server ----

if (import.meta.main) {
const port = Number(process.env.PORT ?? 8787);

// Load tokens at startup. Fails closed — proxy refuses to run without auth.
const tokens = loadAuthTokens();

// Start the model-list refresher before binding the port. The first fetch is
// awaited inside, so by the time the server is reachable we have either a
// fresh live list or the hardcoded fallback (logged either way).
await startModelListRefresh();

const server = Bun.serve({
  port,
  // Deliberately well above MAX_REQUEST_BODY_BYTES. Bun enforces this by
  // resetting the connection, which the caller sees as an opaque socket error
  // (undici reports UND_ERR_SOCKET "other side closed") and which never
  // reaches our handler, so nothing gets logged. handleChat does the real
  // check and returns a 413 the client can read. This is only a backstop
  // against a body too large to buffer at all.
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES * 10,
  async fetch(req) {
    const reqStart = Date.now();
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      // /healthz stays open — meant for orchestrator probes.
      return healthResponse();
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const authErr = verifyRequest(req, tokens);
      if (authErr) {
        logRequest(nextRequestId(), req, 401, reqStart, "auth rejected");
        return authErr;
      }
      const res = await handleModels();
      logRequest(nextRequestId(), req, res.status, reqStart);
      return res;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const authErr = verifyRequest(req, tokens);
      if (authErr) {
        logRequest(nextRequestId(), req, 401, reqStart, "auth rejected");
        return authErr;
      }
      return handleChat(req);
    }
    logRequest(nextRequestId(), req, 404, reqStart);
    return jsonError(`not found: ${req.method} ${url.pathname}`, "not_found_error", 404);
  },
  error(err) {
    console.error("[server] unhandled:", err);
    return jsonError("internal server error", "server_error", 500);
  },
});

console.log(`puku-proxy listening on http://localhost:${server.port}`);
console.log(`  GET  /healthz                  (open)`);
console.log(`  GET  /v1/models                (auth required)`);
console.log(`  POST /v1/chat/completions      (auth required)`);
console.log(`  auth: ${tokens.size} token(s) loaded from PUKU_PROXY_AUTH_KEYS`);
console.log(`  debug: ${debugEnabled ? "on (PUKU_PROXY_DEBUG set)" : "off"}`);
}
