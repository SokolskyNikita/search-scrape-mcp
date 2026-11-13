import { defaults } from "../config/tuning.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { version } from "../config/version.js";
import { parseSettings } from "../config/index.js";
import { nodeHttp2Warning } from "./doctor.js";
import {
  chosenSettings,
  claudeCodeEntry,
  codexDirectEntry,
  codexRunsHeaderHelpers,
  mergeDesktopConfig,
  renderPlist,
} from "./install.js";

test("the LaunchAgent runs this install's serve command and escapes XML", () => {
  const plist = renderPlist(
    ["/opt/homebrew/bin/search-scrape-mcp", "serve"],
    { MCP_CONFIG: "/Users/a&b/config.json" },
    "/Users/a&b/Logs",
  );
  assert.match(
    plist,
    /<array><string>\/opt\/homebrew\/bin\/search-scrape-mcp<\/string><string>serve<\/string><\/array>/,
  );
  assert.match(plist, /<string>\/Users\/a&amp;b\/config\.json<\/string>/);
  assert.match(plist, /<string>\/Users\/a&amp;b\/Logs\/stderr\.log<\/string>/);
});

test("the Claude Desktop entry is merged without touching other servers, and removed on uninstall", () => {
  const existing = JSON.stringify({
    theme: "dark",
    mcpServers: { other: { command: "x" } },
  });
  const added = mergeDesktopConfig(existing, ["/usr/bin/node", "/app/main.js"]);
  assert.deepEqual(JSON.parse(added!), {
    theme: "dark",
    mcpServers: {
      other: { command: "x" },
      "search-scrape": {
        command: "/usr/bin/node",
        args: ["/app/main.js", "relay"],
      },
    },
  });
  assert.equal(
    mergeDesktopConfig(added!, ["/usr/bin/node", "/app/main.js"]),
    undefined,
  );
  assert.deepEqual(JSON.parse(mergeDesktopConfig(added!, undefined)!), {
    theme: "dark",
    mcpServers: { other: { command: "x" } },
  });
  assert.deepEqual(JSON.parse(mergeDesktopConfig("", ["/bin/cmd"])!), {
    mcpServers: { "search-scrape": { command: "/bin/cmd", args: ["relay"] } },
  });
  assert.throws(() => mergeDesktopConfig("[]", ["/bin/cmd"]), SyntaxError);
});

test("the Claude Code entry quotes the headers command and outlasts the tool deadline", () => {
  assert.deepEqual(
    claudeCodeEntry(8765, ["/My Apps/node", "/a$b/main.js"], 300_000),
    {
      type: "http",
      url: "http://127.0.0.1:8765/mcp",
      headersHelper: '"/My Apps/node" "/a\\$b/main.js" "headers"',
      timeout: 300_000,
    },
  );
});

test("only settings that differ from the defaults are saved", () => {
  const token = "t".repeat(40);
  const settings = parseSettings({
    token,
    port: 9000,
    statsLogMaxBytes: 2_097_152,
    cacheTtlMs: defaults.cacheTtlMs,
  });
  assert.deepEqual(
    chosenSettings(settings, [
      "token",
      "port",
      "statsLogMaxBytes",
      "cacheTtlMs",
    ]),
    { token, port: 9000, statsLogMaxBytes: 2_097_152 },
  );
  // The saved result still loads to the same settings.
  assert.deepEqual(parseSettings(chosenSettings(settings)), settings);
});

test("the command reports the package version and rejects unknown commands", () => {
  const main = fileURLToPath(new URL("./main.js", import.meta.url));
  assert.equal(
    execFileSync(process.execPath, [main, "--version"], { encoding: "utf8" }),
    `search-scrape-mcp ${version}\n`,
  );
  assert.throws(() =>
    execFileSync(process.execPath, [main, "nonsense"], { stdio: "pipe" }),
  );
});

test("doctor warns about Node 26 builds with the HTTP/2 idle crash", () => {
  for (const version of ["26.0.0", "26.5.0", "26.13.0"])
    assert.match(nodeHttp2Warning(version) ?? "", /26\.13\.1 fixes it/);
  for (const version of ["22.20.5", "24.11.0", "26.13.1", "26.14.0", "27.0.0"])
    assert.equal(nodeHttp2Warning(version), undefined);
});

test("the Codex entry gains the token helper and timeout without touching other tables", () => {
  const before = [
    'model = "example"',
    "",
    "[mcp_servers.other]",
    'command = "x"',
    "",
    "[mcp_servers.search-scrape]",
    'url = "http://127.0.0.1:8765/mcp"',
    "tool_timeout_sec = 60",
    "",
    '[projects."/tmp/a"]',
    'trust_level = "trusted"',
    "",
  ].join("\n");
  const helper = '"/My Apps/search-scrape-mcp" "headers"';
  const after = codexDirectEntry(before, "search-scrape", helper, 300)!;
  assert.equal(
    after,
    [
      'model = "example"',
      "",
      "[mcp_servers.other]",
      'command = "x"',
      "",
      "[mcp_servers.search-scrape]",
      'url = "http://127.0.0.1:8765/mcp"',
      'http_headers_helper = "\\"/My Apps/search-scrape-mcp\\" \\"headers\\""',
      "tool_timeout_sec = 300",
      "",
      '[projects."/tmp/a"]',
      'trust_level = "trusted"',
      "",
    ].join("\n"),
  );
  // Applying it again changes nothing.
  assert.equal(codexDirectEntry(after, "search-scrape", helper, 300), after);
  // A relay entry, or no entry, is left for the caller to handle.
  assert.equal(
    codexDirectEntry(
      '[mcp_servers.search-scrape]\ncommand = "x"\n',
      "search-scrape",
      helper,
      300,
    ),
    undefined,
  );
  assert.equal(codexDirectEntry("", "search-scrape", helper, 300), undefined);
  assert.equal(codexRunsHeaderHelpers("codex-cli 0.167.0"), true);
  assert.equal(codexRunsHeaderHelpers("codex-cli 0.166.9"), false);
  assert.equal(codexRunsHeaderHelpers("codex-cli 1.0.0"), true);
  assert.equal(codexRunsHeaderHelpers("unknown"), false);
});
