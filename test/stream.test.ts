/**
 * Regression tests for SSE emission timing and termination.
 *
 * These drive the real `streamChat` from `server.ts` with an injected fake
 * upstream, and read the Response body off the wire. That matters: a test that
 * re-implemented the emission loop would pass even if `streamChat` still
 * buffered the whole generation, which is exactly the bug being guarded.
 *
 * The buffering bug was invisible to status-code smoke checks — the response
 * was a valid 200 with well-formed SSE, just delivered in one burst after the
 * generation finished.
 *
 * Real delays are used deliberately: the property under test is that bytes
 * reach the client before the upstream has finished producing them, which is a
 * statement about actual interleaving. Fake timers cannot express it, because
 * the buffered implementation would satisfy an advance-the-clock assertion
 * just as well. Gaps are kept small (30-60ms) to stay cheap.
 */

import { describe, expect, test } from "bun:test";
import { streamChat } from "../src/server.ts";
import type { ChatRequest } from "../src/openai.ts";

const request: ChatRequest = {
 model: "puku-ai-2.8",
 messages: [{ role: "user", content: "hi" }],
 stream: true,
};

const startMsg = {
 type: "stream_event",
 event: { type: "message_start", message: { id: "msg_1" } },
};
const stopMsg = { type: "stream_event", event: { type: "message_stop" } };
const deltaMsg = (text: string) => ({
 type: "stream_event",
 event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const resultMsg = (output: number) => ({
 type: "result",
 subtype: "success",
 usage: { input_tokens: 10, output_tokens: output },
});

/** Upstream that produces each delta `gapMs` apart, like a real generation. */
function paced(deltas: string[], gapMs: number) {
 return async function* (): AsyncIterable<unknown> {
  yield startMsg;
  for (const text of deltas) {
   await Bun.sleep(gapMs);
   yield deltaMsg(text);
  }
  yield stopMsg;
  yield resultMsg(deltas.length);
 };
}

/** Upstream that fails mid-generation, as a transport abort does. */
async function* failing(): AsyncIterable<unknown> {
 yield startMsg;
 yield deltaMsg("partial");
 throw new Error("Transport aborted");
}

/**
 * Read an SSE body frame by frame, recording when each arrived. Returns only
 * once the stream closes.
 */
async function readFrames(res: Response) {
 const startedAt = Date.now();
 const frames: { at: number; body: string }[] = [];
 const reader = res.body!.getReader();
 const decoder = new TextDecoder();
 let buffered = "";
 for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffered += decoder.decode(value, { stream: true });
  // SSE frames are separated by a blank line.
  let idx: number;
  while ((idx = buffered.indexOf("\n\n")) !== -1) {
   frames.push({
    at: Date.now() - startedAt,
    body: buffered.slice(0, idx + 2),
   });
   buffered = buffered.slice(idx + 2);
  }
 }
 return frames;
}

const dataFrames = (frames: { body: string }[]) =>
 frames.filter((f) => f.body.startsWith("data: "));
const contentFrames = (frames: { at: number; body: string }[]) =>
 frames.filter((f) => f.body.includes('"content"'));

describe("incremental delivery", () => {
 test("content chunks arrive spread across the generation, not batched at the end", async () => {
  // 5 deltas at 40ms => the generation spans ~200ms. A buffering
  // implementation emits every frame at the end, collapsing all arrival
  // times together.
  const res = streamChat(
   request,
   undefined,
   "t1",
   paced(["a", "b", "c", "d", "e"], 40),
  );
  const frames = await readFrames(res);
  const content = contentFrames(frames);
  expect(content).toHaveLength(5);

  const span = content[content.length - 1]!.at - content[0]!.at;
  expect(span).toBeGreaterThan(100);
 });

 test("each content chunk arrives strictly after the previous one", async () => {
  const res = streamChat(request, undefined, "t2", paced(["x", "y", "z"], 50));
  const content = contentFrames(await readFrames(res));
  expect(content).toHaveLength(3);
  for (let i = 1; i < content.length; i++) {
   expect(content[i]!.at).toBeGreaterThan(content[i - 1]!.at);
  }
 });

 test("the first chunk reaches the client before the generation finishes", async () => {
  const res = streamChat(
   request,
   undefined,
   "t3",
   paced(["a", "b", "c", "d"], 50),
  );
  const frames = await readFrames(res);
  const first = frames[0]!.at;
  const last = frames[frames.length - 1]!.at;
  // Buffering makes first ≈ last. Incremental emission puts the role chunk
  // out almost immediately, well before the ~200ms generation completes.
  expect(first).toBeLessThan(last / 2);
 });
});

describe("client disconnect", () => {
 // When the client hangs up, Bun aborts req.signal and the SDK throws
 // AbortError("Transport aborted"). That is normal traffic, not a server
 // fault: nobody is left to receive an error frame, and logging it as a
 // failure floods production logs — observed as ~90 lines per disconnect,
 // twice, including the whole DOMException constant table.
 function abortedUpstream(signal: AbortSignal | undefined) {
  return async function* (): AsyncIterable<unknown> {
   yield startMsg;
   yield deltaMsg("partial");
   const err = new Error("Transport aborted");
   err.name = "AbortError";
   void signal;
   throw err;
  };
 }

 test("an aborted stream is classified as a disconnect, not a server error", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("connection was closed.", "AbortError"));
  const frames = await readFrames(
   streamChat(request, controller.signal, "d1", abortedUpstream(controller.signal)),
  );
  // No error frame: the client is gone, so there is nobody to inform.
  expect(frames.some((f) => f.body.includes('"server_error"'))).toBe(false);
 });

 test("an aborted stream still closes cleanly", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("connection was closed.", "AbortError"));
  const frames = await readFrames(
   streamChat(request, controller.signal, "d2", abortedUpstream(controller.signal)),
  );
  // Terminating is still correct — it releases the ReadableStream.
  expect(frames[frames.length - 1]?.body).toBe("data: [DONE]\n\n");
 });

 test("an upstream failure with no client abort is still a server error", async () => {
  // The discriminator: same throw, but signal not aborted => genuine fault,
  // and the client must be told.
  const frames = await readFrames(
   streamChat(request, undefined, "d3", () => failing()),
  );
  expect(frames.some((f) => f.body.includes('"server_error"'))).toBe(true);
 });
});

describe("truncated upstream", () => {
 // puku-cli can die mid-generation and still exit 0 (or be SIGKILLed, e.g.
 // OOM), in which case the SDK yields no error and the iterable simply ends
 // with no message_stop and no result. Reporting that as finish_reason
 // "stop" tells the client a cut-off answer completed normally, which is
 // worse than an error: the caller acts on a truncated response.
 async function* truncated(): AsyncIterable<unknown> {
  yield startMsg;
  yield deltaMsg("The answer is");
 }

 test("a silently truncated stream is not reported as a normal completion", async () => {
  const frames = await readFrames(
   streamChat(request, undefined, "x1", () => truncated()),
  );
  const terminal = JSON.parse(frames[frames.length - 2]!.body.slice(6));
  expect(terminal.choices?.[0]?.finish_reason).not.toBe("stop");
 });

 test("a silently truncated stream surfaces an error to the client", async () => {
  const frames = await readFrames(
   streamChat(request, undefined, "x2", () => truncated()),
  );
  expect(frames.some((f) => f.body.includes('"error"'))).toBe(true);
 });

 test("a truncated stream still terminates with [DONE]", async () => {
  const frames = await readFrames(
   streamChat(request, undefined, "x3", () => truncated()),
  );
  expect(frames[frames.length - 1]!.body).toBe("data: [DONE]\n\n");
 });

 test("content emitted before truncation is preserved", async () => {
  const frames = await readFrames(
   streamChat(request, undefined, "x4", () => truncated()),
  );
  expect(frames.some((f) => f.body.includes("The answer is"))).toBe(true);
 });
});

describe("stream termination", () => {
 test("a successful stream ends with [DONE]", async () => {
  const frames = await readFrames(
   streamChat(request, undefined, "t4", paced(["a"], 1)),
  );
  expect(frames[frames.length - 1]!.body).toBe("data: [DONE]\n\n");
 });

 test("a failed stream still ends with [DONE]", async () => {
  // Without the sentinel a client waiting for it hangs until its own
  // timeout instead of surfacing the error.
  const frames = await readFrames(
   streamChat(request, undefined, "t5", () => failing()),
  );
  expect(frames[frames.length - 1]!.body).toBe("data: [DONE]\n\n");
 });

 test("the error is delivered as a data: frame, not a bare event:", async () => {
  // The OpenAI SDKs only parse `data:`; `event: error` alone is invisible.
  const frames = await readFrames(
   streamChat(request, undefined, "t6", () => failing()),
  );
  const errorFrame = frames.find((f) => f.body.includes('"error"'));
  expect(errorFrame?.body.startsWith("data: ")).toBe(true);
  expect(errorFrame?.body).toContain("Transport aborted");
  expect(frames.every((f) => !f.body.startsWith("event:"))).toBe(true);
 });

 test("chunks emitted before a failure are preserved", async () => {
  const frames = await readFrames(
   streamChat(request, undefined, "t7", () => failing()),
  );
  expect(frames.some((f) => f.body.includes("partial"))).toBe(true);
 });

 test("exactly one chunk carries a finish_reason", async () => {
  const frames = await readFrames(
   streamChat(request, undefined, "t8", paced(["a", "b"], 1)),
  );
  const closing = dataFrames(frames).filter((f) => {
   if (f.body.includes("[DONE]")) return false;
   return JSON.parse(f.body.slice(6)).choices[0].finish_reason != null;
  });
  expect(closing).toHaveLength(1);
 });
});

describe("usage reporting across upstream orderings", () => {
 // `result` carries the authoritative token counts and may arrive either
 // side of message_stop. A client's billing must not depend on which.
 const bothOrderings: [string, () => AsyncIterable<unknown>][] = [
  [
   "result after message_stop",
   async function* () {
    yield startMsg;
    yield deltaMsg("hi");
    yield stopMsg;
    yield resultMsg(2);
   },
  ],
  [
   "result before message_stop",
   async function* () {
    yield startMsg;
    yield deltaMsg("hi");
    yield resultMsg(2);
    yield stopMsg;
   },
  ],
 ];

 for (const [label, upstream] of bothOrderings) {
  test(`usage rides the final pre-[DONE] frame: ${label}`, async () => {
   const frames = await readFrames(
    streamChat(request, undefined, "u1", () => upstream()),
   );
   expect(frames[frames.length - 1]!.body).toBe("data: [DONE]\n\n");
   const terminal = JSON.parse(frames[frames.length - 2]!.body.slice(6));
   expect(terminal.usage).toEqual({
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
   });
   expect(terminal.choices[0].finish_reason).toBe("stop");
  });
 }

 test("still terminates cleanly when upstream sends no result at all", async () => {
  const frames = await readFrames(
   streamChat(request, undefined, "u2", async function* () {
    yield startMsg;
    yield deltaMsg("hi");
    yield stopMsg;
   }),
  );
  expect(frames[frames.length - 1]!.body).toBe("data: [DONE]\n\n");
  const terminal = JSON.parse(frames[frames.length - 2]!.body.slice(6));
  expect(terminal.choices[0].finish_reason).toBe("stop");
 });

 test("exactly one frame carries a finish_reason in either ordering", async () => {
  for (const [, upstream] of bothOrderings) {
   const frames = await readFrames(
    streamChat(request, undefined, "u3", () => upstream()),
   );
   const closing = dataFrames(frames).filter((f) => {
    if (f.body.includes("[DONE]")) return false;
    return JSON.parse(f.body.slice(6)).choices[0].finish_reason != null;
   });
   expect(closing).toHaveLength(1);
  }
 });
});

describe("wire format", () => {
 test("every frame is a well-formed SSE data event", async () => {
  const frames = await readFrames(
   streamChat(request, undefined, "t9", paced(["a", "b"], 1)),
  );
  for (const f of frames) {
   expect(f.body.startsWith("data: ")).toBe(true);
   expect(f.body.endsWith("\n\n")).toBe(true);
  }
 });

 test("the response advertises SSE headers", () => {
  const res = streamChat(request, undefined, "t10", paced(["a"], 1));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(res.headers.get("cache-control")).toBe("no-cache");
 });

 test("the requested model is echoed on every chunk", async () => {
  const frames = await readFrames(
   streamChat(request, undefined, "t11", paced(["a", "b"], 1)),
  );
  for (const f of dataFrames(frames)) {
   if (f.body.includes("[DONE]")) continue;
   expect(JSON.parse(f.body.slice(6)).model).toBe("puku-ai-2.8");
  }
 });
});
