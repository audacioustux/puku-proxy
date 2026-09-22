/**
 * Orchestrate a single puku-agent-sdk `query()` call for one OpenAI request.
 *
 * The SDK does not model multi-turn chat history the way OpenAI does, so we
 * collapse the messages array into a single user prompt. For v1, the agent
 * is single-turn (maxTurns: 1) — no tool loops, no MCP servers, no plugins.
 */

import { query } from "puku-agent-sdk";
import type { Options, QueryUserMessage } from "puku-agent-sdk";
import type { ChatRequest } from "./openai.ts";

/**
 * Yield raw puku NDJSON messages. Caller (server.ts / translate.ts) maps
 * each one into an OpenAI-shaped chunk or completion.
 */
export async function* proxyChatCompletion(
  req: ChatRequest,
  signal: AbortSignal | undefined
): AsyncIterable<unknown> {
  const prompt = messagesToPrompt(req.messages);
  const opts: Options = {
    model: req.model,
    maxTurns: 1,
    // Only request partial messages when streaming. Non-streaming still emits
    // an `assistant` message which we can collapse into one response.
    includePartialMessages: req.stream,
    ...(signal ? { signal } : {}),
  };

  yield* query({ prompt, options: opts });
}

/**
 * Render an OpenAI-style messages array as a single prompt string that the
 * puku agent will understand. System / user / assistant / tool / function are
 * all included. Multi-part content (OpenAI's array shape for vision, audio,
 * etc.) is collapsed to a single string by concatenating text parts and
 * dropping non-text parts (with a note so the model sees what was there).
 *
 * Tool-result history is preserved by re-emitting tool messages verbatim —
 * the puku agent sees the prior tool-call output as part of the conversation
 * even though it can't act on it (maxTurns: 1).
 */
export function messagesToPrompt(messages: ChatRequest["messages"]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const text = contentToText(m.content).trim();
    const role = m.role;
    const tag = role; // system/user/assistant/tool/function
    if (text) {
      lines.push(`<${tag}>\n${text}\n</${tag}>`);
    } else if (role === "tool" || role === "function") {
      // Tool/function message with no extractable text (e.g. an image-only
      // tool result). Still emit a marker so the model knows something was
      // there.
      lines.push(`<${tag}>\n[non-text content]\n</${tag}>`);
    }
  }
  if (lines.length === 0) {
    // Shouldn't happen because the schema requires min(1) messages, but guard anyway.
    return "(empty conversation)";
  }
  return lines.join("\n\n");
}

/**
 * Extract plain text from an OpenAI message content. Accepts:
 *   - a string (returned as-is)
 *   - an array of content parts (text parts concatenated, others summarized)
 *
 * Non-text parts (image_url, audio, file, etc.) become `[image]`, `[audio]`,
 * etc. so the model at least knows content was present. The full image data
 * is dropped — puku-cli's upstream doesn't accept image content parts.
 */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as { type?: unknown; text?: unknown };
    if (p.type === "text" && typeof p.text === "string") {
      parts.push(p.text);
      continue;
    }
    if (typeof p.type === "string") {
      parts.push(`[${p.type}]`);
    }
  }
  return parts.join("\n");
}

/**
 * Re-export the SDK's user-message type so callers can build `prompt` iterables
 * if they want streaming input later. Not used in v1 (we always send a string).
 */
export type { QueryUserMessage };
