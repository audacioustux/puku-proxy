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
 * Largest accepted request body. A long legitimate conversation is well under
 * this; beyond it the caller is either misusing the API or probing for a way
 * to burn upstream compute.
 */
const MAX_REQUEST_BODY_BYTES = 1_000_000;

// ---- Helpers ----

function jsonError(message: string, type: string, status: number): Response {
  const body: OpenAIError = { error: { message, type, param: null, code: null } };
  return Response.json(body, { status, headers: { "content-type": "application/json" } });
}

function jsonOk<T>(body: T, status = 200): Response {
  return Response.json(body, { status, headers: { "content-type": "application/json" } });
}

// ---- Route handlers ----

async function handleModels(): Promise<Response> {
  return jsonOk(getModelList());
}

async function handleChat(req: Request): Promise<Response> {
  const id = nextRequestId();
  if (debugEnabled) {
    debug(id, `entry method=${req.method} url=${new URL(req.url).pathname}`);
    debug(
      id,
      `req.signal.aborted=${req.signal?.aborted ?? "no-signal"} reason=${JSON.stringify(req.signal?.reason)}`
    );
  }

  // 1. Parse + validate.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError("request body must be valid JSON", "invalid_request_error", 400);
  }

  const unsupported = findUnsupportedFields(raw);
  if (unsupported.length > 0) {
    console.warn(`[${id}] ignoring unsupported fields: ${unsupported.join(", ")}`);
  }

  const parsed = ChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
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
    debug(id, `non-stream error (signal.aborted=${signal?.aborted}):`, err);
    console.error(`[${id}] non-stream error:`, err);
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
        debug(
          id,
          `stream error after ${heartbeatCount} heartbeats, ${emitted} chunks, signal.aborted=${signal?.aborted}, signal.reason=${JSON.stringify(signal?.reason)}:`,
          err
        );
        console.error(`[${id}] stream error:`, err);
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
  // Each chat request spawns a puku-cli subprocess, so an oversized prompt is
  // an expensive request. Cap the body well below anything a legitimate
  // conversation needs; Bun rejects larger payloads before we allocate them.
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      // /healthz stays open — meant for orchestrator probes.
      return healthResponse();
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const authErr = verifyRequest(req, tokens);
      if (authErr) return authErr;
      return handleModels();
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const authErr = verifyRequest(req, tokens);
      if (authErr) return authErr;
      return handleChat(req);
    }
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
