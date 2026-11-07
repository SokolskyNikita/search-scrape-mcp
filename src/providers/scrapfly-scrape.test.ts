import assert from "node:assert/strict";
import { test } from "node:test";
import { scrapflyScrape } from "./scrapfly-scrape.js";

const target = "https://8.8.8.8/article";
const publicRedirect = "https://1.1.1.1/article";
const fixture = {
  context: { redirects: [publicRedirect] },
  result: {
    content: "# An article\r\n\r\n\r\nPublic content.",
    status_code: 200,
    success: true,
    url: publicRedirect,
  },
};

test("Scrapfly requests ASP and cleaned markdown, then validates its reported redirects", async (t) => {
  let payload: unknown = fixture;
  const request = t.mock.method(
    globalThis,
    "fetch",
    async (input: URL, init: RequestInit) => {
      assert.equal(
        input.origin + input.pathname,
        "https://api.scrapfly.io/scrape",
      );
      assert.deepEqual(Object.fromEntries(input.searchParams), {
        key: "fake-key",
        url: target,
        asp: "true",
        format: "markdown:only_content,no_images",
      });
      assert.equal(init.redirect, "error");
      return Response.json(payload);
    },
  );
  const provider = scrapflyScrape("fake-key");
  await assert.rejects(provider.scrape("http://127.0.0.1/article"), {
    code: "unsafe_url",
  });
  assert.equal(request.mock.callCount(), 0);
  assert.equal(
    await provider.scrape(target + "#heading"),
    "# An article\n\nPublic content.",
  );

  payload = {
    ...fixture,
    context: { redirects: ["http://169.254.169.254/", publicRedirect] },
  };
  await assert.rejects(provider.scrape(target), { code: "unsafe_url" });
  payload = { result: { ...fixture.result, url: "http://127.0.0.1/" } };
  await assert.rejects(provider.scrape(target), { code: "unsafe_url" });
  payload = { result: { ...fixture.result, url: undefined } };
  await assert.rejects(provider.scrape(target), { code: "provider_response" });
  payload = {
    result: {
      ...fixture.result,
      content: "# Just a moment…\nChecking your browser",
    },
  };
  await assert.rejects(provider.scrape(target), { code: "challenge" });
  payload = {
    result: {
      ...fixture.result,
      content: null,
      error: {
        code: "ERR::ASP::SHIELD_EXPIRED",
        message: "private provider detail",
      },
      success: false,
    },
  };
  await assert.rejects(provider.scrape(target), {
    code: "challenge",
    message: "Scrapfly could not resolve the target's anti-bot challenge.",
  });
});
