import { AsyncLocalStorage } from "node:async_hooks";
import { defaults } from "../config/tuning.js";
import { appendFileSync, renameSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { version } from "../config/version.js";

export type RequestStats = {
  httpAttempts: number;
  /** Shared by a tool call and its batch items, so their events can be joined. */
  requestId?: string;
  parent?: RequestStats;
  warningCode?: string;
  batchItems?: { succeeded: number; failed: number };
  host?: string;
  outputChars?: number;
  cached?: boolean;
  truncated?: boolean;
  /** Provider credits reported for this call so far. */
  creditsSpent?: number;
};

/** Identifies this server process in the stats log. */
export const runId = randomUUID();
export const newRequestId = () => randomUUID();

export const statsContext = new AsyncLocalStorage<{
  tool: string;
  itemIndex?: number;
  request?: RequestStats;
}>();

export function recordHttpAttempt() {
  const request = statsContext.getStore()?.request;
  if (request) {
    request.httpAttempts++;
    if (request.parent) request.parent.httpAttempts++;
  }
}

export function writeLimitEvent(
  event: {
    code: string;
    outcome: "wait" | "rejected" | "hit" | "miss" | "bypass" | "shortened";
    provider?: string;
    retryAt?: string;
    seconds?: number;
    waitedMs?: number;
    inFlight?: number;
    session?: string;
    /** Per-run keyed hash of a result cache key. */
    keyHash?: string;
    /** Why a result cache lookup missed. */
    reason?: string;
    /** Age of a result cache entry on a hit. */
    ageMs?: number;
  },
  settings = defaults,
) {
  writeStats(
    {
      event: "local_limit",
      tool: statsContext.getStore()?.tool,
      itemIndex: statsContext.getStore()?.itemIndex,
      ...event,
    },
    settings.statsLogMaxBytes,
    settings.statsLogFiles,
  );
}

export function writeToolStats(
  stats: {
    requestId?: string;
    tool: string;
    itemIndex?: number;
    durationMs: number;
    attempts: number;
    httpAttempts: number;
    warningCode?: string;
    batchItems?: RequestStats["batchItems"];
    provider: string | null;
    errorCode: string | null;
    host?: string;
    outputChars?: number;
    cached?: boolean;
    truncated?: boolean;
    creditsSpent?: number;
    era?: "legacy" | "modern";
  },
  settings = defaults,
) {
  writeStats(
    {
      ok: stats.errorCode === null,
      ...stats,
      providerInvocations: stats.attempts,
    },
    settings.statsLogMaxBytes,
    settings.statsLogFiles,
  );
}

export function providerTarget(target: URL) {
  // Query parameters can contain credentials or other sensitive data.
  return {
    host: target.hostname,
    url: `${target.origin}${target.pathname}`.slice(0, 200),
  };
}

export function writeProviderAttempt(
  attempt: {
    provider: string;
    rung: string;
    format?: string;
    host?: string;
    url?: string;
    datacenterBlocked?: boolean;
    hedgeTrigger?: "delay" | "failure";
    startSource?: "caller" | "site" | "memory" | "default";
    credits: number | null;
    remainingCredits?: number | null;
    requestedProxyPool?: string | null;
    proxyPool?: string | null;
    costBreakdown?:
      | number
      | {
          total?: number;
          details?: { amount: number; code: string; description?: string }[];
        }
      | null;
    costBudget?: number;
    providerStatus?: number;
    providerCode?: string;
    durationMs: number;
    errorCode: string | null;
  },
  settings = defaults,
) {
  const request = statsContext.getStore()?.request;
  if (request && attempt.host && !request.host) request.host = attempt.host;
  if (request && attempt.credits !== null) {
    request.creditsSpent = (request.creditsSpent ?? 0) + attempt.credits;
    if (request.parent)
      request.parent.creditsSpent =
        (request.parent.creditsSpent ?? 0) + attempt.credits;
  }
  writeStats(
    {
      event: "provider_attempt",
      ok: attempt.errorCode === null,
      tool: statsContext.getStore()?.tool,
      itemIndex: statsContext.getStore()?.itemIndex,
      ...attempt,
    },
    settings.statsLogMaxBytes,
    settings.statsLogFiles,
  );
}

/** Record a crash before the process exits. Only the error's name and code are kept. */
export function writeCrash(kind: string, error: unknown, settings = defaults) {
  const failure = error as { name?: unknown; code?: unknown } | undefined;
  writeStats(
    {
      event: "crash",
      kind,
      name: typeof failure?.name === "string" ? failure.name : typeof error,
      code: typeof failure?.code === "string" ? failure.code : undefined,
    },
    settings.statsLogMaxBytes,
    settings.statsLogFiles,
  );
}

function rotate(file: string, keep: number) {
  if (keep <= 1) {
    rmSync(file, { force: true });
    return;
  }
  rmSync(`${file}.${keep - 1}`, { force: true });
  for (let n = keep - 2; n >= 1; n--)
    if (statSync(`${file}.${n}`, { throwIfNoEntry: false }))
      renameSync(`${file}.${n}`, `${file}.${n + 1}`);
  renameSync(file, `${file}.1`);
}

function writeStats(
  fields: object,
  maxBytes: number,
  keep: number = defaults.statsLogFiles,
) {
  const requestId = statsContext.getStore()?.request?.requestId;
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    version,
    runId,
    ...(requestId ? { requestId } : {}),
    ...fields,
  });
  const file = process.env.MCP_STATS_LOG;
  if (!file) {
    console.log(line);
    return;
  }
  try {
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (size && size + Buffer.byteLength(line) + 1 > maxBytes)
      rotate(file, keep);
    appendFileSync(file, line + "\n", { mode: 0o600 });
  } catch {
    console.error("Could not write the tool stats log.");
  }
}
