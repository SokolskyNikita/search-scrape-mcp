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
import { writeToolStats } from "./stats.js";

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
    provider: "serper",
    errorCode: "provider_limit",
  };
  writeToolStats(stats);
  const { timestamp, ...logged } = JSON.parse(readFileSync(file, "utf8"));
  assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(logged, { ok: false, ...stats });
  assert.equal(readFileSync(file + ".1", "utf8").slice(0, 7), "old log");
});
