import { appendFileSync, renameSync, statSync } from "node:fs";

export function writeToolStats(stats: {
  tool: string;
  durationMs: number;
  attempts: number;
  provider: string | null;
  errorCode: string | null;
}) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ok: stats.errorCode === null,
    ...stats,
  });
  const file = process.env.MCP_STATS_LOG;
  if (!file) {
    console.log(line);
    return;
  }
  try {
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (size + Buffer.byteLength(line) + 1 > 2 * 1024 * 1024)
      renameSync(file, file + ".1");
    appendFileSync(file, line + "\n", { mode: 0o600 });
  } catch {
    console.error("Could not write the tool stats log.");
  }
}
