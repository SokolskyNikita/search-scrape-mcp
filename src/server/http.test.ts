import assert from "node:assert/strict";
import { once } from "node:events";
import { get } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serper } from "../providers/serper.js";
import { registerSearch } from "../tools/search.js";
import { createMcpHttp } from "./http.js";

test("authenticated MCP search uses a recorded Serper response", async (t) => {
  const original = fetch;
  const recorded = {
    organic: [
      {
        title: "Example Domain",
        link: "https://example.com/",
        snippet: "Example.",
      },
    ],
  };
  const provider = t.mock.method(
    globalThis,
    "fetch",
    (url: URL | string | Request, init?: RequestInit) => {
      if (String(url) !== "https://google.serper.dev/search")
        return original(url, init);
      assert.equal(new Headers(init?.headers).get("X-API-KEY"), "fake-key");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        q: "example",
        num: 5,
      });
      return Promise.resolve(Response.json(recorded));
    },
  );
  const token = "a".repeat(40);
  const server = createMcpHttp(token, (mcp) =>
    registerSearch(mcp, [serper("fake-key")]),
  );
  server.listen(0, "127.0.0.1");
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await original(url)).status, 401);
  assert.equal(
    (
      await original(url, {
        headers: { ...headers, Origin: "https://example.com" },
      })
    ).status,
    403,
  );
  assert.equal(
    await new Promise((resolve, reject) => {
      get(url, { headers: { ...headers, Host: "localhost" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    }),
    403,
  );
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
  });
  await client.connect(transport);
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map(({ name }) => name),
      ["search", "search_batch"],
    );
    assert.deepEqual(
      await client.callTool({
        name: "search",
        arguments: { q: "example" },
      }),
      {
        content: [
          {
            type: "text",
            text: JSON.stringify([
              {
                title: "Example Domain",
                url: "https://example.com/",
                snippet: "Example.",
              },
            ]),
          },
        ],
      },
    );
    assert(
      provider.mock.calls.some(
        ({ arguments: [url] }) =>
          String(url) === "https://google.serper.dev/search",
      ),
    );
    await transport.terminateSession();
  } finally {
    await client.close();
  }
});
