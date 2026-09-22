/**
 * Liveness probe — does NOT spawn puku. Just confirms the process is alive and
 * that puku-cli is on $PATH. Readiness (when added later) would do a tiny
 * `query()` round-trip.
 */

import { which } from "bun";

export async function healthResponse(): Promise<Response> {
  const cliPath = await which("puku-cli");
  if (!cliPath) {
    return Response.json(
      {
        status: "degraded",
        error: "puku-cli not found on PATH",
      },
      { status: 503 }
    );
  }
  return Response.json({
    status: "ok",
    puku_cli: cliPath,
    bun: Bun.version,
  });
}
