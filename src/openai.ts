/**
 * OpenAI-compatible request/response types + zod validation.
 *
 * Only the fields we actually translate are validated strictly. Unknown fields
 * are accepted (passthrough) so existing OpenAI clients don't break, but we log
 * a warning for anything we don't honor.
 */

import { z } from "zod";

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
  name: z.string().optional(),
});

export const ChatRequestSchema = z.object({
  model: z.string().min(1).default("puku-default"),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional().default(false),
  // These are accepted but currently ignored. Listed here so we can warn on them.
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  n: z.number().int().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  user: z.string().optional(),
});

// Tools / functions / logprobs are out of scope for v1 — reject explicitly so
// clients get a clear error rather than silent data loss.
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
 * Walk an unknown ChatRequest body and return the names of fields that look
 * supported but aren't, plus outright unsupported fields. Empty array = fine.
 */
export function findUnsupportedFields(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const obj = body as Record<string, unknown>;
  const warn: string[] = [];
  const ignored: Array<keyof ChatRequest | "temperature" | "top_p" | "n" | "max_tokens" | "presence_penalty" | "frequency_penalty" | "user"> = [
    "temperature",
    "top_p",
    "n",
    "max_tokens",
    "presence_penalty",
    "frequency_penalty",
    "user",
  ];
  for (const field of ignored) {
    if (field in obj) warn.push(field);
  }
  for (const field of UnsupportedFields) {
    if (field in obj) warn.push(field);
  }
  return warn;
}
