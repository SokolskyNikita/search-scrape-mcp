import { mcpName, messages, noticeLabel } from "../config/messages.js";
import { resultDivider } from "../tools/result-format.js";
import { registerBrowser } from "../tools/browser.js";
import type { SearchHit, SearchInput } from "../providers/types.js";
import assert from "node:assert/strict";
import { firstText } from "../tools/first-text.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { get } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { defaults } from "../config/tuning.js";
import { serper } from "../providers/serper.js";
import { OutputFiles } from "../tools/output-files.js";
import { checkPage } from "../tools/page-check.js";
import { registerScrape } from "../tools/scrape.js";
import { ResultCache } from "../tools/result-cache.js";
import { registerSearch } from "../tools/search.js";
import { toolResult } from "../tools/shared.js";
import { deadlineHeader } from "../config/deadline.js";
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
        num: 10,
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
    { ...defaults, mcpMaxConnections: 256 },
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
    const response = await client.callTool({
      name: "search",
      arguments: { q: "example" },
    });
    const results = [
      {
        title: "Example Domain",
        url: "https://example.com/",
        snippet: "Example.",
      },
    ];
    assert.deepEqual(response.structuredContent, { results, page: 1 });
    assert.deepEqual(response.content, [
      {
        type: "text",
        text: `${mcpName} · ${messages.operation.search} · example · ${messages.label.searchPage(1)}\n\n${resultDivider}\n\n${JSON.stringify(results)}\n\n${resultDivider}`,
      },
    ]);
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

test("requests need no session, so a restarted server keeps serving old clients", async (t) => {
  const token = "x".repeat(40);
  const server = createMcpHttp(token, (mcp) =>
    registerSearch(mcp, [serper("fake-key")]),
  );
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
  const client = new Client({ name: "stateless-fixture", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
  });
  await client.connect(transport);
  t.after(() => client.close());
  assert.equal(transport.sessionId, undefined);
  assert.equal((await client.listTools()).tools.length, 2);

  // A client that still sends the session ID of a server run that is gone.
  const stale = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": "5b1f0c0e-0000-4000-8000-000000000000",
      "Mcp-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
  });
  assert.equal(stale.status, 200);
  assert.match(await stale.text(), /"search_batch"/);
  assert.equal((await fetch(url, { headers })).status, 405);
});

test(
  "parallel scrapes from several clients run together up to the server limit",
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
    const server = createMcpHttp(
      token,
      (mcp) =>
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
      { ...defaults, mcpConcurrentToolCalls: 16, mcpBusyWaitMs: 200 },
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
        { timeout: 5_000 },
      );
    async function phase(
      accepted: Client[],
      overflow: Client[],
      code = "mcp_server_busy",
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
          assert.equal(
            (result.structuredContent as { code?: string })?.code,
            code,
          );
          assert(
            firstText(result).includes(
              `${noticeLabel.error} ${messages.service.inFlight}`,
            ),
          );
        }
      } finally {
        gate.resolve();
        for (const result of await successes) assert(!result.isError);
      }
    }
    await phase(Array(12).fill(a), []);
    await phase([...Array(8).fill(a), ...Array(8).fill(b)], [c]);
    const events = log.mock.calls.map(({ arguments: [line] }) =>
      JSON.parse(String(line)),
    );
    assert.deepEqual(
      events
        .filter((event) => event.errorCode)
        .map((event) => [event.tool, event.attempts, event.errorCode]),
      [["scrape", 0, "mcp_server_busy"]],
    );
    // The rejection comes after a short wait and records how full the server was.
    assert.deepEqual(
      events
        .filter((event) => event.event === "local_limit")
        .map((event) => [event.code, event.outcome, event.inFlight]),
      [["mcp_server_busy", "rejected", 16]],
    );
  },
);

test("an empty search is retried and a later hit can be cached", async (t) => {
  let attempts = 0;
  const hit = { title: "IANA", url: "https://www.iana.org/" };
  const token = "c".repeat(40);
  const cache = new ResultCache<SearchHit[]>(defaults);
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
      cache,
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
  const empty = await search();
  assert.deepEqual(empty.structuredContent, { results: [], page: 1 });
  assert(Array.isArray(empty.content));
  assert.equal(
    firstText(empty),
    `${mcpName} · ${messages.operation.search} · site:iana.org · ${messages.label.searchPage(1)}\n${noticeLabel.note} ${messages.note.noResults}\n\n${resultDivider}`,
  );
  assert.deepEqual((await search()).structuredContent, {
    results: [hit],
    page: 1,
  });
  const cached = await search();
  const { cached_at } = cached.structuredContent as { cached_at: string };
  assert.match(cached_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(cached.structuredContent, {
    results: [hit],
    page: 1,
    cached: true,
    cached_at,
  });
  assert(Array.isArray(cached.content));
  assert(
    firstText(cached).includes(`${noticeLabel.note} ${messages.note.cached}`),
  );
  assert.ok(firstText(cached).endsWith(resultDivider));
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
    registerScrape(
      mcp,
      [
        {
          async scrape() {
            return {
              markdown: "# Scrape fixture",
              check: { code: "ok", reason: "fixture" },
            };
          },
        },
      ],
      files,
    );
    return registerBrowser(
      mcp,
      [
        {
          async open() {
            return {
              async run() {
                return "# Browser fixture";
              },
              async close() {},
            };
          },
        },
      ],
      files,
    );
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
  const browser = tools.find(({ name }) => name === "browser");
  const commandSchema = JSON.stringify(
    browser?.inputSchema.properties?.command,
  );
  assert.match(commandSchema, /"navigate"/);
  assert.match(commandSchema, /"url"/);
  assert.match(commandSchema, /"click"/);
  assert.match(commandSchema, /"ref"/);
  for (const [name, limit] of [
    ["scrape", 16_000],
    ["scrape_batch", 20_000],
  ] as const) {
    const tool = tools.find((tool) => tool.name === name);
    assert.match(tool?.description ?? "", new RegExp(String(limit)));
    assert(tool?.inputSchema.properties?.max_chars);
    assert.match(
      JSON.stringify(tool.inputSchema.properties.allow_higher_cost),
      /retry at higher cost/,
    );
  }
  const search = tools.find(({ name }) => name === "search");
  assert.match(search?.description ?? "", /exactly one of q or query/);
  assert(search?.inputSchema.properties?.q);
  assert(search.inputSchema.properties.query);
  assert.doesNotMatch(search.description ?? "", /Serper|place name/i);
  assert.match(
    JSON.stringify(search.inputSchema.properties.location),
    /include the place name/i,
  );
  assert.match(
    JSON.stringify(search?.inputSchema.properties?.location),
    /Best-effort location hint/,
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
      limit: 10,
    },
  ]);

  const batch = await client.callTool({
    name: "search_batch",
    arguments: {
      searches: [
        { q: "default limit" },
        { query: "max limit", limit: 10 },
        { q: "third", limit: 1 },
        { q: "fourth" },
        { q: "fifth" },
      ],
    },
  });
  assert(!batch.isError);
  assert.deepEqual(searches.slice(1), [
    { query: "default limit", limit: 10 },
    { query: "max limit", limit: 10 },
    { query: "third", limit: 1 },
    { query: "fourth", limit: 10 },
    { query: "fifth", limit: 10 },
  ]);

  const fields = (tool: string) =>
    Object.keys(
      tools.find(({ name }) => name === tool)?.inputSchema.properties ?? {},
    );
  const failures = [
    ["search", {}, messages.input.query],
    ["search", { q: "test", query: "also test" }, messages.input.query],
    [
      "search_batch",
      { searches: Array.from({ length: 6 }, () => ({ q: "test" })) },
      /searches: Too big: expected array to have <=5 items/,
    ],
    [
      "search_batch",
      { searches: [{ q: "test", limit: 11 }] },
      /searches\W+0\W+limit\W*: Too big: expected number to be <=10/,
    ],
    [
      "search",
      { q: "test", recent: "week" },
      messages.input.unknownFields(["recent"], fields("search")),
    ],
    [
      "search_batch",
      { searches: [{ q: "test", recent: "week" }] },
      messages.input.unknownFields(["recent"], fields("search")),
    ],
    [
      "search_batch",
      { searches: [{ q: "test" }], fresh: true },
      messages.input.unknownFields(["fresh"], fields("search_batch")),
    ],
    [
      "scrape",
      { url: "https://1.1.1.1/", format: "text" },
      messages.input.unknownFields(["format"], fields("scrape")),
    ],
    [
      "scrape_batch",
      { urls: ["https://1.1.1.1/"], format: "text" },
      messages.input.unknownFields(["format"], fields("scrape_batch")),
    ],
    [
      "browser",
      { command: { action: "close" }, extra: true },
      messages.input.unknownFields(["extra"], fields("browser")),
    ],
    [
      "browser",
      { command: { action: "scroll", pixel: 200 } },
      messages.input.unknownFields(["pixel"], ["action", "pixels"]),
    ],
    ["search", { q: "test", site: "invalid_domain" }, messages.input.domain],
    [
      "search",
      { q: "test", exclude_domains: ["https://127.0.0.1/"] },
      messages.input.excludeDomains,
    ],
  ] as const;
  for (const [name, args, message] of failures) {
    const failure = await client.callTool({ name, arguments: args });
    assert.equal(failure.isError, true);
    assert.deepEqual(
      (failure.structuredContent as { code?: string })?.code,
      "input",
    );
    assert(Array.isArray(failure.content));
    assert(firstText(failure).startsWith(`${mcpName} · `));
    assert(firstText(failure).includes(`\n${noticeLabel.error} `));
    assert(firstText(failure).endsWith(resultDivider));
    if (typeof message === "string")
      assert(firstText(failure).includes(message));
    else assert.match(firstText(failure), message);
  }
  assert.equal(searches.length, 6);

  const url = "https://1.1.1.1/";
  const cases = [
    [
      "search",
      { q: "empty", page: 2 },
      messages.operation.search,
      "empty",
      undefined,
      2,
    ],
    [
      "search_batch",
      { searches: [{ q: "empty", page: 3 }] },
      messages.operation.search,
      "empty",
      undefined,
      3,
    ],
    ["scrape", { url }, messages.operation.scrape, url, "# Scrape fixture"],
    [
      "scrape_batch",
      { urls: [url] },
      messages.operation.scrape,
      url,
      "# Scrape fixture",
    ],
    [
      "browser",
      { command: { action: "navigate", url } },
      messages.operation.browser("navigate"),
      url,
      "# Browser fixture",
    ],
  ] as const;
  for (const [name, args, operation, target, body, page] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, name);
    assert(Array.isArray(result.content));
    const heading = `${mcpName} · ${operation} · ${target}${page ? ` · ${messages.label.searchPage(page)}` : ""}`;
    if (name === "scrape_batch")
      assert.match(firstText(result), /Batch status:.*1. readable/s);
    if (name === "browser") {
      // Navigate names the browser it opened so later calls can pass it back.
      const first = (result.content as { text: string }[])[0]!;
      const session = /\nBrowser session \(pass as session\): b[a-f0-9]{8}/;
      assert.match(first.text, session);
      assert.match(
        (result.structuredContent as { session: string }).session,
        /^b[a-f0-9]{8}$/,
      );
      first.text = first.text.replace(session, "");
    }
    assert.deepEqual(
      name === "scrape_batch" ? result.content.slice(1) : result.content,
      [
        {
          type: "text",
          text: body
            ? `${heading}\n\n${resultDivider}\n\n${body}\n\n${resultDivider}`
            : `${heading}\n${noticeLabel.note} ${messages.note.noResults}\n\n${resultDivider}`,
        },
      ],
      name,
    );
  }
});

test("a client that disconnects mid-call stops the tool's work", async (t) => {
  const token = "a".repeat(40);
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  let stopped!: (reason: unknown) => void;
  const aborted = new Promise<unknown>((resolve) => (stopped = resolve));
  const server = createMcpHttp(token, (mcp) => {
    mcp.registerTool("scrape", { inputSchema: {} }, () =>
      toolResult("scrape", (_, signal) => {
        signal.addEventListener("abort", () => stopped(signal.reason));
        started();
        return new Promise(() => {});
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const post = (body: object, extra = {}, signal?: AbortSignal) =>
    fetch(url, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal,
    });
  const initialized = await post({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    },
  });
  await initialized.text();
  const session = {
    "Mcp-Session-Id": initialized.headers.get("mcp-session-id")!,
    "Mcp-Protocol-Version": "2025-06-18",
  };
  await post({ method: "notifications/initialized" }, session);

  const client = new AbortController();
  const call = post(
    { id: 2, method: "tools/call", params: { name: "scrape", arguments: {} } },
    session,
    client.signal,
  ).catch(() => undefined);
  await running;
  client.abort();
  await call;
  const reason = (await aborted) as { code?: string };
  assert.equal(reason.code, "client_disconnected");
});

test("a client can ask for a shorter deadline, and a batch then returns what it has", async (t) => {
  const token = "c".repeat(40);
  const dir = mkdtempSync(join(tmpdir(), "scrape-deadline-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const markdown = "This is a readable fixture page. ".repeat(30);
  const register = (mcp: Parameters<typeof registerScrape>[0]) =>
    registerScrape(
      mcp,
      [
        {
          async scrape(url, signal) {
            if (url.endsWith("/slow"))
              await new Promise((_, reject) =>
                signal?.addEventListener("abort", () => reject(signal.reason)),
              );
            return {
              markdown,
              check: checkPage(markdown, new URL(url), new URL(url), 200),
            };
          },
        },
      ],
      new OutputFiles(join(dir, "spills")),
    );
  const server = createMcpHttp(token, register);
  t.mock.method(console, "log", () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const client = new Client({ name: "deadline-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    server.close();
    server.closeAllConnections();
  });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${token}`,
            [deadlineHeader]: "1000",
          },
        },
      },
    ),
  );
  const started = performance.now();
  const batch = await client.callTool({
    name: "scrape_batch",
    arguments: { urls: ["https://1.1.1.1/fast", "https://8.8.8.8/slow"] },
  });
  const elapsed = performance.now() - started;
  assert(elapsed >= 900 && elapsed < 5_000, String(elapsed));
  assert.equal(batch.isError, undefined);
  const items = (
    batch.structuredContent as {
      items: { result?: object; error?: { code: string } }[];
    }
  ).items;
  assert(items[0]!.result);
  assert.equal(items[1]!.error?.code, "tool_timeout");
});
