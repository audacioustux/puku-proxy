/**
 * Debug logging for puku-proxy.
 *
 * Activated by `PUKU_PROXY_DEBUG=1` in the environment. Off by default — when
 * off this module's helpers are no-ops so the hot path has zero cost.
 *
 * Adds a per-request counter so logs from concurrent /v1/chat/completions
 * calls can be told apart in `docker logs` output.
 */

const ENABLED = (() => {
  const v = process.env.PUKU_PROXY_DEBUG?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
})();

let counter = 0;

/** Returns a fresh request id like "chat-7". Cheap, monotonic per process. */
export function nextRequestId(): string {
  counter += 1;
  return `chat-${counter}`;
}

/** No-op when debug is off. Otherwise logs with the prefix. */
export function debug(id: string, msg: string, ...rest: unknown[]): void {
  if (!ENABLED) return;
  if (rest.length === 0) {
    console.log(`[${id}] ${msg}`);
    return;
  }
  console.log(`[${id}] ${msg}`, ...rest);
}

/** Whether debug is on. Useful for conditional log-block construction. */
export const debugEnabled: boolean = ENABLED;
