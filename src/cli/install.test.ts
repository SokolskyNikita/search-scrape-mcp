import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { version } from "../config/version.js";
import { claudeCodeEntry, mergeDesktopConfig, renderPlist } from "./install.js";

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

test("the Claude Code entry quotes the headers command for a shell", () => {
  assert.deepEqual(claudeCodeEntry(8765, ["/My Apps/node", "/a$b/main.js"]), {
    type: "http",
    url: "http://127.0.0.1:8765/mcp",
    headersHelper: '"/My Apps/node" "/a\\$b/main.js" "headers"',
  });
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
