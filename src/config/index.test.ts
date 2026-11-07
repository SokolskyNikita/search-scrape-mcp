import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProviderKeys, parseSettings, readSettings } from "./index.js";

test("private env is the only provider key source and legacy settings are readable", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "search-scrape-config-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const env = join(dir, "env");
  const config = join(dir, "config.json");
  const token = "x".repeat(40);
  writeFileSync(config, JSON.stringify({ token, serperKey: "old-key" }), {
    mode: 0o600,
  });
  writeFileSync(env, "SERPER_API_KEY=new-key\nOPENAI_API_KEY=future-key\n", {
    mode: 0o600,
  });
  const { settings, legacyKeys } = readSettings(config);
  assert.equal(settings.token, token);
  assert(!("serperKey" in settings));
  assert.equal(legacyKeys, true);
  assert.deepEqual(loadProviderKeys(env), {
    serperKey: "new-key",
    scrapflyKey: undefined,
  });
  chmodSync(env, 0o644);
  assert.throws(() => loadProviderKeys(env), { code: "config" });
});

test("tunable settings validate and the config report emits only public settings", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "search-scrape-report-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const config = join(dir, "config.json");
  const token = "token".repeat(8);
  writeFileSync(
    config,
    JSON.stringify({
      token,
      toolDeadlineSeconds: 42,
      serperKey: "legacy-secret",
    }),
    { mode: 0o600 },
  );
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("report.js", import.meta.url))],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MCP_CONFIG: config,
        MCP_KEYS_FILE: join(dir, "missing"),
      },
    },
  );
  const settings = JSON.parse(output);
  assert.equal(settings.toolDeadlineSeconds, 42);
  assert.equal(settings.browserIdleMs, 150_000);
  assert.deepEqual(settings.derived, {
    toolTimeoutMs: 42_000,
    relayTimeoutMs: 45_000,
    scrapeReserveMs: 3_000,
    scrapeBudgetMs: 39_000,
    scrapflyRungs: {
      datacenter: { requestTimeoutMs: 15_000, scrapflyTimeoutMs: 15_000 },
      unblocker: { requestTimeoutMs: 30_000, scrapflyTimeoutMs: 30_000 },
      render: { requestTimeoutMs: 30_000, scrapflyTimeoutMs: 30_000 },
    },
  });
  assert(!output.includes(token));
  assert(!output.includes("legacy-secret"));
  for (const invalid of [
    { toolDeadlineSeconds: 60 },
    { toolDeadlineSeconds: 33 },
    { outputDirectory: "relative" },
    { browserSessionSeconds: 1801 },
    { scrapflyRenderCost: -1 },
  ])
    assert.throws(() => parseSettings({ token, ...invalid }), {
      code: "config",
    });
});

test("the config report uses defaults for a missing settings file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "search-scrape-missing-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("report.js", import.meta.url))],
    {
      encoding: "utf8",
      env: { ...process.env, MCP_CONFIG: join(dir, "config.json") },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const settings = JSON.parse(output);
  assert.equal(settings.toolDeadlineSeconds, 54);
  assert.equal(settings.scrapflyUnblockerCost, 85);
  assert.equal(settings.derived.scrapeBudgetMs, 51_000);
});
