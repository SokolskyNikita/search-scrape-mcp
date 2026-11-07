import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { CDPSession } from "playwright-core";
import { guardNavigations } from "./browser-navigation.js";
import { browserScraper } from "./scrapfly-browser.js";

test("browser guard checks top-level redirects and leaves iframe requests to cloud egress", async () => {
  const commands: { method: string; params: unknown }[] = [];
  let paused: (event: unknown) => void = () =>
    assert.fail("No request handler");
  const cdp = {
    on(_event: string, listener: typeof paused) {
      paused = listener;
    },
    async send(method: string, params: unknown) {
      commands.push({ method, params });
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
    },
  } as unknown as CDPSession;
  const error = await guardNavigations(cdp);
  assert.deepEqual(commands[1], {
    method: "Fetch.enable",
    params: { patterns: [{ resourceType: "Document" }] },
  });
  paused({
    requestId: "1",
    frameId: "main",
    request: { url: "https://1.1.1.1/" },
  });
  paused({
    requestId: "2",
    frameId: "main",
    request: { url: "http://127.0.0.1/" },
  });
  paused({
    requestId: "3",
    frameId: "iframe",
    request: { url: "http://127.0.0.1/" },
  });
  await setImmediate();
  assert(
    commands.some(
      ({ method, params }) =>
        method === "Fetch.failRequest" &&
        (params as { requestId: string }).requestId === "2",
    ),
  );
  assert.equal(
    commands.filter(({ method }) => method === "Fetch.continueRequest").length,
    2,
  );
  assert.equal(error()?.code, "unsafe_url");
});

test("browser scraper releases the session when navigation fails", async () => {
  let closed = false;
  const scraper = browserScraper({
    async open() {
      return {
        async run(action) {
          assert.deepEqual(action, {
            action: "navigate",
            url: "https://93.184.215.14/",
          });
          throw new Error("Navigation failed.");
        },
        async close() {
          closed = true;
        },
      };
    },
  });

  await assert.rejects(
    scraper.scrape("https://93.184.215.14"),
    /Navigation failed/,
  );
  assert.equal(closed, true);
});

test("browser scrape checks the final URL and actual navigation status", async () => {
  const url = new URL("https://1.1.1.1/");
  let status = 404;
  const scraper = browserScraper({
    async open() {
      return {
        async run() {
          return { url, status, title: "Article", text: "Readable text." };
        },
        async close() {},
      };
    },
  });
  await assert.rejects(scraper.scrape("https://1.1.1.1/article"), {
    code: "not_found",
  });
  status = 200;
  await assert.rejects(scraper.scrape("https://1.1.1.1/article"), {
    code: "content_moved",
  });
});
