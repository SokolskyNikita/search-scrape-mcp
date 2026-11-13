import { messages } from "../config/messages.js";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileHosts } from "../config/file-hosts.js";
import { defaults } from "../config/tuning.js";
import { RequestLimits } from "../server/request-limits.js";
import { todayUsage, Usage } from "../server/usage.js";
import { scrapflyScrape } from "./scrapfly-scrape.js";
import type { ScrapeOptions } from "./types.js";

const target = "https://8.8.8.8/article";
const redirected = "https://1.1.1.1/article";
const body = "# An article\r\n\r\n\r\nPublic content.";
const success = (content = body, url = target, status = 200) => ({
  context: { cost: { total: 1 } },
  result: { content, status_code: status, success: status === 200, url },
});
const options = (): ScrapeOptions => ({ tried: [] });
function fileState(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "scrapfly-files-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "file-hosts.txt");
}

// Exercise the existing opt-out ladder independently of the rendered default.
function staticFirstScrape(...args: Parameters<typeof scrapflyScrape>) {
  const provider = scrapflyScrape(...args);
  return {
    scrape: (
      url: string,
      signal?: AbortSignal,
      options: ScrapeOptions = { tried: [] },
    ) => provider.scrape(url, signal, { start: "datacenter", ...options }),
  };
}

test("Scrapfly retrieves offloaded text without forwarding credentials to another origin", async (t) => {
  let format = "clob";
  let content = "https://api.scrapfly.io/object?ref=example";
  let downloads = 0;
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    if (url.pathname === "/scrape")
      return Response.json({
        result: { ...success(content).result, format },
      });
    downloads++;
    assert.equal(url.href, content + "&key=fake-key");
    assert.equal(init.redirect, "error");
    return new Response(body, { headers: { "Content-Type": "text/plain" } });
  });
  const provider = staticFirstScrape(
    "fake-key",
    defaults,
    undefined,
    undefined,
    new FileHosts([], fileState(t)),
  );
  const result = await provider.scrape(target);
  assert.equal(result.markdown, "# An article\n\nPublic content.");
  content = "https://example.com/object";
  await assert.rejects(provider.scrape(target), { code: "provider_response" });
  format = "blob";
  await assert.rejects(provider.scrape(target), { code: "file_refused" });
  assert.equal(downloads, 1);
});

test("Scrapfly treats retryable anti-bot timeouts as transient failures", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.searchParams.get("unblocker"), "true");
    assert.equal(url.searchParams.has("render_js"), false);
    calls++;
    return Response.json(
      {},
      {
        status: 422,
        headers: {
          "X-Scrapfly-Reject-Code": "ERR::ASP::TIMEOUT",
          "X-Scrapfly-Reject-Retryable": "true",
          "Retry-After": "0",
        },
      },
    );
  });
  const tried: string[] = [];
  await assert.rejects(
    staticFirstScrape("fake-key").scrape(target, undefined, { tried }),
    { code: "provider_down" },
  );
  assert.deepEqual(tried, ["datacenter", "datacenter"]);
  assert.equal(calls, 2);
});

test("Scrapfly uses a budgeted ladder and remembers the rung that worked", async (t) => {
  const observed: string[] = [];
  let mode = "block";
  t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
    assert.equal(
      input.origin + input.pathname,
      "https://api.scrapfly.io/scrape",
    );
    assert.equal(input.searchParams.get("url"), target);
    assert.equal(init.redirect, "error");
    const rung = input.searchParams.has("render_js") ? "render" : "datacenter";
    assert.equal(input.searchParams.get("cost_budget"), "100");
    assert.equal(input.searchParams.get("unblocker"), "true");
    assert.equal(input.searchParams.get("timeout"), "30000");
    if (rung === "render")
      assert.equal(input.searchParams.get("rendering_wait"), "1000");
    observed.push(rung);
    if (mode === "block" && rung === "datacenter")
      return Response.json(success("# Access denied", target, 403));
    if (mode === "shell" && rung !== "render")
      return Response.json(success("Enable JavaScript to run this app."));
    if (mode === "missing")
      return Response.json(success("# Page not found", target, 404));
    return Response.json(success());
  });
  const provider = staticFirstScrape("fake-key");
  await assert.rejects(provider.scrape("http://127.0.0.1/"), {
    code: "unsafe_url",
  });
  const first = options();
  const result = await provider.scrape(target + "#heading", undefined, first);
  assert.equal(result.markdown, "# An article\n\nPublic content.");
  assert.deepEqual(first.tried, ["datacenter", "render"]);
  // The host is remembered as needing rendering, so the blocked rung is skipped.
  mode = "shell";
  const remembered = options();
  await provider.scrape(target, undefined, remembered);
  assert.deepEqual(remembered.tried, ["render"]);
  const next: ScrapeOptions = { start: "render", tried: [] };
  await provider.scrape(target, undefined, next);
  assert.deepEqual(next.tried, ["render"]);
  // A failure on the remembered rung forgets it.
  mode = "missing";
  await assert.rejects(provider.scrape(target), {
    code: "not_found",
    details: { tried: ["render"], credits: 1, hint: undefined },
  });
  mode = "ok";
  await provider.scrape(target);
  assert.deepEqual(observed, [
    "datacenter",
    "render",
    "render",
    "render",
    "render",
    "datacenter",
  ]);
});

test("Scrapfly validates object and string redirects and separates target from provider status", async (t) => {
  let response = () =>
    Response.json({
      ...success(body, redirected),
      context: {
        redirects: [
          { url: target, location: redirected, http_code: 302 },
          redirected,
        ],
      },
    });
  const request = t.mock.method(globalThis, "fetch", async () => response());
  const provider = staticFirstScrape("fake-key");
  assert.equal((await provider.scrape(target)).check.code, "ok");
  response = () =>
    Response.json({
      ...success(body, redirected),
      context: {
        redirects: [{ url: target, location: "http://169.254.169.254/" }],
      },
    });
  await assert.rejects(provider.scrape(target), { code: "unsafe_url" });
  response = () => Response.json(success(body, "http://127.0.0.1/"));
  await assert.rejects(provider.scrape(target), { code: "unsafe_url" });
  response = () =>
    Response.json({ ...success(), result: { ...success().result, url: null } });
  await assert.rejects(provider.scrape(target), { code: "provider_response" });
  response = () =>
    Response.json(success("# Not found", target, 404), {
      status: 422,
      headers: {
        "X-Scrapfly-Reject-Code": "ERR::SCRAPE::UPSTREAM_WEBSITE_ERROR",
      },
    });
  await assert.rejects(provider.scrape(target), { code: "not_found" });
  response = () => Response.json(success(), { status: 403 });
  await assert.rejects(provider.scrape(target), { code: "provider_auth" });
  response = () =>
    Response.json(
      { code: "ERR::SCRAPE::BALANCE_REQUIRED_FOR_EXTRA" },
      { status: 429 },
    );
  await assert.rejects(provider.scrape(target), { code: "provider_credit" });
  assert.equal(request.mock.callCount(), 7);
});

test("Scrapfly retries a temporary failure once and respects retry headers", async (t) => {
  let retryable = "true";
  let retryAfter = "0";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json(
      {},
      {
        status: 503,
        headers: {
          "Retry-After": retryAfter,
          "X-Scrapfly-Reject-Retryable": retryable,
        },
      },
    );
  });
  const provider = staticFirstScrape("fake-key");
  const first = options();
  await assert.rejects(provider.scrape(target, undefined, first), {
    code: "provider_down",
  });
  assert.deepEqual(first.tried, ["datacenter", "datacenter"]);
  retryable = "false";
  await assert.rejects(provider.scrape(target), { code: "provider_down" });
  retryable = "true";
  retryAfter = "90";
  await assert.rejects(
    provider.scrape(target, undefined, {
      ...options(),
      deadline: performance.now() + 54_000,
    }),
    { code: "provider_down" },
  );
  assert.equal(calls, 4);
});

test("menu pages escalate while cookie notice text is returned", async (t) => {
  const menu = Array.from(
    { length: 30 },
    (_, i) =>
      `[Read related stories for topic ${i}](https://example.com/topic/${i})`,
  ).join("\n");
  let content = menu;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(success(content)),
  );
  const provider = staticFirstScrape("fake-key");
  const first = options();
  const result = await provider.scrape(target, undefined, first);
  assert.equal(result.check.code, "menus_only");
  assert.equal(result.check.warning, true);
  // Rendering is tried in the same call, and it is the last rung of this ladder.
  assert.equal(result.hint, undefined);
  assert.deepEqual(first.tried, ["datacenter", "render"]);

  content =
    "# Cookie preferences\nWe use cookies to improve your browsing experience.\nAccept all cookies";
  const second = options();
  const notice = await provider.scrape(target, undefined, second);
  assert.equal(notice.check.code, "ok");
  assert.equal(notice.markdown, content);
  assert.equal(second.tried.length, 1);
});

test("a per-request budget rejection escalates but insufficient account credit stops", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  let code = "ERR::SCRAPE::COST_BUDGET_LIMIT";
  const request = t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {},
      { status: 422, headers: { "X-Scrapfly-Reject-Code": code } },
    ),
  );
  const budget = options();
  await assert.rejects(
    staticFirstScrape("fixture").scrape(target, undefined, budget),
    {
      code: "provider_cost_budget",
      details: { tried: ["datacenter", "render"] },
    },
  );
  assert.deepEqual(budget.tried, ["datacenter", "render"]);
  assert.equal(
    JSON.parse(String(log.mock.calls[0]!.arguments[0])).datacenterBlocked,
    false,
  );
  code = "ERR::SCRAPE::BALANCE_REQUIRED_FOR_EXTRA";
  await assert.rejects(staticFirstScrape("fixture").scrape(target), {
    code: "provider_credit",
  });
  assert.equal(request.mock.callCount(), 3);
});

test("the real tool deadline prevents an unfunded retry", async (t) => {
  const request = t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.searchParams.get("timeout"), "30000");
    return Response.json({}, { status: 503, headers: { "Retry-After": "6" } });
  });
  const deadline = performance.now() + 38_000;
  await assert.rejects(
    staticFirstScrape("fixture").scrape(target, undefined, {
      deadline,
      tried: [],
    }),
    { code: "provider_down" },
  );
  assert.equal(request.mock.callCount(), 1);
});

test("escalation stops with the stronger rung hint if its minimum cannot fit", async (t) => {
  let now = 1_000;
  t.mock.method(performance, "now", () => now);
  const request = t.mock.method(globalThis, "fetch", async () => {
    now += 3_000;
    return Response.json(success("# Access denied", target, 403));
  });
  const deadline = performance.now() + 35_000;
  await assert.rejects(
    staticFirstScrape("fixture").scrape(target, undefined, {
      deadline,
      tried: [],
    }),
    {
      code: "stronger_rung_required",
      details: {
        tried: ["datacenter"],
        credits: 1,
        hint: messages.page.retryRung("render"),
        retryRung: "render",
      },
    },
  );
  assert.equal(request.mock.callCount(), 1);
});

test("deferred escalation returns a usable warning and the next rung", async (t) => {
  const menu = Array.from(
    { length: 30 },
    (_, i) =>
      `[Read related stories for topic ${i}](https://example.com/topic/${i})`,
  ).join("\n");
  let now = 1_000;
  t.mock.method(performance, "now", () => now);
  const request = t.mock.method(globalThis, "fetch", async () => {
    now += 3_000;
    return Response.json(success(menu));
  });
  const result = await staticFirstScrape("fixture").scrape(target, undefined, {
    tried: [],
    deadline: performance.now() + 35_000,
  });
  assert.equal(result.markdown, menu);
  assert.equal(result.check.code, "menus_only");
  assert.equal(result.check.warning, true);
  assert.equal(result.hint, messages.page.retryRung("render"));
  assert.equal(result.retryRung, "render");
  assert.equal(request.mock.callCount(), 1);
});

test("each Scrapfly rung must obtain its own provider permit", async (t) => {
  const request = t.mock.method(globalThis, "fetch", async () =>
    Response.json(success("# Access denied", target, 403)),
  );
  const settings = {
    ...defaults,
    localLimitWaitMs: 0,
    siteGapMs: 0,
    scrapflyBurstCapacity: 1,
  };
  const provider = staticFirstScrape(
    "fake-key",
    settings,
    new RequestLimits(settings),
  );
  const first = options();
  await assert.rejects(provider.scrape(target, undefined, first), {
    code: "local_rate_limit",
  });
  assert.deepEqual(first.tried, ["datacenter"]);
  assert.equal(request.mock.callCount(), 1);
});

test("Scrapfly halts after a reported budget overrun and validates failed redirect chains", async (t) => {
  let unsafe = false;
  const request = t.mock.method(globalThis, "fetch", async () =>
    unsafe
      ? Response.json(
          {
            context: {
              redirects: [{ url: target, location: "http://169.254.169.254/" }],
            },
          },
          { status: 500 },
        )
      : Response.json({
          ...success("# Access denied", target, 403),
          context: { cost: 101 },
        }),
  );
  const provider = staticFirstScrape(
    "fixture",
    defaults,
    undefined,
    undefined,
    new FileHosts([], fileState(t)),
  );
  await assert.rejects(provider.scrape(target), {
    code: "provider_cost_overrun",
  });
  assert.equal(request.mock.callCount(), 1);
  unsafe = true;
  await assert.rejects(
    provider.scrape(target, undefined, { tried: [], allowHigherCost: true }),
    { code: "unsafe_url" },
  );
  assert.equal(request.mock.callCount(), 2);
});

test("full mode renders title-only Scrapfly Markdown with or without a heading", async (t) => {
  let shell = "@bsky.app on Bluesky";
  const request = t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.searchParams.has("country"), false);
    const fixture = success(url.searchParams.has("render_js") ? body : shell);
    return Response.json({
      ...fixture,
      result: { ...fixture.result, content_type: "text/html; charset=UTF-8" },
    });
  });
  for (const title of ["@bsky.app on Bluesky", "# @bsky.app on Bluesky"]) {
    shell = title;
    const tried: string[] = [];
    const result = await staticFirstScrape("fixture", {
      ...defaults,
      scrapflyCountry: null,
    }).scrape(target, undefined, { tried, contentMode: "full" });
    assert.equal(result.check.code, "ok");
    assert.deepEqual(tried, ["datacenter", "render"]);
  }
  assert.equal(request.mock.callCount(), 4);
});

test("the provider's HTTP 504 is identified separately from a local deadline", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {},
      {
        status: 504,
        headers: {
          "X-Scrapfly-Reject-Code": "ERR::SCRAPE::OPERATION_TIMEOUT",
          "X-Scrapfly-Reject-Retryable": "false",
        },
      },
    ),
  );
  await assert.rejects(staticFirstScrape("fixture").scrape(target), {
    code: "provider_down",
    message: "Scrapfly returned an upstream operation timeout.",
  });
});

const pdf = Buffer.from("%PDF-1.7 fixture");
const pdfUrl = "https://8.8.8.8/pdf/1234.5678";

function binaryFixture(
  url: string,
  bytes = pdf,
  credits = 1,
  type = "application/pdf",
) {
  return {
    context: { cost: { total: credits } },
    result: {
      ...success(bytes.toString("base64"), url).result,
      format: "binary",
      response_headers: {
        "content-type": type,
        "content-length": String(bytes.length),
      },
    },
  };
}

test("datacenter HEAD gates files by headers before paying for a download", async (t) => {
  let size: string | undefined = "5000001";
  const methods: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    methods.push(init.method!);
    assert.equal(url.searchParams.get("proxy_pool"), "public_datacenter_pool");
    assert.equal(url.searchParams.get("cost_budget"), "100");
    assert.equal(url.searchParams.has("unblocker"), false);
    assert.equal(url.searchParams.get("timeout"), "15000");
    assert.equal(url.searchParams.has("render_js"), false);
    if (init.method === "HEAD")
      return new Response(null, {
        headers: {
          "content-type": "application/pdf; qs=0.001",
          ...(size ? { "content-length": size } : {}),
          "x-scrapfly-api-cost": "1",
        },
      });
    return Response.json(binaryFixture(url.searchParams.get("url")!));
  });
  const provider = scrapflyScrape("fixture", {
    ...defaults,
    scrapflyDatacenterPool: "public_residential_pool",
  });
  await assert.rejects(provider.scrape(pdfUrl), {
    code: "file_refused",
    message: /application\/pdf, 5000001 bytes.*exceeds 5 MB/,
  });
  size = undefined;
  await assert.rejects(provider.scrape("https://8.8.8.8/document.PDF"), {
    code: "file_refused",
    message: /application\/pdf, unknown size.*content length/,
  });
  size = String(pdf.length);
  await assert.rejects(
    provider.scrape(pdfUrl, undefined, { start: "render", tried: [] }),
    {
      code: "file_refused",
      message: /application\/pdf, 16 bytes.*only on datacenter/,
    },
  );
  assert.deepEqual(methods, ["HEAD", "HEAD", "HEAD"]);
  size = "5000000";
  const result = await provider.scrape(pdfUrl);
  assert.deepEqual(result.binary, {
    bytes: pdf,
    mimeType: "application/pdf",
    extension: "pdf",
  });
  assert.equal(result.credits, 2);
  assert.deepEqual(methods.slice(3), ["HEAD", "GET"]);
});

test("preflighted files refuse a challenge or an HTML body disguised as PDF", async (t) => {
  let challenge = true;
  const html = Buffer.from("<!doctype html><title>Upstream error</title>");
  const request = t.mock.method(
    globalThis,
    "fetch",
    async (url: URL, init: RequestInit) => {
      assert.equal(url.searchParams.has("unblocker"), false);
      if (init.method === "HEAD")
        return new Response(null, {
          headers: {
            "content-type": "application/pdf",
            "content-length": "44",
          },
        });
      return challenge
        ? Response.json(success("# Access denied", pdfUrl, 403))
        : Response.json(binaryFixture(pdfUrl, html));
    },
  );
  const provider = staticFirstScrape("fixture");
  await assert.rejects(provider.scrape(pdfUrl), {
    code: "file_refused",
    message: /application\/pdf, 44 bytes.*datacenter/,
  });
  challenge = false;
  await assert.rejects(provider.scrape(pdfUrl), {
    code: "binary_download",
    message: /contains HTML/,
  });
  assert.equal(request.mock.callCount(), 4);
});

test("an unexpected paid file is kept and its host gets HEAD on the next URL after restart", async (t) => {
  const state = fileState(t);
  const methods: string[] = [];
  const page = "https://8.8.8.8/other-page";
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    methods.push(init.method!);
    const upstream = url.searchParams.get("url")!;
    if (init.method === "HEAD")
      return new Response(null, { headers: { "content-type": "text/html" } });
    return Response.json(
      upstream === target
        ? binaryFixture(target, pdf, 37, "application/octet-stream")
        : success(body, upstream),
    );
  });
  const provider = staticFirstScrape(
    "fixture",
    defaults,
    undefined,
    undefined,
    new FileHosts([], state),
  );
  const result = await provider.scrape(target);
  assert.deepEqual(result.binary, {
    bytes: pdf,
    mimeType: "application/pdf",
    extension: "pdf",
  });
  assert.equal(result.credits, 37);
  assert.equal(result.costWarning, undefined);
  const hosts = new FileHosts(["1.1.1.1"], state);
  assert.deepEqual([...hosts.list()], ["1.1.1.1", "8.8.8.8"]);
  const restarted = staticFirstScrape(
    "fixture",
    defaults,
    undefined,
    undefined,
    hosts,
  );
  assert.equal(
    (
      await restarted.scrape(page, undefined, {
        tried: [],
        allowHigherCost: true,
      })
    ).check.code,
    "ok",
  );
  assert.equal((await restarted.scrape(redirected)).check.code, "ok");
  assert.deepEqual(methods, ["GET", "HEAD", "GET", "HEAD", "GET"]);
});

test("Scrapfly BLOB refusal reports original scrape cost without fetching the object", async (t) => {
  const request = t.mock.method(
    globalThis,
    "fetch",
    async (url: URL, init: RequestInit) => {
      assert.equal(url.pathname, "/scrape");
      if (init.method === "HEAD")
        return new Response(null, {
          headers: {
            "content-type": "application/pdf",
            "content-length": "5000000",
          },
        });
      const fixture = binaryFixture(pdfUrl, pdf, 123);
      return Response.json({
        ...fixture,
        result: {
          ...fixture.result,
          format: "blob",
          content: "https://api.scrapfly.io/object",
          response_headers: {
            "content-type": "application/pdf",
            "content-length": "5100000",
          },
        },
      });
    },
  );
  await assert.rejects(
    staticFirstScrape(
      "fixture",
      defaults,
      undefined,
      undefined,
      new FileHosts([], fileState(t)),
    ).scrape(pdfUrl),
    {
      code: "file_refused",
      message: /application\/pdf, 5100000 bytes.*BLOB.*123 credits/,
    },
  );
  assert.equal(request.mock.callCount(), 2);
});

test("the recorded private redirect error stops before stronger rungs", async (t) => {
  const requested =
    "https://8.8.8.8/redirect-to?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F";
  const echoed =
    "https://8.8.8.8/short-link?url=http://169.254.169.254/latest/meta-data/";
  let missingResult = false;
  const request = t.mock.method(globalThis, "fetch", async () =>
    missingResult
      ? Response.json(
          { result: null },
          {
            status: 422,
            headers: {
              "X-Scrapfly-Reject-Code": "ERR::SCRAPE::UPSTREAM_WEBSITE_ERROR",
            },
          },
        )
      : Response.json(
          {
            context: { cost: { total: 0 }, redirects: [] },
            result: {
              ...success("", echoed, 403).result,
              error: {
                code: "ERR::SCRAPE::BAD_UPSTREAM_RESPONSE",
                message: `The scrapped url: ${echoed} respond with 403 - Forbidden:`,
              },
            },
          },
          {
            headers: {
              "X-Scrapfly-Reject-Code": "ERR::SCRAPE::BAD_UPSTREAM_RESPONSE",
            },
          },
        ),
  );
  const provider = staticFirstScrape("fixture");
  await assert.rejects(
    provider.scrape(requested.replace("/redirect-to", "/short-link")),
    {
      code: "unsafe_url",
    },
  );
  missingResult = true;
  await assert.rejects(provider.scrape(requested), { code: "unsafe_url" });
  assert.equal(request.mock.callCount(), 2);
});

test("three charges of 100 or more require opt-in after restart", async (t) => {
  const state = fileState(t);
  const log = state + ".jsonl";
  const previousLog = process.env.MCP_STATS_LOG;
  process.env.MCP_STATS_LOG = log;
  t.after(() => {
    if (previousLog === undefined) delete process.env.MCP_STATS_LOG;
    else process.env.MCP_STATS_LOG = previousLog;
  });
  let charge = 99;
  const breakdown = {
    details: [
      {
        amount: 25,
        code: "PROXY_RESIDENTIAL_NETWORK",
        description: "Proxy Network (Residential)",
      },
    ],
  };
  const fetch = t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.searchParams.get("proxy_pool"), "public_datacenter_pool");
    assert.equal(
      url.searchParams.get("cost_budget"),
      fetch.mock.callCount() < 4 ? "100" : "200",
    );
    return Response.json(
      {
        ...success(),
        context: {
          proxy: {
            pool: "public_residential_pool_ix",
            identity: "private proxy identity",
          },
          cost: charge === 101 ? undefined : { ...breakdown, total: charge },
        },
      },
      {
        headers: {
          "X-Scrapfly-Api-Cost": String(charge),
          "X-Scrapfly-Remaining-Api-Credit": "197187",
        },
      },
    );
  });
  const provider = () =>
    staticFirstScrape(
      "fixture",
      defaults,
      undefined,
      undefined,
      new FileHosts([], state),
    );
  for (charge of [100, 99, 101, 100]) {
    const result = await provider().scrape(target);
    assert.equal(result.credits, charge);
    assert.equal(Boolean(result.costWarning), charge > 100);
  }
  const restarted = provider();
  await assert.rejects(restarted.scrape(target), {
    code: "provider_cost_opt_in_required",
    message: /101 credits.*allow_higher_cost/,
    details: { expectedCredits: 101 },
  });
  assert.equal(fetch.mock.callCount(), 4);
  const optedIn = await restarted.scrape(target, undefined, {
    tried: [],
    allowHigherCost: true,
  });
  assert.equal(optedIn.credits, 100);
  assert.equal(fetch.mock.callCount(), 5);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 5);
  for (const [index, line] of lines.entries()) {
    const row = JSON.parse(line);
    assert.equal(row.credits, [100, 99, 101, 100, 100][index]);
    assert.equal(row.remainingCredits, 197187);
    assert.equal(row.requestedProxyPool, "public_datacenter_pool");
    assert.equal(row.proxyPool, "public_residential_pool_ix");
    assert.equal(row.host, "8.8.8.8");
    assert.equal(row.url, target);
    assert.deepEqual(
      row.costBreakdown,
      row.credits === 101 ? null : { ...breakdown, total: row.credits },
    );
    assert.doesNotMatch(line, /private proxy identity/);
  }
});

test("a pool rejection is terminal but does not record an unverified price", async (t) => {
  const code = "ERR::PROXY::POOL_NOT_AVAILABLE_FOR_TARGET";
  const state = fileState(t);
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ result: { error: { code } } }, { status: 422 }),
  );
  const provider = staticFirstScrape(
    "fixture",
    defaults,
    undefined,
    undefined,
    new FileHosts([], state),
  );
  await assert.rejects(provider.scrape(target), {
    code: "provider_proxy_pool",
    message: /POOL_NOT_AVAILABLE_FOR_TARGET.*residential.*25 credits/,
  });
  await assert.rejects(provider.scrape(target), {
    code: "provider_proxy_pool",
    message: /POOL_NOT_AVAILABLE_FOR_TARGET/,
  });
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(new FileHosts([], state).list().size, 0);
});

test("provider 429 logs unknown cost and prevents new calls during Retry-After", async (t) => {
  const state = fileState(t);
  const log = state + ".jsonl";
  const previousLog = process.env.MCP_STATS_LOG;
  process.env.MCP_STATS_LOG = log;
  t.after(() => {
    if (previousLog === undefined) delete process.env.MCP_STATS_LOG;
    else process.env.MCP_STATS_LOG = previousLog;
  });
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  let limited = true;
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    limited
      ? new Response(null, { status: 429, headers: { "Retry-After": "30" } })
      : Response.json({ result: success().result }),
  );
  const provider = staticFirstScrape(
    "fixture",
    defaults,
    undefined,
    undefined,
    new FileHosts([], state),
  );
  const retryAt = new Date(now + 30_000).toISOString();
  await assert.rejects(provider.scrape(target), {
    code: "provider_rate",
    message: messages.service.busy,
    details: { retryAt, tried: ["datacenter"] },
  });
  now += 2000;
  await assert.rejects(provider.scrape(redirected), {
    code: "provider_rate",
    message: messages.service.busy,
    details: { retryAt },
  });
  assert.equal(fetch.mock.callCount(), 1);
  now += 28000;
  limited = false;
  assert.equal((await provider.scrape(target)).check.code, "ok");
  const rows = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    rows.map((row) => row.providerStatus),
    [429, 200],
  );
  for (const row of rows) {
    assert.equal(row.credits, null);
    assert.equal(row.costBreakdown, null);
    assert.equal(row.remainingCredits, null);
    assert.equal(row.proxyPool, null);
  }
});

const article = `<!doctype html><html><head><title>Weather station report</title></head><body>
<nav>Sitewide navigation marker</nav>
<main><article><h1>Weather station report</h1>
<p>The weather station recorded a steady increase in wind speed throughout the afternoon. Read the <a href="details">station notes</a> for the complete observations.</p>
<p>Measurements were recorded every ten minutes and checked for consistency before being published in this report.</p>
<img src="station.jpg" alt="Station photo"></article></main>
<footer>Sitewide footer marker</footer></body></html>`;

function htmlResponse(content: string, url = target, format = "raw") {
  const fixture = success(content, url);
  return Response.json({
    ...fixture,
    result: {
      ...fixture.result,
      format,
      content_type: "text/html; charset=UTF-8",
    },
  });
}

test("default and explicit full mode request different formats, including raw HTML clob", async (t) => {
  const formats: string[] = [];
  const whole =
    "# Weather station report\n\nSitewide navigation marker\n\nWhole-page Markdown from Scrapfly.";
  const clob = "https://api.scrapfly.io/object";
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.pathname === "/object") return new Response(article);
    assert.equal(url.pathname, "/scrape");
    const format = url.searchParams.get("format");
    formats.push(format!);
    return format === "raw"
      ? htmlResponse(clob, "https://1.1.1.1/archive/article", "clob")
      : htmlResponse(whole, target, "markdown");
  });
  const provider = staticFirstScrape("fixture");
  const main = await provider.scrape(target);
  assert.equal(main.check.code, "ok");
  assert.equal(main.extraction, undefined);
  assert.match(main.markdown, /recorded a steady increase/);
  assert.match(
    main.markdown,
    /\[station notes\]\(https:\/\/1\.1\.1\.1\/archive\/details\)/,
  );
  assert.doesNotMatch(main.markdown, /Sitewide|station\.jpg/);
  const full = await provider.scrape(target, undefined, {
    tried: [],
    contentMode: "full",
  });
  assert.equal(full.markdown, whole);
  assert.deepEqual(formats, ["raw", "markdown:no_images"]);
});

test("a challenge in the original HTML cannot become a successful extraction", async (t) => {
  const formats: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    formats.push(url.searchParams.get("format")!);
    return htmlResponse(
      formats.length > 1
        ? article
        : article.replace(
            "<title>Weather station report</title>",
            "<title>Just a moment...</title>",
          ),
    );
  });
  const tried: string[] = [];
  const result = await staticFirstScrape("fixture").scrape(target, undefined, {
    tried,
  });
  assert.equal(result.check.code, "ok");
  assert.deepEqual(tried, ["datacenter", "render"]);
  assert.deepEqual(formats, ["raw", "raw"]);
});

test("empty main extraction recovers text from the same HTML without a second request", async (t) => {
  const request = t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.searchParams.get("format"), "raw");
    return htmlResponse(
      "<html><head><title>Weather report</title></head><body><aside>" +
        "<p>The weather station recorded a steady increase in rainfall over the last five days.</p>" +
        "</aside></body></html>",
    );
  });
  const result = await staticFirstScrape("fixture").scrape(target);
  assert.equal(result.check.code, "ok");
  assert.match(result.markdown, /recorded a steady increase/);
  assert.equal(request.mock.callCount(), 1);
});

test("empty extraction retries once and retains original HTML if rendering also fails", async (t) => {
  const file = fileState(t);
  const usage = new Usage(defaults, file);
  const html = "<html><head></head><body><img src='station.jpg'></body></html>";
  const request = t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.searchParams.get("format"), "raw");
    return htmlResponse(html);
  });
  const provider = staticFirstScrape("fixture", defaults, undefined, usage);
  const tried: string[] = [];
  const result = await provider.scrape(target, undefined, { tried });
  assert.equal(result.markdown, "");
  assert.deepEqual(result.extraction, { cause: "unusable_output", html });
  assert.equal(result.check.code, "extraction_failed");
  assert.deepEqual(tried, ["datacenter", "render"]);
  assert.equal(request.mock.callCount(), 2);
  assert.equal(result.credits, 2);
  assert.equal(todayUsage(file).scrapflyCredits, 2);
});

test("transient target failures escalate at 100 credits and stop above 100", async (t) => {
  let status = 503;
  let charge = 100;
  let firstAttempt = true;
  const request = t.mock.method(globalThis, "fetch", async () => {
    const first = firstAttempt;
    firstAttempt = false;
    return Response.json(
      !first
        ? success()
        : {
            ...success("Try again later.", target, status),
            context: { cost: charge },
          },
    );
  });
  for (const code of [503, 429]) {
    status = code;
    firstAttempt = true;
    const tried: string[] = [];
    const provider = staticFirstScrape(
      "fixture",
      defaults,
      undefined,
      undefined,
      new FileHosts([], fileState(t)),
    );
    const result = await provider.scrape(target, undefined, { tried });
    assert.equal(result.check.code, "ok");
    assert.deepEqual(tried, ["datacenter", "datacenter"]);
  }
  const provider = staticFirstScrape(
    "fixture",
    defaults,
    undefined,
    undefined,
    new FileHosts([], fileState(t)),
  );
  charge = 101;
  firstAttempt = true;
  await assert.rejects(provider.scrape(target), {
    code: "provider_cost_overrun",
  });
  assert.equal(request.mock.callCount(), 5);
  charge = 0;
  firstAttempt = true;
  status = 400;
  await assert.rejects(provider.scrape(target), { code: "target_http" });
  assert.equal(request.mock.callCount(), 6);
});

test("an unresolved link-only extraction preserves partial Markdown and fallback text", async (t) => {
  const html =
    '<html><title>Quotes</title><body><header><h1>Quotes</h1></header><main><a href="/login">Login</a></main><footer>Copyright belongs to this site.</footer></body></html>';
  const request = t.mock.method(globalThis, "fetch", async () =>
    htmlResponse(html),
  );
  const tried: string[] = [];
  const result = await staticFirstScrape("fixture").scrape(target, undefined, {
    tried,
  });
  assert.deepEqual(tried, ["datacenter", "render"]);
  assert.equal(request.mock.callCount(), 2);
  assert.deepEqual(result.extraction, {
    cause: "unusable_output",
    html,
    fallbackText: "Quotes",
  });
  assert.match(result.markdown, /\[Login\]/);
  assert.equal(result.hint, undefined);
});

test("legacy cost notices preserve file hosts without counting as observations", (t) => {
  const state = fileState(t);
  writeFileSync(
    state,
    JSON.stringify({
      host: "8.8.8.8",
      expectedCredits: 125,
      reason: "legacy cost notice",
      file: true,
    }) + "\n",
    { mode: 0o600 },
  );
  const hosts = new FileHosts([], state);
  assert.equal(hosts.list().has("8.8.8.8"), true);
  hosts.observeCost("8.8.8.8", 100);
  hosts.observeCost("8.8.8.8", 100);
  assert.equal(hosts.read().costs.size, 0);
  hosts.observeCost("8.8.8.8", 100);
  const flagged = hosts.read().costs.get("8.8.8.8");
  assert.deepEqual(flagged, { expectedCredits: 100, observations: 3 });
  const recorded = readFileSync(state, "utf8");
  hosts.observeCost("8.8.8.8", 150);
  hosts.observeCost("1.1.1.1", Number.NaN);
  assert.equal(readFileSync(state, "utf8"), recorded);
});

test("one charge far over budget is enough to require opt-in for the host", (t) => {
  const hosts = new FileHosts([], fileState(t));
  hosts.observeCost("8.8.8.8", 120);
  assert.equal(hosts.read().costs.size, 0);
  hosts.observeCost("9.9.9.9", 402);
  assert.deepEqual(hosts.read().costs.get("9.9.9.9"), {
    expectedCredits: 402,
    observations: 1,
  });
  assert.equal(hosts.read().costs.has("8.8.8.8"), false);
});

test("a site's own start applies only when the caller does not choose one", async (t) => {
  const { Resolver } = await import("node:dns/promises");
  t.mock.method(Resolver.prototype, "resolve4", async () => ["8.8.8.8"]);
  t.mock.method(Resolver.prototype, "resolve6", async () => []);
  const log = t.mock.method(console, "log", () => {});
  let blocked = false;
  t.mock.method(globalThis, "fetch", async (endpoint: URL) => {
    const url = endpoint.searchParams.get("url")!;
    return blocked && !endpoint.searchParams.has("render_js")
      ? Response.json(success("# Access denied", url, 403))
      : htmlResponse(
          "<html><body><main><p>The weather station recorded a steady increase in rainfall over the last five days.</p></main></body></html>",
          url,
        );
  });
  const provider = () =>
    scrapflyScrape(
      "fixture",
      defaults,
      undefined,
      undefined,
      new FileHosts([], fileState(t)),
    );
  for (const [url, start, expected] of [
    ["https://www.linkedin.com/in/example/", undefined, ["datacenter"]],
    ["https://www.linkedin.com/in/example/", "render", ["render"]],
    ["https://www.example.org/", undefined, ["render"]],
  ] as const) {
    const tried: string[] = [];
    await provider().scrape(url, undefined, { tried, start });
    assert.deepEqual(tried, expected);
  }
  // A blocked static fetch moves on to rendering within the same call.
  blocked = true;
  const tried: string[] = [];
  const result = await provider().scrape(
    "https://www.linkedin.com/company/example/",
    undefined,
    { tried },
  );
  assert.equal(result.check.code, "ok");
  assert.deepEqual(tried, ["datacenter", "render"]);
  const sources = log.mock.calls
    .map(({ arguments: [line] }) => JSON.parse(String(line)))
    .filter((row) => row.event === "provider_attempt")
    .map((row) => row.startSource);
  assert.deepEqual(sources, ["site", "caller", "default", "site", "site"]);
});

test("a daily credit cap stops new scrapes once it is reached", async (t) => {
  const file = fileState(t).replace("file-hosts.txt", "usage.json");
  const settings = { ...defaults, scrapflyDailyCredits: 30 };
  const usage = new Usage(settings, file);
  const request = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ ...success(), context: { cost: 30 } }),
  );
  const provider = scrapflyScrape(
    "fixture",
    settings,
    undefined,
    usage,
    new FileHosts([], fileState(t)),
  );
  await provider.scrape(target);
  await assert.rejects(provider.scrape(target), {
    code: "local_credit_limit",
    message: /credit cap \(30\)/,
  });
  assert.equal(request.mock.callCount(), 1);
});

test("Reddit page requests use residential and render by default", async (t) => {
  const { Resolver } = await import("node:dns/promises");
  t.mock.method(Resolver.prototype, "resolve4", async () => ["8.8.8.8"]);
  t.mock.method(Resolver.prototype, "resolve6", async () => []);
  const renders: boolean[] = [];
  let html =
    "<html><body><main><p>The weather station recorded a steady increase in rainfall over the last five days.</p></main></body></html>";
  const request = t.mock.method(globalThis, "fetch", async (endpoint: URL) => {
    renders.push(endpoint.searchParams.get("render_js") === "true");
    assert.equal(
      endpoint.searchParams.get("proxy_pool"),
      "public_residential_pool",
    );
    return htmlResponse(html, endpoint.searchParams.get("url")!);
  });
  const provider = scrapflyScrape(
    "fixture",
    defaults,
    undefined,
    undefined,
    new FileHosts([], fileState(t)),
  );
  for (const [url, start, expected] of [
    ["https://www.reddit.com/r/example/", undefined, "render"],
    ["https://www.reddit.com/r/example/", "datacenter", "datacenter"],
    ["https://redd.it/abc", "render", "render"],
  ] as const) {
    const tried: string[] = [];
    const result = await provider.scrape(url, undefined, { tried, start });
    assert.equal(result.check.code, "ok");
    assert.deepEqual(tried, [expected]);
  }
  html = "<html><body><img src='station.jpg'></body></html>";
  const opts = options();
  const partial = await provider.scrape(
    "https://www.reddit.com/r/example/comments/abc/",
    undefined,
    opts,
  );
  assert.equal(partial.check.code, "extraction_failed");
  assert.equal(partial.retryRung, undefined);
  assert.equal(partial.retryHigherCost, undefined);
  assert.deepEqual(opts.tried, ["render"]);
  assert.equal(request.mock.callCount(), 4);
  assert.deepEqual(renders, [true, false, true, true]);
});

test("an extraction retry can recover content or require higher-cost opt-in", async (t) => {
  let rejectBudget = false;
  t.mock.method(globalThis, "fetch", async (endpoint: URL) => {
    assert.equal(endpoint.searchParams.get("cost_budget"), "100");
    assert.equal(endpoint.searchParams.get("render_js"), "true");
    if (endpoint.searchParams.get("proxy_pool") === "public_datacenter_pool")
      return htmlResponse("<html><body><img src='station.jpg'></body></html>");
    if (rejectBudget)
      return Response.json(
        {},
        {
          status: 422,
          headers: {
            "X-Scrapfly-Reject-Code": "ERR::SCRAPE::COST_BUDGET_LIMIT",
          },
        },
      );
    return htmlResponse(
      "<html><body><main><p>The weather station recorded a steady increase in rainfall over the last five days.</p></main></body></html>",
    );
  });
  const provider = scrapflyScrape(
    "fixture",
    defaults,
    undefined,
    undefined,
    new FileHosts([], fileState(t)),
  );
  const first = options();
  const recovered = await provider.scrape(target, undefined, first);
  assert.equal(recovered.check.code, "ok");
  assert.match(recovered.markdown, /steady increase/);
  assert.deepEqual(first.tried, ["render", "residential_render"]);

  rejectBudget = true;
  const second = options();
  const partial = await provider.scrape(target, undefined, second);
  assert.equal(partial.check.code, "extraction_failed");
  assert.equal(partial.retryRung, "residential_render");
  assert.equal(partial.retryHigherCost, true);
  assert.deepEqual(second.tried, ["render", "residential_render"]);
});

test("default rendering retries transient target responses once on the same rung", async (t) => {
  let statuses: number[] = [];
  const request = t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.searchParams.get("render_js"), "true");
    assert.equal(url.searchParams.get("proxy_pool"), "public_datacenter_pool");
    const status = statuses.shift()!;
    return Response.json(
      success(status === 200 ? body : "Try again later.", target, status),
    );
  });
  const provider = scrapflyScrape(
    "fixture",
    defaults,
    undefined,
    undefined,
    new FileHosts([], fileState(t)),
  );
  for (const status of [503, 429]) {
    statuses = [status, 200];
    const opts = options();
    assert.equal(
      (await provider.scrape(target, undefined, opts)).check.code,
      "ok",
    );
    assert.deepEqual(opts.tried, ["render", "render"]);
  }
  statuses = [503, 503];
  const opts = options();
  await assert.rejects(provider.scrape(target, undefined, opts), {
    code: "target_http",
  });
  assert.deepEqual(opts.tried, ["render", "render"]);
  assert.equal(request.mock.callCount(), 6);
});

test("default rendering skips residential escalation when Scrapfly already used it", async (t) => {
  let includePool = true;
  const request = t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.searchParams.get("proxy_pool"), "public_datacenter_pool");
    assert.equal(url.searchParams.get("render_js"), "true");
    const content = "<html><body><img src='station.jpg'></body></html>";
    const { result } = success(content);
    return Response.json({
      result: { ...result, content_type: "text/html" },
      context: includePool
        ? { proxy: { pool: "public_residential_pool_ix" }, cost: 30 }
        : {
            cost: {
              total: 30,
              details: [{ code: "PROXY_RESIDENTIAL_NETWORK", amount: 25 }],
            },
          },
    });
  });
  const provider = scrapflyScrape(
    "fixture",
    defaults,
    undefined,
    undefined,
    new FileHosts([], fileState(t)),
  );
  for (const reportedPool of [true, false]) {
    includePool = reportedPool;
    const opts = options();
    const result = await provider.scrape(target, undefined, opts);
    assert.equal(result.check.code, "extraction_failed");
    assert.equal(result.credits, 30);
    assert.equal(result.retryRung, undefined);
    assert.deepEqual(opts.tried, ["render"]);
  }
  assert.equal(request.mock.callCount(), 2);
});
