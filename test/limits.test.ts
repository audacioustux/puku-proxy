/**
 * Regression tests for request-size rejection.
 *
 * An oversized body must produce a readable 413, not a dropped connection.
 * Bun's own `maxRequestBodySize` enforces the cap by resetting the socket,
 * which reaches the caller as an opaque transport failure — undici reports
 * `UND_ERR_SOCKET: other side closed`, surfaced by an upstream gateway as a
 * 502 with no server-side trace. Observed in production against omniroute.
 */

import { describe, expect, test } from "bun:test";
import { handleChat } from "../src/server.ts";

function chatRequest(contentBytes: number): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "puku-ai-2.8",
      messages: [{ role: "user", content: "A".repeat(contentBytes) }],
    }),
  });
}

describe("request size limit", () => {
  test("an oversized body is rejected with 413, not a dropped connection", async () => {
    const res = await handleChat(chatRequest(8_000_000));
    expect(res.status).toBe(413);
  });

  test("the 413 explains the limit and how to raise it", async () => {
    const res = await handleChat(chatRequest(8_000_000));
    const body = (await res.json()) as { error?: { message?: string; type?: string } };
    // The caller needs to know what happened, by how much it overshot, and
    // that the limit is tunable rather than absolute.
    expect(body.error?.message).toContain("8.0MB");
    expect(body.error?.message).toContain("5.0MB limit");
    expect(body.error?.message).toContain("PUKU_PROXY_MAX_BODY_BYTES");
    expect(body.error?.type).toBe("invalid_request_error");
  });

  test("a body under the limit is not rejected for size", async () => {
    // Reaches validation/upstream instead; it must not be a 413.
    const res = await handleChat(chatRequest(1_000));
    expect(res.status).not.toBe(413);
  });

  test("a large but realistic agent conversation passes the size gate", async () => {
    // Production carries 170+ message histories with tool-call payloads. 2MB
    // used to be rejected outright, and before that killed the socket.
    //
    // Deliberately malformed past the size check (empty messages[]) so this
    // stays hermetic: a 400 proves the body was accepted and reached schema
    // validation, without spawning a puku-cli subprocess.
    const big = "A".repeat(2_000_000);
    const res = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: big, messages: [] }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("malformed input", () => {
  test("invalid JSON yields 400, not a crash", async () => {
    const res = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("a schema-invalid body yields 400", async () => {
    const res = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [] }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
