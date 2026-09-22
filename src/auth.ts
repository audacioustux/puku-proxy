/**
 * Bearer-token auth gate for the proxy.
 *
 * The proxy is an OpenAI-shaped API and accepts `Authorization: Bearer <token>`
 * on every protected route. Tokens are loaded from a single env var at startup
 * (`PUKU_PROXY_AUTH_KEYS` — comma-separated, single or multiple tokens for
 * rotation). If the env var is missing, startup fails closed.
 *
 * Tokens are NEVER logged and are scrubbed from any error surface.
 */

import type { OpenAIError } from "./openai.ts";

/**
 * Load the configured token(s) from the environment. Returns a Set for O(1)
 * lookup. Throws if no tokens are configured — the proxy refuses to start
 * without auth.
 */
export function loadAuthTokens(): Set<string> {
  const raw = process.env["PUKU_PROXY_AUTH_KEYS"];
  if (!raw || raw.trim() === "") {
    throw new Error(
      "PUKU_PROXY_AUTH_KEYS is not set. The proxy refuses to start without auth. " +
        "Set it to a comma-separated list of bearer tokens, e.g. PUKU_PROXY_AUTH_KEYS=pk_live_abc..."
    );
  }
  const tokens = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new Error("PUKU_PROXY_AUTH_KEYS is set but contains no non-empty tokens.");
  }
  return new Set(tokens);
}

function unauthorized(message: string): Response {
  const body: OpenAIError = {
    error: {
      message,
      type: "invalid_request_error",
      param: null,
      code: "invalid_api_key",
    },
  };
  return Response.json(body, {
    status: 401,
    headers: {
      "content-type": "application/json",
      // OpenAI returns this header on auth failures. Some clients check it.
      "www-authenticate": 'Bearer error="invalid_api_key"',
    },
  });
}

/**
 * Verify the incoming request against the configured token set. Returns null
 * on success (caller proceeds), or a 401 Response on failure.
 *
 * Accepts the token from either:
 *   - `Authorization: Bearer <token>` (standard)
 *   - `Authorization: <token>` (some clients omit the scheme)
 *
 * Comparison is constant-time to avoid timing leaks.
 */
export function verifyRequest(req: Request, tokens: Set<string>): Response | null {
  const header = req.headers.get("authorization");
  if (!header) {
    return unauthorized("Missing Authorization header. Send `Authorization: Bearer <token>`.");
  }

  let presented: string;
  const trimmed = header.trim();
  if (trimmed.toLowerCase().startsWith("bearer ")) {
    presented = trimmed.slice(7).trim();
  } else {
    presented = trimmed;
  }

  if (!presented) {
    return unauthorized("Empty bearer token in Authorization header.");
  }

  // Constant-time comparison across all configured tokens.
  let matched = false;
  for (const token of tokens) {
    if (constantTimeEqual(presented, token)) {
      matched = true;
      // Don't break — keep iterating to keep timing uniform across all candidates.
    }
  }

  if (!matched) {
    return unauthorized("Invalid API key.");
  }

  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  // Pad to equal length so the loop always runs the same number of iterations
  // regardless of which position fails.
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    const ac = i < a.length ? a.charCodeAt(i) : 0;
    const bc = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ac ^ bc;
  }
  return diff === 0;
}
