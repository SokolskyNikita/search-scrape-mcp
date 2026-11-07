import { registerBrowser } from "../tools/browser.js";
import type { SearchInput } from "../providers/types.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { get } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defaults } from "../config/tuning.js";
import { serper } from "../providers/serper.js";
import { OutputFiles } from "../tools/output-files.js";
import { checkPage } from "../tools/page-check.js";
import { registerScrape } from "../tools/scrape.js";
import { ResultCache } from "../tools/result-cache.js";
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
        gl: "us",
        hl: "en",
      });
      return Promise.resolve(Response.json(recorded));
    },
  );
  const token = "a".repeat(40);
  const server = createMcpHttp(
    token,
    (mcp) => registerSearch(mcp, [serper("fake-key")]),
    { ...defaults, mcpSessionLimit: 256 },
  );
  assert.equal(server.maxConnections, 256);
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

test("expired MCP sessions return 404 and a fresh initialize works", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let closed = 0;
  const token = "x".repeat(40);
  const server = createMcpHttp(token, () => async () => {
    closed++;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const addr = server.address();
  assert(addr && typeof addr === "object");
  const url = new URL(`http://127.0.0.1:${addr.port}/mcp`);
  const headers = { Authorization: `Bearer ${token}` };
  async function connect() {
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
    });
    const client = new Client({ name: "expiry-fixture", version: "1.0.0" });
    await client.connect(transport);
    t.after(() => client.close());
    return transport;
  }
  const old = await connect();
  now += 2 * 60 * 60_000 + 1;
  assert.equal(
    (
      await fetch(url, {
        headers: { ...headers, "Mcp-Session-Id": old.sessionId! },
      })
    ).status,
    404,
  );
  assert.equal(closed, 1);
  const fresh = await connect();
  assert(fresh.sessionId && fresh.sessionId !== old.sessionId);
});

test(
  "parallel scrapes return per-call results at the session and server limits",
  { timeout: 10_000 },
  async (t) => {
    const token = "b".repeat(40);
    const dir = mkdtempSync(join(tmpdir(), "scrape-concurrency-"));
    const files = new OutputFiles(join(dir, "spills"));
    function latch() {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, resolve: release };
    }
    let entered = 0;
    let gate = latch();
    let ready = latch();
    let expected = 0;
    const markdown = "This is a readable fixture page. ".repeat(30);
    const server = createMcpHttp(token, (mcp) =>
      registerScrape(
        mcp,
        [
          {
            async scrape(url) {
              if (++entered === expected) ready.resolve();
              await gate.promise;
              return {
                markdown,
                check: checkPage(markdown, new URL(url), new URL(url), 200),
              };
            },
          },
        ],
        files,
      ),
    );
    const log = t.mock.method(console, "log", () => {});
    server.listen(0, "127.0.0.1");
    t.after(() => {
      gate.resolve();
      server.close();
      server.closeAllConnections();
      rmSync(dir, { recursive: true, force: true });
    });
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    async function connect() {
      const client = new Client({ name: "concurrency-test", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(endpoint, {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      t.after(() => client.close());
      return client;
    }
    const a = await connect();
    const b = await connect();
    const c = await connect();
    const scrape = (client: Client) =>
      client.callTool(
        {
          name: "scrape",
          arguments: { url: "https://1.1.1.1/" },
        },
        undefined,
        { timeout: 5_000 },
      );
    async function phase(
      accepted: Client[],
      overflow: Client[],
      code?: string,
    ) {
      entered = 0;
      expected = accepted.length;
      gate = latch();
      ready = latch();
      const successes = Promise.all(accepted.map(scrape));
      // Keep admitted calls in flight until all overload results arrive.
      try {
        await ready.promise;
        for (const result of await Promise.all(overflow.map(scrape))) {
          assert.equal(result.isError, true);
          assert(Array.isArray(result.content));
          assert.equal(JSON.parse(result.content[0].text).code, code);
          assert.match(
            result.content[0].text,
            /Retry after an in-flight call finishes/,
          );
        }
      } finally {
        gate.resolve();
        for (const result of await successes) assert(!result.isError);
      }
    }
    await phase(Array(6).fill(a), []);
    await phase(Array(8).fill(a), [a, a], "mcp_session_busy");
    await phase(
      [...Array(8).fill(a), ...Array(8).fill(b)],
      [c],
      "mcp_server_busy",
    );
    const events = log.mock.calls.map(({ arguments: [line] }) =>
      JSON.parse(String(line)),
    );
    assert.deepEqual(
      events
        .filter((event) => event.errorCode)
        .map((event) => [event.tool, event.attempts, event.errorCode]),
      [
        ["scrape", 0, "mcp_session_busy"],
        ["scrape", 0, "mcp_session_busy"],
        ["scrape", 0, "mcp_server_busy"],
      ],
    );
  },
);

test("an empty search is retried and a later hit can be cached", async (t) => {
  let attempts = 0;
  const hit = { title: "IANA", url: "https://www.iana.org/" };
  const token = "c".repeat(40);
  const server = createMcpHttp(token, (mcp) =>
    registerSearch(
      mcp,
      [
        {
          async search() {
            return ++attempts === 1 ? [] : [hit];
          },
        },
      ],
      defaults,
      new ResultCache(defaults),
    ),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const client = new Client({ name: "empty-search-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    server.close();
    server.closeAllConnections();
  });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      },
    ),
  );
  const search = () =>
    client.callTool({ name: "search", arguments: { q: "site:iana.org" } });
  assert.deepEqual((await search()).content, [{ type: "text", text: "[]" }]);
  assert.deepEqual((await search()).content, [
    { type: "text", text: JSON.stringify([hit]) },
  ]);
  assert.deepEqual((await search()).content, [
    { type: "text", text: JSON.stringify([hit]) },
    { type: "text", text: '{"cached":true}' },
  ]);
  assert.equal(attempts, 2);
});

test("MCP tools explain unknown fields and normalize search filters", async (t) => {
  const token = "d".repeat(40);
  const dir = mkdtempSync(join(tmpdir(), "tool-input-"));
  const files = new OutputFiles(join(dir, "spills"));
  const searches: SearchInput[] = [];
  const server = createMcpHttp(token, (mcp) => {
    registerSearch(mcp, [
      {
        async search(args) {
          searches.push(args);
          return [];
        },
      },
    ]);
    registerScrape(mcp, [], files);
    return registerBrowser(mcp, [], files);
  });
  server.listen(0, "127.0.0.1");
  t.after(() => {
    server.close();
    server.closeAllConnections();
    rmSync(dir, { recursive: true, force: true });
  });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const client = new Client({ name: "tool-input-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      },
    ),
  );
  const tools = (await client.listTools()).tools;
  const search = tools.find(({ name }) => name === "search");
  assert.match(search?.description ?? "", /put the place name in the query/i);
  assert.match(
    JSON.stringify(search?.inputSchema.properties?.location),
    /Serper may ignore this/,
  );
  const location = "Seattle, Washington, United States";
  const result = await client.callTool({
    name: "search",
    arguments: {
      q: "best pizza in Seattle",
      location,
      site: " https://WWW.TOKIO.RS./guide?x=1 ",
      exclude_domains: ["https://WWW.SPAM.TEST:8443/path", " WWW.OTHER.TEST. "],
    },
  });
  assert(!result.isError);
  assert.deepEqual(searches, [
    {
      query: "best pizza in Seattle",
      location,
      site: "tokio.rs",
      exclude_domains: ["spam.test", "other.test"],
      limit: 5,
    },
  ]);

  const failures = [
    [
      "search",
      { q: "test", recent: "week" },
      /Unknown field "recent". Valid fields are .*recency/,
    ],
    [
      "search_batch",
      { searches: [{ q: "test", recent: "week" }] },
      /Unknown field "recent". Valid fields are .*recency.* at searches\[0\]/,
    ],
    [
      "search_batch",
      { searches: [{ q: "test" }], fresh: true },
      /Unknown field "fresh". Valid fields are searches\./,
    ],
    [
      "scrape",
      { url: "https://1.1.1.1/", format: "text" },
      /Unknown field "format". Valid fields are url, start_rung, fresh/,
    ],
    [
      "scrape_batch",
      { urls: ["https://1.1.1.1/"], format: "text" },
      /Unknown field "format". Valid fields are urls, start_rung, fresh/,
    ],
    [
      "browser",
      { command: { action: "close" }, extra: true },
      /Unknown field "extra". Valid fields are command\./,
    ],
    [
      "browser",
      { command: { action: "scroll", pixel: 200 } },
      /Unknown field "pixel". Valid fields are action, pixels\. at command/,
    ],
    [
      "search",
      { q: "test", site: "invalid_domain" },
      /site must be a domain like tokio\.rs/,
    ],
    [
      "search",
      { q: "test", exclude_domains: ["https://127.0.0.1/"] },
      /Each exclude_domains entry must be a domain like tokio\.rs.* at exclude_domains\[0\]/,
    ],
  ] as const;
  for (const [name, args, message] of failures) {
    const failure = await client.callTool({ name, arguments: args });
    assert.equal(failure.isError, true);
    assert(Array.isArray(failure.content));
    assert.match(failure.content[0].text, message);
  }
  assert.equal(searches.length, 1);
});
