import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProviderKeys, readSettings } from "./index.js";

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
