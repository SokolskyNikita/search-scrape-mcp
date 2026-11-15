#!/usr/bin/env node
// Summarize the server's JSONL stats log (tools.jsonl and its rotated copies).
//
//   node scripts/stats.mjs                     # summary of everything on disk
//   node scripts/stats.mjs --since 2026-11-13  # from a date or ISO time (UTC)
//   node scripts/stats.mjs --since 36h         # or a relative window: 90m, 36h, 7d
//   node scripts/stats.mjs --json              # machine-readable summary
//   node scripts/stats.mjs --export DIR        # copy the raw logs into DIR/<timestamp>/
//   node scripts/stats.mjs --archive           # export to <logs>/archive/, then empty the logs
//
// --dir picks another log folder (default ~/Library/Logs/search-scrape-mcp).
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  truncateSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) fail(`${name} needs a value.`);
  return value;
};
function fail(message) {
  console.error(message);
  process.exit(1);
}
if (flag("--help") || flag("-h")) {
  console.log(
    readFileSync(new URL(import.meta.url), "utf8")
      .split("\n")
      .slice(1, 11)
      .join("\n")
      .replaceAll("// ", "")
      .replaceAll("//", ""),
  );
  process.exit(0);
}

const dir =
  option("--dir") ?? join(homedir(), "Library", "Logs", "search-scrape-mcp");
const time = (value) => {
  if (value === undefined) return undefined;
  const relative = /^(\d+)([mhd])$/.exec(value);
  if (relative)
    return (
      Date.now() -
      Number(relative[1]) *
        { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2]]
    );
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) fail(`Could not read the time ${value}.`);
  return parsed;
};
const since = time(option("--since"));
const until = time(option("--until"));

if (!existsSync(dir)) fail(`No log folder at ${dir}.`);
const statsFiles = readdirSync(dir)
  .filter((name) => /^tools\.jsonl(\.\d+)?$/.test(name))
  .sort((a, b) => rotation(b) - rotation(a));
function rotation(name) {
  return Number(/\.(\d+)$/.exec(name)?.[1] ?? 0);
}
const logFiles = [
  ...statsFiles,
  ...["stderr.log", "stdout.log"].filter((name) => existsSync(join(dir, name))),
];

const exportTo = flag("--archive") ? join(dir, "archive") : option("--export");
if (exportTo) {
  const target = join(
    exportTo,
    new Date().toISOString().replaceAll(":", "-").slice(0, 19),
  );
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of logFiles)
    copyFileSync(join(dir, name), join(target, name));
  console.log(`Copied ${logFiles.length} files to ${target}.`);
  if (flag("--archive")) {
    for (const name of logFiles) truncateSync(join(dir, name), 0);
    console.log(`Emptied ${logFiles.length} files in ${dir}.`);
  }
  process.exit(0);
}

const rows = [];
let unreadable = 0;
for (const name of statsFiles)
  for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const at = Date.parse(row.timestamp);
      if ((since && at < since) || (until && at > until)) continue;
      rows.push(row);
    } catch {
      unreadable++;
    }
  }
rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

const count = (items, key) => {
  const counts = new Map();
  for (const item of items) {
    const k = key(item);
    if (k !== undefined) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
};
const sum = (items, value) =>
  items.reduce((total, item) => total + (value(item) ?? 0), 0);
const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

const toolRows = rows.filter((row) => row.event === undefined);
const attempts = rows.filter((row) => row.event === "provider_attempt");
const limits = rows.filter((row) => row.event === "local_limit");
const crashes = rows.filter((row) => row.event === "crash");
const scrapfly = attempts.filter((row) => row.provider === "scrapfly");

const tools = count(toolRows, (row) => row.tool).map(([tool]) => {
  const own = toolRows.filter((row) => row.tool === tool);
  const durations = own.map((row) => row.durationMs).sort((a, b) => a - b);
  return {
    tool,
    calls: own.length,
    failed: own.filter((row) => !row.ok).length,
    p50Ms: percentile(durations, 0.5),
    p90Ms: percentile(durations, 0.9),
    maxMs: durations.at(-1),
    errors: Object.fromEntries(
      count(
        own.filter((row) => !row.ok),
        (row) => row.errorCode,
      ).slice(0, 8),
    ),
  };
});

const rungs = count(scrapfly, (row) => row.rung).map(([rung, n]) => {
  const own = scrapfly.filter((row) => row.rung === rung);
  return {
    rung,
    attempts: n,
    failed: own.filter((row) => !row.ok).length,
    credits: sum(own, (row) => row.credits),
    failedCredits: sum(
      own.filter((row) => !row.ok),
      (row) => row.credits,
    ),
    startSources: Object.fromEntries(count(own, (row) => row.startSource)),
  };
});

const overBudget = scrapfly
  .filter(
    (row) =>
      row.credits != null &&
      row.costBudget != null &&
      row.credits > row.costBudget,
  )
  .map((row) => ({
    timestamp: row.timestamp,
    host: row.host,
    rung: row.rung,
    credits: row.credits,
    budget: row.costBudget,
    errorCode: row.errorCode,
    charges: Array.isArray(row.costBreakdown?.details)
      ? Object.fromEntries(
          row.costBreakdown.details.map((d) => [d.code, d.amount]),
        )
      : undefined,
  }));

const baseHost = (host) => host?.replace(/^(www|m)\./, "");
const hosts = count(
  attempts.filter((row) => row.host),
  (row) => baseHost(row.host),
)
  .map(([host]) => {
    const own = attempts.filter((row) => baseHost(row.host) === host);
    return {
      host,
      attempts: own.length,
      ok: own.filter((row) => row.ok).length,
      urls: new Set(own.map((row) => row.url)).size,
      credits: sum(own, (row) => row.credits),
      seconds: Math.round(sum(own, (row) => row.durationMs) / 1000),
      errors: Object.fromEntries(
        count(
          own.filter((row) => !row.ok),
          (row) => `${row.rung}:${row.errorCode}`,
        ).slice(0, 3),
      ),
    };
  })
  .filter((host) => host.attempts - host.ok >= 3)
  .sort((a, b) => b.attempts - b.ok - (a.attempts - a.ok))
  .slice(0, 25);

const repeatedFailures = count(
  attempts.filter((row) => !row.ok && row.url),
  (row) => `${row.url} ${row.errorCode}`,
)
  .filter(([, n]) => n > 1)
  .slice(0, 15)
  .map(([key, n]) => ({ failure: key, times: n }));

const browserFailures = count(
  toolRows.filter((row) => row.tool === "browser" && !row.ok),
  (row) =>
    [row.action ?? "-", row.host ?? "-", row.errorReason ?? row.errorCode].join(
      "\t",
    ),
)
  .slice(0, 15)
  .map(([key, n]) => {
    const [action, host, reason] = key.split("\t");
    return { times: n, action, host, reason };
  });

const waits = limits.filter((row) => row.outcome === "wait" && row.retryAt);
const waitSeconds = waits.map(
  (row) => (Date.parse(row.retryAt) - Date.parse(row.timestamp)) / 1000,
);

const summary = {
  folder: dir,
  files: statsFiles,
  unreadableLines: unreadable,
  from: rows[0]?.timestamp,
  to: rows.at(-1)?.timestamp,
  events: Object.fromEntries(count(rows, (row) => row.event ?? "tool_call")),
  versions: Object.fromEntries(count(rows, (row) => row.version ?? "unknown")),
  processes: new Set(rows.map((row) => row.runId).filter(Boolean)).size,
  days: Object.fromEntries(
    count(rows, (row) => row.timestamp.slice(0, 10)).sort(),
  ),
  tools,
  credits: {
    serperSearches: sum(
      attempts.filter((row) => row.provider === "serper"),
      (row) => row.credits,
    ),
    scrapfly: sum(scrapfly, (row) => row.credits),
    scrapflyOnFailures: sum(
      scrapfly.filter((row) => !row.ok),
      (row) => row.credits,
    ),
    scrapflyOverBudget: sum(overBudget, (row) => row.credits),
    scrapflyUnconfirmed: sum(
      scrapfly.filter((row) => row.creditsUnconfirmed),
      (row) => row.credits,
    ),
  },
  rungs,
  overBudget,
  hosts,
  repeatedFailures,
  browserFailures,
  limits: Object.fromEntries(
    count(limits, (row) => `${row.code}:${row.outcome}`),
  ),
  rateLimitWaits: {
    count: waits.length,
    totalSeconds: Math.round(sum(waitSeconds, (s) => s)),
    maxSeconds: Math.max(0, ...waitSeconds),
  },
  outputs: {
    cached: toolRows.filter((row) => row.cached).length,
    truncated: toolRows.filter((row) => row.truncated).length,
    warnings: Object.fromEntries(count(toolRows, (row) => row.warningCode)),
  },
  crashes: crashes.map((row) => ({
    timestamp: row.timestamp,
    kind: row.kind,
    name: row.name,
    code: row.code,
  })),
};

if (flag("--json")) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const out = (line = "") => console.log(line);
const table = (items, columns) => {
  if (!items.length) return out("  (none)");
  const cell = (value) =>
    typeof value === "object" && value !== null
      ? JSON.stringify(value)
      : String(value ?? "");
  const widths = columns.map((c) =>
    Math.max(c.length, ...items.map((item) => cell(item[c]).length)),
  );
  out("  " + columns.map((c, i) => c.padEnd(widths[i])).join("  "));
  for (const item of items)
    out(
      "  " + columns.map((c, i) => cell(item[c]).padEnd(widths[i])).join("  "),
    );
};

out(`Stats log: ${dir} (${statsFiles.join(", ") || "no files"})`);
out(
  `Window: ${summary.from ?? "-"} to ${summary.to ?? "-"}, ${rows.length} events, ${summary.processes} server processes`,
);
out(`Versions: ${JSON.stringify(summary.versions)}`);
out(`Events: ${JSON.stringify(summary.events)}`);
out(`Days (UTC): ${JSON.stringify(summary.days)}`);
if (unreadable) out(`Unreadable lines: ${unreadable}`);
out();
out("Tools");
table(tools, ["tool", "calls", "failed", "p50Ms", "p90Ms", "maxMs", "errors"]);
out();
out(
  `Credits: ${summary.credits.serperSearches} Serper searches; ${summary.credits.scrapfly} Scrapfly credits, ${summary.credits.scrapflyOnFailures} on failed attempts, ${summary.credits.scrapflyOverBudget} on attempts over budget, ${summary.credits.scrapflyUnconfirmed} unconfirmed (no response body)`,
);
out();
out("Scrapfly rungs");
table(rungs, [
  "rung",
  "attempts",
  "failed",
  "credits",
  "failedCredits",
  "startSources",
]);
out();
out("Scrapfly attempts over their cost budget");
table(overBudget, [
  "timestamp",
  "host",
  "rung",
  "credits",
  "budget",
  "errorCode",
  "charges",
]);
out();
out("Hosts with 3 or more failed attempts");
table(hosts, [
  "host",
  "attempts",
  "ok",
  "urls",
  "credits",
  "seconds",
  "errors",
]);
out();
out("Repeated failures on the same URL");
table(repeatedFailures, ["times", "failure"]);
out();
out("Browser failures");
table(browserFailures, ["times", "action", "host", "reason"]);
out();
out(`Local limits and cache: ${JSON.stringify(summary.limits)}`);
out(
  `Rate-limit waits: ${summary.rateLimitWaits.count}, ${summary.rateLimitWaits.totalSeconds} s in total, longest ${summary.rateLimitWaits.maxSeconds} s`,
);
out(
  `Outputs: ${summary.outputs.cached} cached, ${summary.outputs.truncated} truncated, warnings ${JSON.stringify(summary.outputs.warnings)}`,
);
out();
out("Crashes");
table(summary.crashes, ["timestamp", "kind", "name", "code"]);
