import assert from "node:assert/strict";
import { test } from "node:test";
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
    assert.equal(input.searchParams.get("cost_budget"), "30");
    assert.equal(init.redirect, "error");
    const rung = input.searchParams.has("render_js")
      ? "render"
      : input.searchParams.has("unblocker")
        ? "unblocker"
        : "datacenter";
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
  const next = options();
  await provider.scrape(target, undefined, next);
  assert.deepEqual(next.tried, ["unblocker", "render"]);
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
