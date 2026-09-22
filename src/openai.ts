/**
 * OpenAI-compatible request/response types + zod validation.
 *
 * The proxy is a dumb pipe. Anything OpenAI-shape is forwarded to puku-cli;
 * puku-cli decides what it accepts and returns its own (real) error if the
 * shape is wrong. We only validate the three things we actually need to read
 * (`model`, `messages[]`, `stream`) — everything else is passthrough.
 *
 * `messages[].role` includes `"tool"` and `"function"` because real
 * OpenAI agent loops carry tool-result history. `messages[].content` accepts
 * a string or an array of content parts (OpenAI's vision/multi-part shape).
 * Whether puku-cli honors these is its problem, not ours.
 */

import { z } from "zod";

// A single content part inside a multi-part `content` array. We accept
// anything OpenAI accepts: text, image_url, etc. The proxy doesn't introspect
// parts — they're passed through verbatim.
export const ContentPartSchema = z
  .object({ type: z.string().optional() })
  .passthrough();

export const ChatMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool", "function"]),
    content: z.union([z.string(), z.array(ContentPartSchema)]),
    name: z.string().optional(),
    // Tool-call/message fields OpenAI agent loops carry. Forwarded to puku-cli
    // as-is; we don't translate them.
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.object({}).passthrough()).optional(),
  })
  .passthrough();

export const ChatRequestSchema = z
  .object({
    model: z.string().min(1).default("puku-default"),
    messages: z.array(ChatMessageSchema).min(1),
    stream: z.boolean().optional().default(false),
  })
  .passthrough();

// Fields we *know* puku-cli will ignore if present. Logged so we know when
// clients depend on something the proxy won't translate, but never rejected —
// if puku-cli eventually supports them they'll just start working.
export const UnsupportedFields = [
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "logprobs",
  "top_logprobs",
  "response_format",
  "seed",
  "stop",
  "logit_bias",
  "temperature",
  "top_p",
  "n",
  "max_tokens",
  "presence_penalty",
  "frequency_penalty",
  "user",
] as const;

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

// ---- Response types (kept structural; we hand-shape JSON in translate.ts) ----

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAIChoice {
  index: number;
  message?: { role: "assistant"; content: string };
  delta?: { role?: "assistant"; content?: string };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface OpenAICompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage: OpenAIUsage;
}

export interface OpenAIChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
}

export interface OpenAIError {
  error: {
    message: string;
    type: string;
    param?: string | null;
    code?: string | null;
  };
}

/**
 * Walk an unknown ChatRequest body and return the names of fields the proxy
 * recognizes but doesn't translate. Empty array = fine. We do NOT walk into
 * messages[] — per-message schema mismatches are puku-cli's job, not ours.
 */
export function findUnsupportedFields(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const obj = body as Record<string, unknown>;
  return UnsupportedFields.filter((f) => f in obj);
}
