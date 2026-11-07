import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type WebSocket from "ws";
import { guardedCdp } from "./scrapfly-browser-transport.js";
import { browserScraper } from "./scrapfly-browser.js";

test("CDP transport blocks an unsafe redirect before Chromium sends it", async () => {
  const messages: unknown[] = [];

  class FakeSocket extends EventTarget {
    static readonly OPEN = 1;
    readyState = FakeSocket.OPEN;

    send(data: string) {
      messages.push(JSON.parse(data));
    }

    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }

  const connection = new FakeSocket();
  const transport = guardedCdp(connection as unknown as WebSocket);

  function intercept(id: string, url: string, redirectedRequestId?: string) {
    connection.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          method: "Fetch.requestPaused",
          sessionId: "page",
          params: { requestId: id, request: { url }, redirectedRequestId },
        }),
      }),
    );
    transport.send({
      id: messages.length + 1,
      method: "Fetch.continueRequest",
      sessionId: "page",
      params: { requestId: id },
    });
  }

  intercept("start", "https://93.184.215.14");
  await setImmediate();
  intercept("redirect", "http://127.0.0.1", "start");
  await setImmediate();
  assert.deepEqual(messages, [
    {
      id: 1,
      method: "Fetch.continueRequest",
      sessionId: "page",
      params: { requestId: "start" },
    },
    {
      id: 2,
      method: "Fetch.failRequest",
      sessionId: "page",
      params: { requestId: "redirect", errorReason: "BlockedByClient" },
    },
  ]);

  connection.dispatchEvent(
    new MessageEvent("message", { data: "invalid JSON" }),
  );
  assert.equal(connection.readyState, 3);
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
