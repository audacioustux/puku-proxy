/**
 * Regression tests for the NDJSON → OpenAI chunk translator.
 *
 * Each test targets a behaviour a consumer can observe, not an implementation
 * detail: exactly one close-out per stream, the model the caller asked for,
 * and usage that survives every upstream message ordering.
 */

import { describe, expect, test } from "bun:test";
import {
 assistantToCompletion,
 newStreamingState,
 translateStream,
} from "../src/translate.ts";

// ---- Upstream message builders (shapes verified against puku-agent-sdk@3.1.4) ----

const start = (model = "upstream-model", id = "msg_1") => ({
 type: "stream_event",
 event: { type: "message_start", message: { id, model } },
});
const textDelta = (text: string) => ({
 type: "stream_event",
 event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const messageDelta = (
 usage?: Record<string, number>,
 stop_reason?: string,
) => ({
 type: "stream_event",
 event: {
  type: "message_delta",
  delta: {
   ...(usage ? { usage } : {}),
   ...(stop_reason ? { stop_reason } : {}),
  },
 },
});
const messageStop = () => ({
 type: "stream_event",
 event: { type: "message_stop" },
});
const assistant = (text: string, id = "msg_1") => ({
 type: "assistant",
 message: { id, role: "assistant", content: [{ type: "text", text }] },
});
const result = (usage?: Record<string, number>) => ({
 type: "result",
 subtype: "success",
 ...(usage ? { usage } : {}),
});

/**
 * Drive a whole upstream sequence through the public streaming translator —
 * the same entry point `streamChat` uses, so the terminal chunk is included
 * and these tests cover the contract a client actually observes.
 */
async function drive(msgs: unknown[], model = "requested-model") {
 const state = newStreamingState(model);
 const upstream = (async function* () {
  for (const m of msgs) yield m;
 })();
 const chunks = [];
 for await (const c of translateStream(upstream, state)) chunks.push(c);
 return { chunks, state };
}

const closeOuts = (chunks: { choices: { finish_reason: unknown }[] }[]) =>
 chunks.filter((c) => c.choices[0]?.finish_reason != null);

// ---- Close-out uniqueness ----

describe("close-out uniqueness", () => {
 // A stream must terminate exactly once. Two finish_reason chunks is a
 // protocol violation that strict OpenAI clients reject.
 const orderings: [string, unknown[]][] = [
  ["message_stop then result", [
   start(),
   textDelta("hi"),
   messageStop(),
   result({ input_tokens: 5, output_tokens: 2 }),
  ]],
  ["result then message_stop", [
   start(),
   textDelta("hi"),
   result({ input_tokens: 5, output_tokens: 2 }),
   messageStop(),
  ]],
  ["assistant snapshot before stop", [
   start(),
   textDelta("hi"),
   assistant("hi"),
   messageStop(),
  ]],
  ["assistant snapshot after stop", [
   start(),
   textDelta("hi"),
   messageStop(),
   assistant("hi"),
  ]],
  ["result only (no message_stop)", [
   start(),
   textDelta("hi"),
   result({ input_tokens: 5, output_tokens: 2 }),
  ]],
  ["no message_start", [textDelta("hi"), messageStop()]],
 ];

 for (const [label, msgs] of orderings) {
  test(`emits exactly one close-out: ${label}`, async () => {
   const { chunks } = await drive(msgs);
   expect(closeOuts(chunks)).toHaveLength(1);
  });
 }

 test("the close-out is the final chunk", async () => {
  const { chunks } = await drive([
   start(),
   textDelta("hi"),
   result({ input_tokens: 1, output_tokens: 1 }),
   messageStop(),
  ]);
  const idx = chunks.findIndex((c) => c.choices[0]?.finish_reason != null);
  expect(idx).toBe(chunks.length - 1);
 });
});

// ---- Model echo ----

describe("model echo", () => {
 // OpenAI clients pin or assert on `model`. It must be what the caller asked
 // for, and it must not leak the upstream vendor's internal model name.
 test("streaming echoes the requested model, not the upstream one", async () => {
  const { chunks } = await drive([
   start("MiniMax-M3"),
   textDelta("hi"),
   messageStop(),
  ], "puku-ai-2.8");
  for (const c of chunks) expect(c.model).toBe("puku-ai-2.8");
 });

 test("non-streaming echoes the requested model", () => {
  const completion = assistantToCompletion(
   assistant("hi") as never,
   "puku-ai-2.8",
  );
  expect(completion.model).toBe("puku-ai-2.8");
 });

 test("streaming and non-streaming agree", async () => {
  const { chunks } = await drive([
   start("MiniMax-M3"),
   textDelta("hi"),
   messageStop(),
  ], "puku-ai-2.8");
  const completion = assistantToCompletion(
   assistant("hi") as never,
   "puku-ai-2.8",
  );
  expect(chunks[0]?.model).toBe(completion.model);
 });
});

// ---- Chunk id stability ----

describe("chunk id stability", () => {
 test("every chunk in a stream shares one id", async () => {
  const { chunks } = await drive([
   start(),
   textDelta("a"),
   textDelta("b"),
   messageStop(),
  ]);
  expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
 });
});

// ---- Usage reporting ----

describe("usage reporting", () => {
 // The close-out carries usage. Upstream may report it via message_delta,
 // via result, or both — a caller's token accounting must not depend on which.
 test("usage from result reaches the close-out", async () => {
  const { chunks } = await drive([
   start(),
   textDelta("hi"),
   result({ input_tokens: 100, output_tokens: 7 }),
   messageStop(),
  ]);
  const close = closeOuts(chunks)[0];
  expect(close?.usage).toEqual({
   prompt_tokens: 100,
   completion_tokens: 7,
   total_tokens: 107,
  });
 });

 test("prompt_tokens survives a message_delta that omits input_tokens", async () => {
  // Anthropic's message_delta.usage carries only output_tokens. If that
  // overwrites the result-sourced usage wholesale, prompt_tokens silently
  // becomes 0 and the caller under-counts its own spend.
  const { chunks } = await drive([
   start(),
   textDelta("hi"),
   messageDelta({ output_tokens: 7 }, "end_turn"),
   result({ input_tokens: 100, output_tokens: 7 }),
   messageStop(),
  ]);
  const close = closeOuts(chunks)[0];
  expect(close?.usage?.prompt_tokens).toBe(100);
 });

 test("a late message_delta cannot clobber result usage", async () => {
  // The discriminating ordering: `result` reports complete counts FIRST, then
  // a message_delta arrives carrying only output_tokens. A wholesale
  // assignment overwrites the complete record and zeroes prompt_tokens; a
  // merge keeps it. The reverse order masks the bug, because result re-merges
  // the full numbers afterwards.
  const { chunks } = await drive([
   start(),
   textDelta("hi"),
   result({ input_tokens: 100, output_tokens: 7 }),
   messageDelta({ output_tokens: 7 }, "end_turn"),
   messageStop(),
  ]);
  const close = closeOuts(chunks)[0];
  expect(close?.usage?.prompt_tokens).toBe(100);
 });
});

// ---- Content fidelity ----

describe("content fidelity", () => {
 test("text deltas are forwarded verbatim and in order", async () => {
  const { chunks } = await drive([
   start(),
   textDelta("Hello"),
   textDelta(", "),
   textDelta("world"),
   messageStop(),
  ]);
  const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
  expect(text).toBe("Hello, world");
 });

 test("the first chunk carries the assistant role", async () => {
  const { chunks } = await drive([start(), textDelta("hi"), messageStop()]);
  expect(chunks[0]?.choices[0]?.delta?.role).toBe("assistant");
 });

 test("non-text blocks (thinking, tool json) are not emitted as content", async () => {
  const thinking = {
   type: "stream_event",
   event: {
    type: "content_block_delta",
    delta: { type: "thinking_delta", thinking: "hmm" },
   },
  };
  const { chunks } = await drive([
   start(),
   thinking,
   textDelta("answer"),
   messageStop(),
  ]);
  const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
  expect(text).toBe("answer");
 });
});

// ---- finish_reason mapping ----

describe("finish_reason mapping", () => {
 const cases: [string, string][] = [
  ["end_turn", "stop"],
  ["max_tokens", "length"],
  ["tool_use", "tool_calls"],
 ];
 for (const [upstream, expected] of cases) {
  test(`${upstream} maps to ${expected}`, async () => {
   const { chunks } = await drive([
    start(),
    textDelta("hi"),
    messageDelta(undefined, upstream),
    messageStop(),
   ]);
   expect(closeOuts(chunks)[0]?.choices[0]?.finish_reason).toBe(expected);
  });
 }
});
