import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaults } from "../config/tuning.js";
import { version } from "../config/version.js";
import { runId, writeCrash, writeToolStats } from "./stats.js";

test("tool stats rotate at the size cap and retain only approved fields", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "search-scrape-stats-"));
  const file = join(dir, "tools.jsonl");
  const prior = process.env.MCP_STATS_LOG;
  process.env.MCP_STATS_LOG = file;
  t.after(() => {
    if (prior === undefined) delete process.env.MCP_STATS_LOG;
    else process.env.MCP_STATS_LOG = prior;
    rmSync(dir, { recursive: true });
  });
  writeFileSync(file, "old log");
  truncateSync(file, 2 * 1024 * 1024);
  const stats = {
    tool: "search",
    durationMs: 4,
    attempts: 1,
    httpAttempts: 2,
    provider: "serper",
    errorCode: "provider_limit",
  };
  writeToolStats(stats, { ...defaults, statsLogMaxBytes: 2 * 1024 * 1024 });
  const { timestamp, ...logged } = JSON.parse(readFileSync(file, "utf8"));
  assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(logged, {
    version,
    runId,
    ok: false,
    ...stats,
    providerInvocations: 1,
  });
  assert.equal(readFileSync(file + ".1", "utf8").slice(0, 7), "old log");
});

test("rotation keeps the configured number of files and drops the oldest", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "search-scrape-stats-"));
  const file = join(dir, "tools.jsonl");
  const prior = process.env.MCP_STATS_LOG;
  process.env.MCP_STATS_LOG = file;
  t.after(() => {
    if (prior === undefined) delete process.env.MCP_STATS_LOG;
    else process.env.MCP_STATS_LOG = prior;
    rmSync(dir, { recursive: true });
  });
  const settings = { ...defaults, statsLogMaxBytes: 1_024, statsLogFiles: 3 };
  for (const generation of ["first", "second", "third", "fourth"]) {
    writeFileSync(file, generation.padEnd(1_024));
    writeCrash("uncaughtException", new TypeError("boom"), settings);
  }
  const head = (name: string) => readFileSync(join(dir, name), "utf8").trim();
  assert.equal(head("tools.jsonl.1"), "fourth");
  assert.equal(head("tools.jsonl.2"), "third");
  assert.throws(() => readFileSync(join(dir, "tools.jsonl.3")));
  const crash = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(crash.event, "crash");
  assert.equal(crash.kind, "uncaughtException");
  assert.equal(crash.name, "TypeError");
  assert.equal("message" in crash, false);
});
