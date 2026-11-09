import { AsyncLocalStorage } from "node:async_hooks";
import { defaults } from "../config/tuning.js";
import { appendFileSync, renameSync, statSync } from "node:fs";

export type RequestStats = {
  httpAttempts: number;
  parent?: RequestStats;
  warningCode?: string;
  batchItems?: { succeeded: number; failed: number };
};

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
  );
}

export function writeToolStats(
  stats: {
    tool: string;
    itemIndex?: number;
    durationMs: number;
    attempts: number;
    httpAttempts: number;
    warningCode?: string;
    batchItems?: RequestStats["batchItems"];
    provider: string | null;
    errorCode: string | null;
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
  writeStats(
    {
      event: "provider_attempt",
      ok: attempt.errorCode === null,
      tool: statsContext.getStore()?.tool,
      itemIndex: statsContext.getStore()?.itemIndex,
      ...attempt,
    },
    settings.statsLogMaxBytes,
  );
}

function writeStats(fields: object, maxBytes: number) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...fields,
  });
  const file = process.env.MCP_STATS_LOG;
  if (!file) {
    console.log(line);
    return;
  }
  try {
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (size + Buffer.byteLength(line) + 1 > maxBytes)
      renameSync(file, file + ".1");
    appendFileSync(file, line + "\n", { mode: 0o600 });
  } catch {
    console.error("Could not write the tool stats log.");
  }
}
