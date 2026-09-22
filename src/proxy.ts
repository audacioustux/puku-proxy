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
 * puku agent will understand. We keep it simple — system goes first, then
 * user/assistant alternation. Empty assistant turns are skipped.
 */
export function messagesToPrompt(messages: ChatRequest["messages"]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const content = m.content.trim();
    if (!content) continue;
    switch (m.role) {
      case "system":
        lines.push(`<system>\n${content}\n</system>`);
        break;
      case "user":
        lines.push(`<user>\n${content}\n</user>`);
        break;
      case "assistant":
        lines.push(`<assistant>\n${content}\n</assistant>`);
        break;
    }
  }
  if (lines.length === 0) {
    // Shouldn't happen because the schema requires min(1) messages, but guard anyway.
    return "(empty conversation)";
  }
  return lines.join("\n\n");
}

/**
 * Re-export the SDK's user-message type so callers can build `prompt` iterables
 * if they want streaming input later. Not used in v1 (we always send a string).
 */
export type { QueryUserMessage };
