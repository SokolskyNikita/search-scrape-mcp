import { defaults } from "../config/tuning.js";
import { appendFileSync, renameSync, statSync } from "node:fs";

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
