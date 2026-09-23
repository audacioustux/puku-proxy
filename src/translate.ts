/**
 * Translate puku-agent-sdk NDJSON messages into OpenAI-compatible chunks or
 * a single OpenAI completion response.
 *
 * Shapes verified against `puku-agent-sdk@3.1.4` by capturing a real `query()`
 * run (see commit history). The d.ts types are loose (`event: unknown`,
 * `content: unknown[]`, `usage: Record<string, number>`), so we narrow with
 * structural checks here.
 */

import type {
  OpenAIChunk,
  OpenAIChoice,
  OpenAICompletion,
  OpenAIError,
  OpenAIUsage,
} from "./openai.ts";

// ---- Puku message narrowing ----

interface PukuTextBlock {
  type: "text";
  text: string;
}

interface PukuStreamEvent {
  type: string;
  // For message_start:
  message?: { id?: string; model?: string };
  // For content_block_delta:
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
    usage?: Record<string, number>;
  };
}

interface PukuAssistantMessage {
  type: "assistant";
  message: {
    id?: string;
    role: "assistant";
    content: unknown[];
    model?: string;
    stop_reason?: string | null;
    usage?: Record<string, number>;
  };
}

interface PukuResultMessage {
  type: "result";
  subtype: string;
  is_error?: boolean;
  usage?: Record<string, number>;
  num_turns?: number;
  result?: unknown;
}

interface PukuStreamEventMessage {
  type: "stream_event";
  event: PukuStreamEvent;
}

type PukuMessage =
  | { type: "system" }
  | { type: "user" }
  | PukuAssistantMessage
  | PukuStreamEventMessage
  | PukuResultMessage
  | { type: string };

function isAssistantMessage(msg: PukuMessage): msg is PukuAssistantMessage {
  return msg.type === "assistant";
}

function isStreamEventMessage(msg: PukuMessage): msg is PukuStreamEventMessage {
  return msg.type === "stream_event";
}

function isResultMessage(msg: PukuMessage): msg is PukuResultMessage {
  return msg.type === "result";
}

// ---- State for streaming ----

export interface StreamingState {
  id: string;
  model: string;
  created: number;
  /** Set to true once we've emitted the role-only chunk. */
  emittedRole: boolean;
  /** Set once we've emitted the final close-out chunk + [DONE]. */
  closed: boolean;
  /** Accumulated usage from message_delta + result. */
  usage?: OpenAIUsage;
  /** Finish reason captured from message_delta. */
  finishReason: "stop" | "length" | "tool_calls" | null;
}

export function newStreamingState(model: string): StreamingState {
  return {
    id: "chatcmpl-" + cryptoRandomSuffix(),
    model,
    created: Math.floor(Date.now() / 1000),
    emittedRole: false,
    closed: false,
    finishReason: null,
  };
}

function cryptoRandomSuffix(): string {
  // 24-char base36 — same shape as OpenAI's chatcmpl ids
  return Array.from(crypto.getRandomValues(new Uint8Array(15)))
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 24);
}

function baseChunk(state: StreamingState, choices: OpenAIChoice[]): OpenAIChunk {
  return {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices,
  };
}

function mapStopReason(reason: string | null | undefined): "stop" | "length" | "tool_calls" {
  switch (reason) {
    case "end_turn":
    case null:
    case undefined:
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

/**
 * Fold an upstream usage record into whatever we already know. Upstream
 * reports usage across several messages (message_delta, result) and each may
 * carry only part of the picture, so a later partial report must not erase an
 * earlier complete one. Non-positive fields are treated as "not reported".
 */
function mergeUsage(
  prev: OpenAIUsage | undefined,
  raw: Record<string, number>
): OpenAIUsage | undefined {
  const next = usageFromRecord(raw);
  if (!next) return prev;
  if (!prev) return next;
  const prompt_tokens = next.prompt_tokens > 0 ? next.prompt_tokens : prev.prompt_tokens;
  const completion_tokens =
    next.completion_tokens > 0 ? next.completion_tokens : prev.completion_tokens;
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

export function usageFromRecord(usage: Record<string, number> | undefined): OpenAIUsage | undefined {
  if (!usage) return undefined;
  const input = usage["input_tokens"] ?? 0;
  const output = usage["output_tokens"] ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
  };
}

/**
 * Translate a single puku NDJSON message into zero-or-one OpenAI chunks.
 * Caller is responsible for serializing to SSE wire format.
 */
export function ndjsonToChunk(msg: unknown, state: StreamingState): OpenAIChunk | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as PukuMessage;

  // system / user echoes / control requests / unknown — never forward.
  if (m.type === "system" || m.type === "user" || m.type === "control_request") {
    return null;
  }

  if (isStreamEventMessage(m)) {
    const ev = m.event;

    if (ev.type === "message_start") {
      // First chunk: role-only.
      state.emittedRole = true;
      if (ev.message?.id) state.id = "chatcmpl-" + (ev.message.id.slice(0, 24));
      // Deliberately NOT adopting ev.message.model: OpenAI clients pin and
      // assert on `model`, so it must stay the id the caller requested.
      // Adopting the upstream name also leaks which vendor model served it.
      return baseChunk(state, [
        { index: 0, delta: { role: "assistant" }, finish_reason: null },
      ]);
    }

    if (ev.type === "content_block_delta") {
      const d = ev.delta;
      if (d?.type === "text_delta" && typeof d.text === "string") {
        return baseChunk(state, [
          {
            index: typeof ev.index === "number" ? ev.index : 0,
            delta: { content: d.text },
            finish_reason: null,
          },
        ]);
      }
      // input_json_delta / thinking_delta / signature_delta: not text, skip.
      return null;
    }

    if (ev.type === "message_delta") {
      // Capture usage + stop_reason; final close-out emitted on message_stop.
      if (typeof ev.delta?.stop_reason !== "undefined") {
        state.finishReason = mapStopReason(ev.delta.stop_reason);
      }
      if (ev.delta?.usage) {
        // Merge, never replace. Anthropic-shaped message_delta.usage carries
        // only output_tokens; a wholesale assignment would default
        // input_tokens to 0 and silently under-report prompt_tokens.
        state.usage = mergeUsage(state.usage, ev.delta.usage);
      }
      return null;
    }

    if (ev.type === "message_stop") {
      // A `result` message arriving first already closed the stream; emitting
      // again would send two finish_reason chunks, which strict clients reject.
      if (state.closed) return null;
      const close = baseChunk(state, [
        { index: 0, delta: {}, finish_reason: state.finishReason ?? "stop" },
      ]);
      if (state.usage) close.usage = state.usage;
      state.closed = true;
      return close;
    }

    // content_block_start / content_block_stop / ping / unknown — skip.
    return null;
  }

  if (isAssistantMessage(m)) {
    // In streaming mode the SDK interleaves a full-text `assistant` snapshot
    // between `content_block_delta` and `content_block_stop` — it's a
    // transcript artifact, not new content. `message_stop` (handled above)
    // emits the close-out chunk with `finish_reason`, which is what clients
    // expect. Drop `assistant` whenever we've already emitted at least one
    // text delta OR we've entered the close-out sequence.
    //
    // The fallback path (includePartialMessages=false) hits this branch and
    // does emit one chunk carrying the full text + role. That's the only
    // case where we should act on it.
    if (state.emittedRole || state.closed) return null;
    const text = extractText(m.message.content);
    state.emittedRole = true;
    state.closed = true;
    const chunk = baseChunk(state, [
      {
        index: 0,
        delta: { role: "assistant", content: text },
        finish_reason: mapStopReason(m.message.stop_reason),
      },
    ]);
    if (state.usage) chunk.usage = state.usage;
    return chunk;
  }

  if (isResultMessage(m)) {
    // `result` carries the authoritative token counts, and it can arrive
    // either side of message_stop. Absorb its usage FIRST, unconditionally —
    // returning early on an already-closed stream would discard it and leave
    // the caller with whatever partial numbers a message_delta reported.
    if (m.usage) state.usage = mergeUsage(state.usage, m.usage);
    if (state.closed) return null;
    state.closed = true;
    const close = baseChunk(state, [
      { index: 0, delta: {}, finish_reason: state.finishReason ?? "stop" },
    ]);
    // Same contract as the message_stop close-out: the terminating chunk
    // carries usage. Omitting it here stranded the counts whenever `result`
    // was the message that closed the stream.
    if (state.usage) close.usage = state.usage;
    return close;
  }

  return null;
}

export function isStreamClosed(state: StreamingState): boolean {
  return state.closed;
}

// ---- Non-streaming translator ----

export function assistantToCompletion(
  msg: PukuAssistantMessage,
  model: string
): OpenAICompletion {
  const text = extractText(msg.message.content);
  const usage = usageFromRecord(msg.message.usage) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    id: "chatcmpl-" + (msg.message.id?.slice(0, 24) ?? cryptoRandomSuffix()),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: mapStopReason(msg.message.stop_reason),
      },
    ],
    usage,
  };
}

function extractText(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      (block as { type: unknown }).type === "text" &&
      "text" in block &&
      typeof (block as { text: unknown }).text === "string"
    ) {
      parts.push((block as PukuTextBlock).text);
    }
  }
  return parts.join("");
}

// ---- SSE wire helpers ----

export function sseEncode(chunk: OpenAIChunk | OpenAIError): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function sseDone(): string {
  return "data: [DONE]\n\n";
}
