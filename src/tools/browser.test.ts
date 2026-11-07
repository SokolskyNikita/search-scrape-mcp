import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserAction, BrowserProvider } from "../providers/types.js";
import { registerBrowser } from "./browser.js";

test("browser state and cleanup are isolated by MCP session", async () => {
  let opened = 0;
  const closed: number[] = [];
  const provider: BrowserProvider = {
    async open() {
      const id = ++opened;
      return {
        async run() {
          return `Browser ${id}`;
        },
        async close() {
          closed.push(id);
        },
      };
    },
  };
  async function session() {
    const [upstream, downstream] = InMemoryTransport.createLinkedPair();
    const mcp = new McpServer({ name: "fixture", version: "1.0.0" });
    const cleanup = registerBrowser(mcp, [provider]);
    const client = new Client({ name: "fixture-client", version: "1.0.0" });
    await mcp.connect(upstream);
    await client.connect(downstream);
    return {
      call: async (command: BrowserAction) =>
        client.callTool({ name: "browser", arguments: { command } }),
      close: async () => {
        await client.close();
        await cleanup();
      },
    };
  }
  const a = await session();
  const b = await session();
  try {
    assert.equal(
      (await a.call({ action: "navigate", url: "http://127.0.0.1/" })).isError,
      true,
    );
    assert.equal(opened, 0);
    const command = { action: "navigate", url: "https://1.1.1.1/" } as const;
    assert.deepEqual((await a.call(command)).content, [
      { type: "text", text: "Browser 1" },
    ]);
    assert.deepEqual((await b.call(command)).content, [
      { type: "text", text: "Browser 2" },
    ]);
    await a.call({ action: "close" });
    assert.deepEqual(closed, [1]);
    assert.deepEqual((await b.call({ action: "snapshot" })).content, [
      { type: "text", text: "Browser 2" },
    ]);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
  assert.deepEqual(closed, [1, 2]);
});
