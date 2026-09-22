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
  type OpenAICompletion,
  type OpenAIError,
} from "./openai.ts";
import {
  assistantToCompletion,
  ndjsonToChunk,
  newStreamingState,
  sseDone,
  sseEncode,
  usageFromRecord,
} from "./translate.ts";
import { healthResponse } from "./health.ts";

// ---- Model list (hardcoded; SDK has no list-models API) ----

const MODEL_LIST = {
  object: "list",
  data: [
    { id: "puku-default", object: "model", created: 0, owned_by: "puku" },
    { id: "puku-fast", object: "model", created: 0, owned_by: "puku" },
    { id: "opus", object: "model", created: 0, owned_by: "puku" },
    { id: "sonnet", object: "model", created: 0, owned_by: "puku" },
  ],
};

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
  return jsonOk(MODEL_LIST);
}

async function handleChat(req: Request): Promise<Response> {
  // 1. Parse + validate.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError("request body must be valid JSON", "invalid_request_error", 400);
  }

  const unsupported = findUnsupportedFields(raw);
  if (unsupported.length > 0) {
    console.warn(`[chat] ignoring unsupported fields: ${unsupported.join(", ")}`);
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

  // 2. Dispatch.
  if (body.stream) {
    return streamChat(body, req.signal);
  }
  return await nonStreamChat(body, req.signal);
}

async function nonStreamChat(
  body: Parameters<typeof ChatRequestSchema.parse>[0],
  signal: AbortSignal | undefined
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
    console.error("[chat] non-stream error:", err);
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

function streamChat(
  body: Parameters<typeof ChatRequestSchema.parse>[0],
  signal: AbortSignal | undefined
): Response {
  const validated = ChatRequestSchema.parse(body);
  const state = newStreamingState(validated.model);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const write = (s: string) => controller.enqueue(encoder.encode(s));
      const close = () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // Collect every NDJSON message before emitting. We need the full stream
      // because (a) the `result` message carries usage and arrives after
      // `message_stop`, and (b) the `assistant` snapshot is interleaved with
      // stream events. Buffering lets us emit one clean OpenAI-shaped chunk
      // per logical event, with usage attached to the close-out.
      const messages: unknown[] = [];
      try {
        for await (const msg of proxyChatCompletion(validated, signal)) {
          messages.push(msg);
        }
      } catch (err) {
        console.error("[chat] stream error:", err);
        const errPayload: OpenAIError = {
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: "server_error",
            param: null,
            code: null,
          },
        };
        write(`event: error\ndata: ${JSON.stringify(errPayload)}\n\n`);
        close();
        return;
      }

      // First pass: pull usage from `result` so the close-out chunk can carry
      // it. We don't emit yet.
      for (const msg of messages) {
        if (typeof msg !== "object" || msg === null) continue;
        const m = msg as { type?: string; usage?: Record<string, number> };
        if (m.type === "result" && m.usage) {
          const u = usageFromRecord(m.usage);
          if (u) state.usage = u;
        }
      }

      // Second pass: emit chunks. The translator already drops the
      // interleaved `assistant` snapshot when state.emittedRole is true.
      for (const msg of messages) {
        const chunk = ndjsonToChunk(msg, state);
        if (chunk) write(sseEncode(chunk));
      }

      write(sseDone());
      close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

// ---- Server ----

const port = Number(process.env.PORT ?? 8787);

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return healthResponse();
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return handleModels();
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
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
console.log(`  GET  /healthz`);
console.log(`  GET  /v1/models`);
console.log(`  POST /v1/chat/completions`);
