import { AsyncLocalStorage } from "node:async_hooks";
import { defaults } from "../config/tuning.js";
import { appendFileSync, renameSync, statSync } from "node:fs";

export const statsContext = new AsyncLocalStorage<{
  tool: string;
  itemIndex?: number;
}>();

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
    { event: "local_limit", ...statsContext.getStore(), ...event },
    settings.statsLogMaxBytes,
  );
}

export function writeToolStats(
  stats: {
    tool: string;
    itemIndex?: number;
    durationMs: number;
    attempts: number;
    provider: string | null;
    errorCode: string | null;
  },
  settings = defaults,
) {
  writeStats(
    { ok: stats.errorCode === null, ...stats },
    settings.statsLogMaxBytes,
  );
}

export function writeProviderAttempt(
  attempt: {
    provider: string;
    rung: string;
    datacenterBlocked?: boolean;
    hedgeTrigger?: "delay" | "failure";
    credits: number | null;
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
