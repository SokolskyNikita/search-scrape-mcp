import { hostRule } from "../config/host-rules.js";
import { mcpName, messages, noticeLabel } from "../config/messages.js";
import { resultDivider } from "./result-format.js";
import assert from "node:assert/strict";
import { firstText } from "./first-text.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { FileHosts } from "../config/file-hosts.js";
import { scrapflyScrape } from "../providers/scrapfly-scrape.js";
import { defaults } from "../config/tuning.js";
import type { ScrapeResult } from "../providers/types.js";
import { ResultCache } from "./result-cache.js";
import { AppError } from "../server/error.js";
import { OutputFiles } from "./output-files.js";
import { registerScrape } from "./scrape.js";

test("scrape tools use fallback, bound content, and preserve batch order", async (t) => {
  const mcp = new McpServer({ name: "scrape-test", version: "1.0.0" });
  const seen: string[] = [];
  const rateLimited = "https://9.9.9.9/busy";
  const costly = "https://9.9.9.9/costly";
  const budgetRejected = "https://9.9.9.9/rejected";
  const needsRender = "https://9.9.9.9/needs-render";
  const renderRequired = new AppError(
    "stronger_rung_required",
    "Provider-specific diagnostic",
    { retryRung: "render" },
  );
  const content = "Public page content ".repeat(4_000).trim();
  const dir = mkdtempSync(join(tmpdir(), "scrape-tool-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  registerScrape(
    mcp,
    [
      {
        scrape: async (url, _signal, options) => {
          seen.push(url);
          if (url === rateLimited) {
            assert.equal(options?.allowHigherCost, true);
            throw new AppError(
              "provider_rate",
              "Scrapfly is busy. Retry after 6 s.",
            );
          }
          if (url === needsRender && options?.start !== "render")
            throw renderRequired;
          if (url === budgetRejected)
            throw new AppError(
              "provider_cost_budget",
              "Internal budget rejection.",
              {
                credits: 100,
              },
            );
          if (url === costly && !options?.allowHigherCost)
            throw new AppError(
              "provider_cost_opt_in_required",
              "Internal cost notice.",
              {
                expectedCredits: 150,
              },
            );
          throw new AppError("blocked", "Page was blocked.");
        },
      },
      {
        scrape: async (url, _signal, options) => {
          if (url === needsRender && options?.start !== "render")
            throw renderRequired;
          if (url === budgetRejected)
            throw new AppError("blocked", "Page was blocked.");
          return {
            markdown: content,
            check: { code: "ok", reason: "Readable page." },
          };
        },
      },
    ],
    new OutputFiles(join(dir, "spills")),
  );

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
  const saved = single.structuredContent as Record<string, unknown>;
  assert.equal(readFileSync(saved.path as string, "utf8"), content);
  assert.equal(saved.characters, content.length);
  assert.equal(saved.truncated, true);
  assert.equal(saved.preview, content.slice(0, 600).trimEnd());
  assert.equal(saved.markdown, undefined);
  assert.ok(
    firstText(single).startsWith(
      `${mcpName} · ${messages.operation.scrape} · ${first}\n${noticeLabel.note} ${messages.note.preview}\n${messages.label.fullText} ${saved.path}\n\n${resultDivider}\n\n`,
    ),
  );
  assert.ok(firstText(single).endsWith(resultDivider));
  assert.equal(saved.hint, messages.file.hint);
  assert.deepEqual(seen, [first]);

  const github = await client.callTool({
    name: "scrape",
    arguments: { url: "https://github.com/owner/repo", content_mode: "full" },
  });
  assert.equal(github.isError, true);
  assert(Array.isArray(github.content));
  assert(firstText(github).includes(hostRule("github.com")!.accessError));
  assert.deepEqual(seen, [first]);

  const mixed = await client.callTool({
    name: "scrape_batch",
    arguments: { urls: [second, "https://www.github.com./owner/repo", first] },
  });
  const blocks = mixed.content as { text: string }[];
  assert(Array.isArray(blocks));
  assert.equal(blocks.length, 4);
  assert.match(
    blocks[0]!.text,
    /1. saved_to_file.*2. failed.*3. saved_to_file/s,
  );
  assert(
    blocks[2]!.text.startsWith(
      `${mcpName} · ${messages.operation.scrape} · https://www.github.com`,
    ),
  );
  assert.ok(blocks.every((block) => block.text.endsWith(resultDivider)));
  const result = (mixed.structuredContent as Record<string, unknown>)
    .items as ReturnType<typeof JSON.parse>;
  assert.deepEqual(
    result.map((item: { index: number }) => item.index),
    [0, 1, 2],
  );
  assert.equal(readFileSync(result[0].result.path, "utf8"), content);
  assert.equal(readFileSync(result[2].result.path, "utf8"), content);
  assert.notEqual(result[0].result.path, result[2].result.path);
  assert.equal(result[1].error.code, "unsupported_in_scrape");
  assert.equal(result[1].error.message, hostRule("github.com")!.accessError);
  assert.deepEqual(seen, [first, second, first]);

  const busyBatch = await client.callTool({
    name: "scrape_batch",
    arguments: { urls: [rateLimited, second], allow_higher_cost: true },
  });
  assert.notEqual(busyBatch.isError, true);
  assert(Array.isArray(busyBatch.content));
  const busyItems = (busyBatch.structuredContent as Record<string, unknown>)
    .items as ReturnType<typeof JSON.parse>;
  assert.deepEqual(busyItems[0].error, {
    code: "provider_rate",
    message: messages.service.busy,
    reason: messages.service.busy,
    tried: [],
  });
  assert.equal(busyItems[1].result.check.code, "ok");

  const options = {
    content_mode: "main",
    fresh: true,
    start_rung: "datacenter",
    max_chars: 20,
  };
  const rejected = await client.callTool({
    name: "scrape",
    arguments: { url: costly, ...options },
  });
  assert.equal(rejected.isError, true);
  assert(Array.isArray(rejected.content));
  assert.ok(firstText(rejected).includes(`\n${messages.label.retry} `));
  assert.ok(firstText(rejected).endsWith(resultDivider));
  const failure = rejected.structuredContent as Record<string, unknown>;
  assert.deepEqual(failure, {
    code: "scrape_cost",
    reason: messages.page.costRetry,
    message: messages.page.costRetry,
    retry: {
      name: "scrape",
      arguments: { url: costly, ...options, allow_higher_cost: true },
    },
  });
  const retried = await client.callTool(
    failure.retry as Parameters<Client["callTool"]>[0],
  );
  assert(Array.isArray(retried.content));
  const truncated = retried.structuredContent as Record<string, unknown>;
  assert.equal(truncated.truncated, true);
  assert.equal(
    truncated.preview,
    content.slice(0, options.max_chars).trimEnd(),
  );
  assert.equal(readFileSync(truncated.path as string, "utf8"), content);

  const partial = await client.callTool({
    name: "scrape_batch",
    arguments: { urls: [first, budgetRejected], ...options },
  });
  assert(Array.isArray(partial.content));
  const [completed, failed] = (
    partial.structuredContent as Record<string, unknown>
  ).items as ReturnType<typeof JSON.parse>;
  assert.equal(completed.result.truncated, true);
  assert.equal(completed.result.preview, truncated.preview);
  assert.deepEqual(failed.error, {
    code: "scrape_cost",
    message: failure.message,
    reason: failure.message,
    retry: {
      name: "scrape",
      arguments: { url: budgetRejected, ...options, allow_higher_cost: true },
    },
  });
  const exhausted = await client.callTool(failed.error.retry);
  assert(Array.isArray(exhausted.content));
  assert.equal(exhausted.isError, true);
  assert(
    firstText(exhausted).includes(
      `${noticeLabel.error} ${messages.page.costStopped}`,
    ),
  );
  assert.ok(firstText(exhausted).endsWith(resultDivider));

  const stronger = await client.callTool({
    name: "scrape",
    arguments: { url: needsRender, ...options },
  });
  assert.equal(stronger.isError, true);
  assert(Array.isArray(stronger.content));
  const details = stronger.structuredContent as Record<string, unknown>;
  const retry = {
    name: "scrape",
    arguments: { url: needsRender, ...options, start_rung: "render" },
  };
  assert.deepEqual(details.retry, retry);
  const [retryHeader] = firstText(stronger).split(resultDivider);
  assert(
    retryHeader?.includes(
      `${noticeLabel.error} ${messages.page.differentMode}`,
    ),
  );
  const retryLine = retryHeader
    ?.split("\n")
    .find((line) => line.startsWith(`${messages.label.retry} `));
  assert(retryLine);
  assert.deepEqual(
    JSON.parse(retryLine.slice(messages.label.retry.length)),
    retry,
  );
  assert(!retryHeader?.includes(renderRequired.message));
  assert.equal((await client.callTool(retry)).isError, undefined);
});

test("main and full use separate caches and batch forwards content mode", async (t) => {
  const mcp = new McpServer({ name: "scrape-test", version: "1.0.0" });
  const dir = mkdtempSync(join(tmpdir(), "scrape-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings = { ...defaults, cacheTtlMs: 60_000 };
  const seen: (string | undefined)[] = [];
  const finalUrl = "https://8.8.8.8/redirected";
  let browserAttempts = 0;
  registerScrape(
    mcp,
    [
      {
        name: "scrapfly-browser",
        scrape: async () => {
          browserAttempts++;
          throw new AppError("blocked", "Page was blocked.");
        },
      },
      {
        name: "scrapfly",
        scrape: async (_url, _signal, options) => {
          seen.push(options?.contentMode);
          return {
            markdown: options?.contentMode ?? "missing",
            finalUrl,
            check: { code: "ok", reason: "Readable page." },
          };
        },
      },
    ],
    new OutputFiles(join(dir, "spills")),
    settings,
    new ResultCache<ScrapeResult & { tried: string[] }>(settings),
  );

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await mcp.close();
  });

  const url = "https://8.8.8.8/article";
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert(Array.isArray(result.content));
    return ((result.structuredContent as Record<string, unknown>).items ??
      result.structuredContent) as ReturnType<typeof JSON.parse>;
  };
  const first = await client.callTool({ name: "scrape", arguments: { url } });
  assert(Array.isArray(first.content));
  assert.equal(
    firstText(first),
    `${mcpName} · ${messages.operation.scrape} · ${finalUrl}\n${messages.label.requestedUrl} ${url}\n\n${resultDivider}\n\nmain\n\n${resultDivider}`,
  );
  assert.equal(
    (await call("scrape", { url, content_mode: "main" })).cached,
    true,
  );
  assert.equal(
    (await call("scrape", { url, content_mode: "full" })).markdown,
    "full",
  );
  const batch = await call("scrape_batch", {
    urls: [url, "https://1.1.1.1/article"],
    content_mode: "full",
  });
  assert.equal(batch[0].result.cached, true);
  assert.equal(batch[1].result.markdown, "full");
  assert.deepEqual(seen, ["main", "full", "full"]);
  assert.equal(browserAttempts, 1);
});

test("the cache answers any start rung up to the rung that fetched the page", async (t) => {
  const mcp = new McpServer({ name: "scrape-test", version: "1.0.0" });
  const dir = mkdtempSync(join(tmpdir(), "scrape-rung-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings = { ...defaults, cacheTtlMs: 60_000 };
  const fetched: string[] = [];
  registerScrape(
    mcp,
    [
      {
        name: "scrapfly",
        scrape: async (_url, _signal, options) => {
          const rung = options?.start ?? "render";
          fetched.push(rung);
          options?.tried.push(rung);
          return {
            markdown: `fetched with ${rung}`,
            check: { code: "ok", reason: "Readable page." },
          };
        },
      },
    ],
    new OutputFiles(join(dir, "spills")),
    settings,
    new ResultCache<ScrapeResult & { tried: string[] }>(settings),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await mcp.close();
  });
  const url = "https://8.8.8.8/rungs";
  const scrape = async (start_rung?: string) =>
    (
      await client.callTool({
        name: "scrape",
        arguments: start_rung ? { url, start_rung } : { url },
      })
    ).structuredContent as { markdown: string; cached?: boolean };

  assert.equal((await scrape("datacenter")).cached, undefined);
  // A default request accepts the clean datacenter result.
  assert.equal((await scrape()).markdown, "fetched with datacenter");
  // Asking to start at render needs a page fetched at least that high.
  const rendered = await scrape("render");
  assert.equal(rendered.cached, undefined);
  assert.equal(rendered.markdown, "fetched with render");
  for (const rung of ["datacenter", undefined, "render"]) {
    const hit = await scrape(rung);
    assert.equal(hit.cached, true);
    assert.equal(hit.markdown, "fetched with render");
  }
  assert.deepEqual(fetched, ["datacenter", "render"]);
});

test("scrape returns partial Markdown and original HTML only for extraction trouble", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scrape-extraction-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logger = t.mock.method(console, "log", () => {});
  const partialUrl = "https://1.1.1.1/partial";
  const cleanUrl = "https://1.1.1.1/clean";
  let rejectRender = false;
  const html =
    '<html><title>Quotes</title><body><header><h1>Quotes</h1></header><main><a href="/login">Login</a></main><footer>Copyright belongs to this site.</footer></body></html>';
  const request = t.mock.method(globalThis, "fetch", async (endpoint: URL) => {
    assert.equal(endpoint.searchParams.get("format"), "raw");
    assert.equal(endpoint.searchParams.get("render_js"), "true");
    const url = endpoint.searchParams.get("url");
    if (
      rejectRender &&
      endpoint.searchParams.get("proxy_pool") === "public_residential_pool"
    )
      return Response.json(
        {},
        {
          status: 422,
          headers: {
            "X-Scrapfly-Reject-Code": "ERR::SCRAPE::COST_BUDGET_LIMIT",
          },
        },
      );
    return Response.json({
      result: {
        url,
        status_code: 200,
        success: true,
        format: "raw",
        content_type: "text/html",
        content:
          url === partialUrl
            ? html
            : "<html><body><main><p>The weather station recorded a steady increase in rainfall over the last five days.</p></main></body></html>",
      },
    });
  });
  const mcp = new McpServer({ name: "scrape-test", version: "1.0.0" });
  const settings = { ...defaults, scrapeInlineChars: 1, cacheTtlMs: 60_000 };
  registerScrape(
    mcp,
    [
      scrapflyScrape(
        "fixture",
        settings,
        undefined,
        undefined,
        new FileHosts([], join(dir, "hosts")),
      ),
    ],
    new OutputFiles(join(dir, "spills"), settings),
    settings,
    new ResultCache<ScrapeResult & { tried: string[] }>(settings),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await mcp.close();
  });

  const single = await client.callTool({
    name: "scrape",
    arguments: { url: partialUrl, max_chars: 1 },
  });
  assert(Array.isArray(single.content));
  const partial = single.structuredContent as ReturnType<typeof JSON.parse>;
  const [header] = firstText(single).split(resultDivider);
  assert(
    header?.includes(
      `${noticeLabel.warning} ${messages.page.extractionPartial}`,
    ),
  );
  assert(
    header?.includes(`${messages.label.originalHtml} ${partial.htmlPath}`),
  );
  assert(header?.includes(`${messages.label.fullText} ${partial.path}`));
  assert(!header?.includes(noticeLabel.note));
  assert.equal(partial.truncated, true);
  assert(partial.preview.length <= 1);
  assert.equal(readFileSync(partial.htmlPath, "utf8"), html);
  assert.match(readFileSync(partial.path, "utf8"), /\[Login\]/);
  assert.equal(partial.extractionWarning.code, "extraction_incomplete");
  assert.equal(partial.check.code, "extraction_failed");
  assert.equal(partial.fallbackText, undefined);
  assert.deepEqual(partial.tried, ["render", "residential_render"]);
  assert.equal(request.mock.callCount(), 2);

  const batch = await client.callTool({
    name: "scrape_batch",
    arguments: { urls: [partialUrl, cleanUrl, "https://github.com/"] },
  });
  assert(Array.isArray(batch.content));
  const [incomplete, clean, failed] = (
    batch.structuredContent as { items: ReturnType<typeof JSON.parse> }
  ).items;
  assert.match(incomplete.result.markdown, /\[Login\]/);
  assert.equal(incomplete.result.fallbackText, "Quotes");
  assert.equal(incomplete.result.cached, undefined);
  assert.equal(readFileSync(incomplete.result.htmlPath, "utf8"), html);
  assert.match(clean.result.markdown, /steady increase in rainfall/);
  assert.equal(clean.result.htmlPath, undefined);
  assert.equal(clean.result.extractionWarning, undefined);
  assert.equal(failed.error.code, "unsupported_in_scrape");
  assert.equal(failed.error.reason, hostRule("github.com")!.accessError);
  assert.equal(request.mock.callCount(), 5);

  const logs = logger.mock.calls.map(({ arguments: [line] }) =>
    JSON.parse(String(line)),
  );
  assert.deepEqual(
    logs
      .filter((row) => row.event === "provider_attempt")
      .map((row) => row.format),
    ["raw", "raw", "raw", "raw", "raw"],
  );
  assert.deepEqual(
    logs
      .filter((row) => row.warningCode === "extraction_incomplete")
      .map((row) => [row.tool, row.itemIndex, row.httpAttempts]),
    [
      ["scrape", undefined, 2],
      ["scrape_batch", 0, 2],
    ],
  );
  const summary = logs.find(
    (row) => row.tool === "scrape_batch" && row.batchItems,
  );
  assert.deepEqual(summary.batchItems, { succeeded: 2, failed: 1 });
  assert.equal(summary.providerInvocations, 2);
  assert.equal(summary.httpAttempts, 3);

  rejectRender = true;
  const rejected = await client.callTool({
    name: "scrape",
    arguments: { url: partialUrl },
  });
  const result = rejected.structuredContent as ReturnType<typeof JSON.parse>;
  assert.equal(result.check.code, "extraction_failed");
  assert.deepEqual(result.retry, {
    name: "scrape",
    arguments: {
      url: partialUrl,
      content_mode: "main",
      start_rung: "residential_render",
      allow_higher_cost: true,
    },
  });
});

test("a provider_down failure makes repeats of the same URL fail fast until fresh", async (t) => {
  const mcp = new McpServer({ name: "scrape-test", version: "1.0.0" });
  const seen: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "scrape-tool-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  registerScrape(
    mcp,
    [
      {
        scrape: async (url) => {
          seen.push(url);
          throw new AppError("provider_down", "Scrapfly is unavailable.");
        },
      },
    ],
    new OutputFiles(join(dir, "spills")),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await mcp.close();
  });
  const log = t.mock.method(console, "log", () => {});
  const down = "https://9.9.9.9/down";
  const call = (args: Record<string, unknown>) =>
    client.callTool({ name: "scrape", arguments: args });
  const code = (result: Awaited<ReturnType<typeof call>>) =>
    (result.structuredContent as { code?: string })?.code;

  assert.equal(code(await call({ url: down })), "provider_down");
  const repeat = await call({ url: down });
  assert.equal(code(repeat), "recently_down");
  assert(Array.isArray(repeat.content));
  assert(firstText(repeat).includes(messages.page.recentlyDown));
  assert.deepEqual(seen, [down]);

  await call({ url: "https://9.9.9.9/other" });
  await call({ url: down, fresh: true });
  assert.deepEqual(seen, [down, "https://9.9.9.9/other", down]);

  const rows = log.mock.calls.map(({ arguments: [line] }) =>
    JSON.parse(String(line)),
  );
  assert(
    rows.some(
      (row) => row.code === "provider_down_memory" && row.outcome === "hit",
    ),
  );
  const tools = rows.filter((row) => row.tool === "scrape" && !row.event);
  assert(tools.every((row) => row.host === "9.9.9.9" && row.requestId));
  assert.equal(new Set(tools.map((row) => row.requestId)).size, tools.length);
});

test("identical scrapes in flight share one fetch, and a missing page is remembered", async (t) => {
  const mcp = new McpServer({ name: "scrape-test", version: "1.0.0" });
  const seen: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "scrape-tool-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const markdown = "This is a readable fixture page. ".repeat(30);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let aborted = false;
  registerScrape(
    mcp,
    [
      {
        scrape: async (url, signal) => {
          seen.push(url);
          if (url.endsWith("/missing"))
            throw new AppError("not_found", "The page was not found.");
          signal?.addEventListener("abort", () => (aborted = true));
          await gate;
          return {
            markdown,
            check: { code: "ok", reason: "Readable page content." },
          };
        },
      },
    ],
    new OutputFiles(join(dir, "spills")),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await mcp.close();
  });
  const log = t.mock.method(console, "log", () => {});
  const call = (args: Record<string, unknown>, signal?: AbortSignal) =>
    client.callTool({ name: "scrape", arguments: args }, { signal });
  const code = (result: Awaited<ReturnType<typeof call>>) =>
    (result.structuredContent as { code?: string })?.code;

  const page = "https://9.9.9.9/page";
  const leaving = new AbortController();
  const left = call({ url: page }, leaving.signal).catch(() => "left");
  const others = [call({ url: page }), call({ url: page })];
  await new Promise<void>((resolve) => setImmediate(resolve));
  // One caller giving up doesn't stop the fetch the others are waiting on.
  leaving.abort();
  assert.equal(await left, "left");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(aborted, false);
  release();
  for (const result of await Promise.all(others)) {
    assert.equal(result.isError, undefined);
    assert(firstText(result).includes("readable fixture page"));
  }
  assert.deepEqual(seen, [page]);

  const missing = "https://9.9.9.9/missing";
  assert.equal(code(await call({ url: missing })), "not_found");
  assert.equal(code(await call({ url: missing })), "not_found");
  assert.deepEqual(seen, [page, missing]);
  assert.equal(code(await call({ url: missing, fresh: true })), "not_found");
  assert.deepEqual(seen, [page, missing, missing]);

  const events = log.mock.calls
    .map(({ arguments: [line] }) => JSON.parse(String(line)))
    .filter((row) => row.event === "local_limit" && row.outcome === "hit")
    .map((row) => row.code);
  assert.deepEqual(events, [
    "scrape_in_flight",
    "scrape_in_flight",
    "failure_memory",
  ]);
});
