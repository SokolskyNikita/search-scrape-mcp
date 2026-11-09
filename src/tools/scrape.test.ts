import { hostRule } from "../config/host-rules.js";
import { mcpName, messages, noticeLabel } from "../config/messages.js";
import { resultDivider } from "./result-format.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
    single.content[0].text.startsWith(
      `${mcpName} · ${messages.operation.scrape} · ${first}\n${noticeLabel.note} ${messages.note.preview}\n${messages.label.fullText} ${saved.path}\n\n${resultDivider}\n\n`,
    ),
  );
  assert.ok(single.content[0].text.endsWith(resultDivider));
  assert.equal(saved.hint, messages.file.hint);
  assert.deepEqual(seen, [first]);

  const github = await client.callTool({
    name: "scrape",
    arguments: { url: "https://github.com/owner/repo", content_mode: "full" },
  });
  assert.equal(github.isError, true);
  assert(Array.isArray(github.content));
  assert(github.content[0].text.includes(hostRule("github.com")!.accessError));
  assert.deepEqual(seen, [first]);

  const mixed = await client.callTool({
    name: "scrape_batch",
    arguments: { urls: [second, "https://www.github.com./owner/repo", first] },
  });
  const blocks = mixed.content;
  assert(Array.isArray(blocks));
  assert.equal(blocks.length, 3);
  assert(
    blocks[1].text.startsWith(
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
  assert.match(result[1].error.code, /url|target/);
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
    start_rung: "unblocker",
    max_chars: 20,
  };
  const rejected = await client.callTool({
    name: "scrape",
    arguments: { url: costly, ...options },
  });
  assert.equal(rejected.isError, true);
  assert(Array.isArray(rejected.content));
  assert.ok(rejected.content[0].text.includes(`\n${messages.label.retry} `));
  assert.ok(rejected.content[0].text.endsWith(resultDivider));
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
    exhausted.content[0].text.includes(
      `${noticeLabel.error} ${messages.page.costStopped}`,
    ),
  );
  assert.ok(exhausted.content[0].text.endsWith(resultDivider));

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
  const [retryHeader] = (stronger.content[0].text as string).split(
    resultDivider,
  );
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
    first.content[0].text,
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

test("scrape returns partial Markdown and original HTML only for extraction trouble", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scrape-extraction-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logger = t.mock.method(console, "log", () => {});
  const partialUrl = "https://1.1.1.1/partial";
  const cleanUrl = "https://1.1.1.1/clean";
  const html =
    '<html><title>Quotes</title><body><header><h1>Quotes</h1></header><main><a href="/login">Login</a></main><footer>Copyright belongs to this site.</footer></body></html>';
  const request = t.mock.method(globalThis, "fetch", async (endpoint: URL) => {
    assert.equal(endpoint.searchParams.get("format"), "raw");
    const url = endpoint.searchParams.get("url");
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
  const [header] = single.content[0].text.split(resultDivider);
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
  assert.deepEqual(partial.tried, ["datacenter"]);
  assert.equal(request.mock.callCount(), 1);

  const batch = await client.callTool({
    name: "scrape_batch",
    arguments: { urls: [partialUrl, cleanUrl, "https://github.com/"] },
  });
  assert(Array.isArray(batch.content));
  const [incomplete, clean, failed] = (
    batch.structuredContent as { items: ReturnType<typeof JSON.parse> }
  ).items;
  assert.match(incomplete.result.markdown, /\[Login\]/);
  assert.equal(readFileSync(incomplete.result.htmlPath, "utf8"), html);
  assert.match(clean.result.markdown, /steady increase in rainfall/);
  assert.equal(clean.result.htmlPath, undefined);
  assert.equal(clean.result.extractionWarning, undefined);
  assert.equal(failed.error.code, "unsafe_url");
  assert.equal(failed.error.reason, hostRule("github.com")!.accessError);
  assert.equal(request.mock.callCount(), 3);

  const logs = logger.mock.calls.map(({ arguments: [line] }) =>
    JSON.parse(String(line)),
  );
  assert.deepEqual(
    logs
      .filter((row) => row.event === "provider_attempt")
      .map((row) => row.format),
    ["raw", "raw", "raw"],
  );
  assert.deepEqual(
    logs
      .filter((row) => row.warningCode === "extraction_incomplete")
      .map((row) => [row.tool, row.itemIndex, row.httpAttempts]),
    [
      ["scrape", undefined, 1],
      ["scrape_batch", 0, 1],
    ],
  );
  const summary = logs.find(
    (row) => row.tool === "scrape_batch" && row.batchItems,
  );
  assert.deepEqual(summary.batchItems, { succeeded: 2, failed: 1 });
  assert.equal(summary.providerInvocations, 2);
  assert.equal(summary.httpAttempts, 2);
});
