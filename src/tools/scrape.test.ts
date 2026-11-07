import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AppError } from "../server/error.js";
import { registerScrape } from "./scrape.js";

test("scrape tools use fallback, bound content, and preserve batch order", async (t) => {
  const mcp = new McpServer({ name: "scrape-test", version: "1.0.0" });
  const seen: string[] = [];
  const content = "Public page content ".repeat(4_000).trim();
  registerScrape(mcp, [
    {
      scrape: async (url) => {
        seen.push(url);
        throw new AppError("blocked", "Page was blocked.");
      },
    },
    { scrape: async () => content },
  ]);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await mcp.close();
  });

  const first = "https://8.8.8.8/first";
  const second = "https://1.1.1.1/second";
  const single = await client.callTool({
    name: "scrape",
    arguments: { url: first },
  });
  assert(Array.isArray(single.content));
  const chunk = JSON.parse(single.content[0].text);
  assert.equal(chunk.markdown, content.slice(0, 48_000));
  const more = await client.callTool({
    name: "scrape_more",
    arguments: { pageId: chunk.pageId, offset: chunk.nextOffset },
  });
  assert(Array.isArray(more.content));
  assert.equal(
    chunk.markdown + JSON.parse(more.content[0].text).markdown,
    content,
  );
  assert.deepEqual(seen, [first]);

  const mixed = await client.callTool({
    name: "scrape_batch",
    arguments: { urls: [second, "http://127.0.0.1/private", first] },
  });
  const blocks = mixed.content;
  assert(Array.isArray(blocks));
  assert.equal(blocks.length, 1);
  const result = JSON.parse(blocks[0].text);
  assert.deepEqual(
    result.map((item: { index: number }) => item.index),
    [0, 1, 2],
  );
  assert.equal(result[0].result.markdown, content.slice(0, 20_000));
  assert.equal(result[2].result.markdown, result[0].result.markdown);
  assert.match(result[1].error.code, /url|target/);
  assert.deepEqual(seen, [first, second, first]);
});
