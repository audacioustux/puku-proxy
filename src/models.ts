/**
 * Model list — fetched live from upstream at boot, refreshed every 5 minutes.
 *
 * The puku-agent-sdk has no list-models API, so the proxy used to ship a
 * hardcoded 4-item list and hope nobody noticed. That went stale the moment
 * upstream added a new model. Now we hit `https://api-cli.puku.sh/v1/models`
 * (the same public registry endpoint OpenAI-compat clients use to discover
 * models) and cache the result in memory.
 *
 * Failure modes — log a warning and keep serving the previous list (or the
 * hardcoded fallback on first boot). We never fail to serve /v1/models just
 * because upstream is unreachable.
 */

const UPSTREAM_MODELS_URL = "https://api-cli.puku.sh/v1/models";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 5_000;

// Hardcoded fallback — only used if the very first boot fetch fails. Matches
// the upstream alias set so calls to /v1/chat keep working even when upstream
// is down. Kept in sync with what puku-cli@1.8.56 understands.
const FALLBACK_LIST = {
  object: "list" as const,
  data: [
    { id: "puku-default", object: "model", created: 0, owned_by: "puku" },
    { id: "puku-fast", object: "model", created: 0, owned_by: "puku" },
    { id: "opus", object: "model", created: 0, owned_by: "puku" },
    { id: "sonnet", object: "model", created: 0, owned_by: "puku" },
  ],
};

// Loose model shape — accept whatever upstream sends in `data[].*` and pass it
// through. We don't want to drop fields an upstream registry decides to add
// (root, parent, permission, capabilities, etc.) on the floor.
type UpstreamModel = {
  id?: unknown;
  object?: unknown;
  [k: string]: unknown;
};

type ModelList = {
  object: "list";
  data: UpstreamModel[];
};

function isUpstreamModel(v: unknown): v is UpstreamModel {
  return typeof v === "object" && v !== null;
}

function parseList(raw: unknown): ModelList | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { object?: unknown; data?: unknown };
  if (r.object !== "list") return null;
  if (!Array.isArray(r.data)) return null;
  // Filter out garbage but keep the array — we don't want a single bad entry
  // to wipe the whole list.
  const cleaned = r.data.filter(isUpstreamModel);
  if (cleaned.length === 0) return null;
  return { object: "list", data: cleaned };
}

async function fetchUpstreamList(): Promise<ModelList | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(UPSTREAM_MODELS_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      console.warn(`[models] upstream returned HTTP ${res.status}, using previous list`);
      return null;
    }
    const raw = await res.json();
    const parsed = parseList(raw);
    if (!parsed) {
      console.warn("[models] upstream payload shape unexpected, using previous list");
      return null;
    }
    return parsed;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[models] fetch failed (${reason}), using previous list`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Mutable cache. Always holds *something* — starts as FALLBACK_LIST and gets
// replaced atomically when an upstream fetch succeeds. /v1/models readers
// always see a consistent snapshot (no torn writes possible since we replace
// the whole object).
let cached: ModelList = FALLBACK_LIST;

/**
 * Returns the current model list. Cheap read of an in-memory object.
 */
export function getModelList(): ModelList {
  return cached;
}

/**
 * Start the boot fetch + 5-min refresh timer. Idempotent — call once at
 * server startup. Never throws; bad upstream just keeps the previous list.
 */
export async function startModelListRefresh(): Promise<void> {
  const refresh = async () => {
    const next = await fetchUpstreamList();
    if (next) {
      const before = cached.data.map((m) => m.id).join(",");
      const after = next.data.map((m) => m.id).join(",");
      cached = next;
      if (before !== after) {
        console.log(`[models] list refreshed: ${after}`);
      } else {
        console.log(`[models] list unchanged: ${after}`);
      }
    }
  };

  // First fetch is awaited so the list is at-least-attempted-fresh by the time
  // /v1/models is callable. If it fails we still have FALLBACK_LIST cached.
  await refresh();

  setInterval(refresh, REFRESH_INTERVAL_MS).unref?.();
}
