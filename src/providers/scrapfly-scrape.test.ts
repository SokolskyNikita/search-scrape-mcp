import assert from "node:assert/strict";
import { test } from "node:test";
import { defaults } from "../config/tuning.js";
import { RequestLimits } from "../server/request-limits.js";
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
  const provider = scrapflyScrape("fake-key");
  const result = await provider.scrape(target);
  assert.equal(result.markdown, "# An article\n\nPublic content.");
  content = "https://example.com/object";
  await assert.rejects(provider.scrape(target), { code: "provider_response" });
  format = "blob";
  await assert.rejects(provider.scrape(target), { code: "binary_download" });
  assert.equal(downloads, 1);
});

test("Scrapfly treats retryable Unblocker timeouts as transient failures", async (t) => {
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
    scrapflyScrape("fake-key").scrape(target, undefined, {
      start: "unblocker",
      tried,
    }),
    { code: "provider_down" },
  );
  assert.deepEqual(tried, ["unblocker", "unblocker"]);
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
    assert.equal(
      input.searchParams.get("proxy_pool"),
      "public_datacenter_pool",
    );
    assert.equal(init.redirect, "error");
    const rung = input.searchParams.has("render_js")
      ? "render"
      : input.searchParams.has("unblocker")
        ? "unblocker"
        : "datacenter";
    assert.equal(
      input.searchParams.get("cost_budget"),
      { datacenter: "5", unblocker: "85", render: "40" }[rung],
    );
    assert.equal(
      input.searchParams.get("timeout"),
      { datacenter: "15000", unblocker: "30000", render: "30000" }[rung],
    );
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
  const provider = scrapflyScrape("fake-key");
  await assert.rejects(provider.scrape("http://127.0.0.1/"), {
    code: "unsafe_url",
  });
  const first = options();
  const result = await provider.scrape(target + "#heading", undefined, first);
  assert.equal(result.markdown, "# An article\n\nPublic content.");
  assert.deepEqual(first.tried, ["datacenter", "unblocker"]);
  mode = "shell";
  await assert.rejects(provider.scrape(target), {
    details: { tried: ["unblocker"], hint: 'Retry with start_rung: "render".' },
  });
  const next: ScrapeOptions = { start: "render", tried: [] };
  await provider.scrape(target, undefined, next);
  assert.deepEqual(next.tried, ["render"]);
  mode = "missing";
  await assert.rejects(provider.scrape(target), {
    code: "not_found",
    details: { tried: ["render"], hint: undefined },
  });
  mode = "ok";
  await provider.scrape(target);
  assert.deepEqual(observed, [
    "datacenter",
    "unblocker",
    "unblocker",
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
  const provider = scrapflyScrape("fake-key");
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
  const provider = scrapflyScrape("fake-key");
  const first = options();
  await assert.rejects(provider.scrape(target, undefined, first), {
    code: "provider_down",
  });
  assert.deepEqual(first.tried, ["datacenter", "datacenter"]);
  retryable = "false";
  await assert.rejects(provider.scrape(target), { code: "provider_down" });
  retryable = "true";
  retryAfter = "90";
  await assert.rejects(provider.scrape(target), { code: "provider_down" });
  assert.equal(calls, 4);
});

test("menu and consent pages escalate once and keep the remaining rung visible", async (t) => {
  const menu = Array.from(
    { length: 30 },
    (_, i) =>
      `[Read related stories for topic ${i}](https://example.com/topic/${i})`,
  ).join("\n");
  let content = menu;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(success(content)),
  );
  const provider = scrapflyScrape("fake-key");
  const first = options();
  const result = await provider.scrape(target, undefined, first);
  assert.equal(result.check.code, "menus_only");
  assert.equal(result.check.warning, true);
  assert.match(result.hint ?? "", /render/);
  assert.deepEqual(first.tried, ["datacenter", "unblocker"]);

  content =
    "# Cookie preferences\nWe use cookies to improve your browsing experience.\nAccept all cookies";
  const second = options();
  await assert.rejects(provider.scrape(target, undefined, second), {
    code: "consent",
    details: {
      tried: ["datacenter", "unblocker"],
      hint: 'Try start_rung: "render" for a stronger fetch.',
    },
  });

  content = body;
  const hard: ScrapeOptions = { start: "render", tried: [] };
  await provider.scrape(target, undefined, hard);
  assert.deepEqual(hard.tried, ["render"]);
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
    scrapflyScrape("fixture").scrape(target, undefined, budget),
    {
      code: "stronger_rung_required",
      details: {
        tried: ["datacenter", "unblocker"],
        hint: 'Retry with start_rung: "render".',
      },
    },
  );
  assert.deepEqual(budget.tried, ["datacenter", "unblocker"]);
  assert.equal(
    JSON.parse(String(log.mock.calls[0]!.arguments[0])).datacenterBlocked,
    false,
  );
  code = "ERR::SCRAPE::BALANCE_REQUIRED_FOR_EXTRA";
  await assert.rejects(scrapflyScrape("fixture").scrape(target), {
    code: "provider_credit",
  });
  assert.equal(request.mock.callCount(), 3);
});

test("the real tool deadline prevents an unfunded retry", async (t) => {
  const request = t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.searchParams.get("timeout"), "15000");
    return Response.json({}, { status: 503, headers: { "Retry-After": "6" } });
  });
  const deadline = performance.now() + 23_000;
  await assert.rejects(
    scrapflyScrape("fixture").scrape(target, undefined, {
      deadline,
      tried: [],
    }),
    { code: "provider_down" },
  );
  assert.equal(request.mock.callCount(), 1);
});

test("escalation stops with the stronger rung hint if its minimum cannot fit", async (t) => {
  const request = t.mock.method(globalThis, "fetch", async () =>
    Response.json(success("# Access denied", target, 403)),
  );
  const deadline = performance.now() + 32_000;
  await assert.rejects(
    scrapflyScrape("fixture").scrape(target, undefined, {
      deadline,
      tried: [],
    }),
    {
      code: "stronger_rung_required",
      details: {
        tried: ["datacenter"],
        hint: 'Retry with start_rung: "unblocker".',
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
  const request = t.mock.method(globalThis, "fetch", async () =>
    Response.json(success(menu)),
  );
  const result = await scrapflyScrape("fixture").scrape(target, undefined, {
    tried: [],
    deadline: performance.now() + 32_000,
  });
  assert.equal(result.markdown, menu);
  assert.equal(result.check.code, "menus_only");
  assert.equal(result.check.warning, true);
  assert.equal(result.hint, 'Retry with start_rung: "unblocker".');
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
  const provider = scrapflyScrape(
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

test("Scrapfly returns paid base64 PDFs and downloads BLOBs without following redirects", async (t) => {
  const bytes = Buffer.from("%PDF-1.7 fixture");
  let format = "binary";
  let downloads = 0;
  const request = t.mock.method(
    globalThis,
    "fetch",
    async (url: URL, init: RequestInit) => {
      assert.equal(url.origin, "https://api.scrapfly.io");
      if (url.pathname === "/object") {
        downloads++;
        assert.equal(init.redirect, "error");
        assert.equal(url.searchParams.get("key"), "fixture");
        return new Response(Uint8Array.from(bytes), {
          headers: { "content-type": "application/pdf" },
        });
      }
      assert.equal(url.searchParams.get("country"), "us");
      assert.equal(url.searchParams.get("cost_budget"), "5");
      return Response.json({
        context: { cost: { total: 37 } },
        result: {
          ...success(
            format === "blob"
              ? "https://api.scrapfly.io/object"
              : bytes.toString("base64"),
          ).result,
          format,
        },
      });
    },
  );
  const provider = scrapflyScrape("fixture");
  for (const kind of ["binary", "blob"]) {
    format = kind;
    const result = await provider.scrape(target);
    assert.deepEqual(result.binary, { bytes, mimeType: "application/pdf" });
    assert.match(result.costWarning ?? "", /37 credits.*5-credit/);
  }
  assert.equal(downloads, 1);
  assert.equal(request.mock.callCount(), 3);
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
          context: { cost: 25 },
        }),
  );
  const provider = scrapflyScrape("fixture");
  await assert.rejects(provider.scrape(target), {
    code: "provider_cost_overrun",
  });
  assert.equal(request.mock.callCount(), 1);
  unsafe = true;
  await assert.rejects(provider.scrape(target), { code: "unsafe_url" });
  assert.equal(request.mock.callCount(), 2);
});

test("title-only HTML renders with or without a Markdown heading", async (t) => {
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
    const result = await scrapflyScrape("fixture", {
      ...defaults,
      scrapflyCountry: null,
    }).scrape(target, undefined, { tried });
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
  await assert.rejects(scrapflyScrape("fixture").scrape(target), {
    code: "provider_down",
    message: "Scrapfly returned an upstream operation timeout.",
  });
});
