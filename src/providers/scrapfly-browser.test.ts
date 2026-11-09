import { hostRule } from "../config/host-rules.js";
import { messages } from "../config/messages.js";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { chromium, type CDPSession, type LaunchOptions } from "playwright-core";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  documentResponseState,
  guardNavigations,
  goBack,
} from "./browser-navigation.js";
import { defaults } from "../config/tuning.js";
import { RequestLimits } from "../server/request-limits.js";
import { browserInputs } from "./browser-input.js";
import { browserSnapshots } from "./browser-snapshot.js";
import { browserActionError } from "./browser-action-error.js";
import { watchCaptcha } from "./browser-captcha.js";
import { browserScraper } from "./scrapfly-browser.js";

test("browser guard checks top-level redirects and leaves iframe requests to cloud egress", async () => {
  const commands: { method: string; params: unknown }[] = [];
  let paused: (event: unknown) => void = () =>
    assert.fail("No request handler");
  let received: (event: unknown) => void = () =>
    assert.fail("No response handler");
  let restored = paused;
  const statuses: [number | undefined, boolean][] = [];
  const cdp = {
    on(event: string, listener: typeof paused) {
      if (event === "Fetch.requestPaused") paused = listener;
      if (event === "Network.responseReceived") received = listener;
      if (event === "Page.frameNavigated") restored = listener;
    },
    async send(method: string, params: unknown) {
      commands.push({ method, params });
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
    },
  } as unknown as CDPSession;
  const error = await guardNavigations(cdp, (status, mitigated) =>
    statuses.push([status, mitigated]),
  );
  assert.equal(commands[2]?.method, "Network.enable");
  assert.deepEqual(commands[3], {
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
  paused({
    requestId: "reddit",
    frameId: "main",
    request: { url: "https://www.reddit.com/r/example/" },
  });
  await setImmediate();
  assert.equal(error()?.message, hostRule("reddit.com")!.accessError);
  assert(
    commands.some(
      ({ method, params }) =>
        method === "Fetch.failRequest" &&
        (params as { requestId: string }).requestId === "reddit",
    ),
  );
  const challenge = { status: 403, headers: { "CF-Mitigated": "challenge" } };
  received({ frameId: "iframe", type: "Document", response: challenge });
  received({ frameId: "main", type: "Fetch", response: challenge });
  received({
    frameId: "main",
    type: "Document",
    response: challenge,
    loaderId: "challenge",
  });
  received({
    frameId: "main",
    type: "Document",
    response: { status: 200, headers: {} },
    loaderId: "next",
  });
  restored({
    frame: { id: "main", loaderId: "challenge" },
    type: "BackForwardCacheRestore",
  });
  restored({
    frame: { id: "main", loaderId: "unknown" },
    type: "BackForwardCacheRestore",
  });
  assert.deepEqual(statuses, [
    [403, true],
    [200, false],
    [403, true],
    [undefined, false],
  ]);
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

test("fragment changes retain status but a new document starts with no response", () => {
  const doc = documentResponseState();
  doc.observe(403, true);
  const current = "https://example.com/page";
  assert.equal(doc.prepare(current, new URL(current + "#section")), false);
  assert.equal(doc.status, 403);
  assert.equal(doc.mitigated, true);
  assert.equal(doc.prepare(current, new URL(current + "?new=1")), true);
  assert.equal(doc.status, undefined);
  assert.equal(doc.mitigated, false);
});

test("browser main-frame navigations share scrape hostname slots until network completion", async () => {
  const handlers = new Map<string, (event: unknown) => void>();
  const commands: [string, unknown][] = [];
  const cdp = {
    on(event: string, listener: (event: unknown) => void) {
      handlers.set(event, listener);
    },
    async send(method: string, params: unknown) {
      commands.push([method, params]);
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
    },
  } as unknown as CDPSession;
  const limits = new RequestLimits({
    ...defaults,
    localLimitWaitMs: 0,
    siteGapMs: 0,
    siteConcurrency: 1,
  });
  const connection = new AbortController();
  const signal = connection.signal;
  const blocked = await guardNavigations(
    cdp,
    undefined,
    (host, requestSignal) =>
      limits.acquire(requestSignal, Infinity, undefined, host),
    signal,
  );
  assert.deepEqual(commands.at(-1), [
    "Fetch.enable",
    { patterns: [{ resourceType: "Document" }] },
  ]);
  const pause = (networkId: string, resourceType: string) =>
    handlers.get("Fetch.requestPaused")!({
      networkId,
      requestId: networkId,
      frameId: "main",
      resourceType,
      request: { url: "https://1.1.1.1/page" },
    });
  const releaseScrape = await limits.acquire(
    signal,
    Infinity,
    "scrapfly",
    "1.1.1.1",
  );
  pause("document", "Document");
  await setImmediate();
  assert.equal(blocked()?.code, "local_site_limit");
  assert.equal(commands.at(-1)?.[0], "Fetch.failRequest");
  releaseScrape();

  pause("allowed", "Document");
  await setImmediate();
  assert.equal(commands.at(-1)?.[0], "Fetch.continueRequest");
  await assert.rejects(limits.acquire(signal, Infinity, undefined, "1.1.1.1"), {
    code: "local_site_limit",
  });
  handlers.get("Network.loadingFinished")!({ requestId: "allowed" });
  (await limits.acquire(signal, Infinity, undefined, "1.1.1.1"))();
  connection.abort();
});

const chromeExecutable = process.env.MCP_TEST_CHROME;
const skipChrome =
  process.env.CODEX_SANDBOX === "seatbelt"
    ? "Local Chrome cannot launch inside the macOS Codex sandbox. Run this test outside it."
    : !chromeExecutable && "Set MCP_TEST_CHROME to a local Chrome executable";

async function launchChrome(options: LaunchOptions) {
  assert(
    chromeExecutable && existsSync(chromeExecutable),
    "MCP_TEST_CHROME does not point to an existing executable.",
  );
  try {
    return await chromium.launch({
      ...options,
      executablePath: chromeExecutable,
    });
  } catch (error) {
    throw new Error(
      "Local Chrome failed to start. Check MCP_TEST_CHROME and run outside the macOS Codex sandbox.",
      { cause: error },
    );
  }
}

test(
  "a browser page loads 32 same-host files under navigation pacing",
  { skip: skipChrome },
  async (t) => {
    const count = 32;
    const server = createServer((req, res) => {
      const url = new URL(req.url!, "http://1.1.1.1");
      if (url.pathname === "/fixture") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          Array.from(
            { length: count },
            (_, index) => `<script src="/asset-${index}.js"></script>`,
          ).join(""),
        );
      } else if (/^\/asset-\d+\.js$/.test(url.pathname)) {
        res.setHeader("Content-Type", "text/javascript");
        res.end("window.loaded = (window.loaded || 0) + 1;");
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(() => server.close());
    const address = server.address() as AddressInfo;
    const browser = await launchChrome({
      proxy: { server: `http://127.0.0.1:${address.port}` },
    });
    try {
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);
      const limits = new RequestLimits({ ...defaults, localLimitWaitMs: 0 });
      let paced = 0;
      await guardNavigations(cdp, undefined, (host, signal) => {
        paced++;
        return limits.acquire(signal, Infinity, undefined, host);
      });
      await page.goto("http://1.1.1.1/fixture", { timeout: 10_000 });
      assert.equal(await page.evaluate("window.loaded"), count);
      assert.equal(paced, 1);
    } finally {
      await browser.close();
    }
  },
);

test(
  "browser snapshots filter the viewport and keep native refs usable",
  { skip: skipChrome },
  async (t) => {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      switch (new URL(req.url!, "http://1.1.1.1").pathname) {
        case "/fixture":
          res.end(`
          <a style="position:absolute;top:-1px;left:-1px;width:1px;height:1px;overflow:hidden" href="#main">Skip to content</a>
          <h1 id="main">Fixture heading</h1>
          <form aria-label="Main form">
            <button type="button" onclick="this.textContent='Clicked'">Main button</button>
            <input aria-label="Main field">
          </form>
          <iframe src="/frame" style="border:0"></iframe>
          <form action="/search">
            <input type="search" name="q" aria-label="Search Wikipedia" oninput="
              const replacement = this.cloneNode();
              replacement.removeAttribute('oninput');
              replacement.setAttribute('role', 'combobox');
              this.replaceWith(replacement);
              replacement.focus();
            ">
          </form>
          <a href="/next?tracking=${"x".repeat(180)}">Follow link</a>
          <div style="height:1500px"></div>
          <h2>Lower heading</h2><button>Lower button</button>
          <iframe src="/frame" style="border:0"></iframe>
        `);
          break;
        case "/search":
          assert.match(req.url!, /q=Model\+Context\+Protocol/);
          res.writeHead(302, { Location: "/next" }).end();
          break;
        case "/frame":
          res.end(
            `<button onclick="this.textContent='Frame clicked'">Frame button</button><input aria-label="Frame field">`,
          );
          break;
        default:
          res.end("<h1>Second page</h1>");
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(() => server.close());
    const { port } = server.address() as AddressInfo;
    const browser = await launchChrome({
      proxy: { server: `http://127.0.0.1:${port}` },
      ignoreDefaultArgs: ["--disable-back-forward-cache"],
    });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(5_000);
      const cdp = await page.context().newCDPSession(page);
      const captcha = watchCaptcha(cdp, page);
      const doc = documentResponseState();
      const blocked = await guardNavigations(
        cdp,
        (status, mitigated) => {
          doc.observe(status, mitigated);
          captcha.reset();
        },
        async () => () => {},
      );
      await page.goto("http://1.1.1.1/fixture");
      const snapshots = browserSnapshots(page);
      const viewportResult = await snapshots.read();
      const viewport = viewportResult.text;
      assert.match(viewport, /heading "Fixture heading"/);
      assert.equal(viewportResult.note, messages.note.offscreen(3));
      assert.doesNotMatch(viewport, /Lower|Skip to content/);
      const mainButton = /^(e\d+) button "Main button"/m.exec(viewport)?.[1];
      const mainField = /^(e\d+) textbox "Main field"/m.exec(viewport)?.[1];
      const frameButton = /^(f1e\d+) button "Frame button"/m.exec(
        viewport,
      )?.[1];
      const frameField = /^(f1e\d+) textbox "Frame field"/m.exec(viewport)?.[1];
      assert(mainButton && mainField && frameButton && frameField, viewport);
      await snapshots.locator(mainButton).click();
      await snapshots.locator(frameButton).click();
      await snapshots.locator(mainField).fill("main input");
      await snapshots.locator(frameField).fill("frame input");
      assert.equal(
        await snapshots.locator(mainField).inputValue(),
        "main input",
      );
      assert.equal(
        await snapshots.locator(frameField).inputValue(),
        "frame input",
      );
      const allControls = (await snapshots.read({ scope: "page" })).text;
      assert.match(allControls, /textbox "Main field" value="main input"/);
      assert.match(allControls, /textbox "Frame field" value="frame input"/);
      assert.match(
        allControls,
        /link "Follow link" -> \/next\?tracking=x{80,90}…$/m,
      );
      assert.match(allControls, /Lower heading/);
      assert.match(allControls, /Lower button/);
      assert.match(allControls, /button "Clicked"/);
      assert.match(allControls, /button "Frame clicked"/);
      assert.match(allControls, /^f\d+e\d+ button "Frame button"/m);
      const full = JSON.parse((await snapshots.read({ scope: "full" })).text);
      assert(Array.isArray(full));
      const form = (await snapshots.read({ query: "MAIN FORM" })).text;
      const formRef = /^(e\d+) form "Main form"/m.exec(form)?.[1];
      assert(formRef, form);
      const subtree = (await snapshots.read({ target: formRef })).text;
      assert.match(subtree, /Main field/);
      assert.doesNotMatch(subtree, /Frame|Lower/);
      assert.match(
        (await snapshots.read({ target: frameField })).text,
        /Frame field/,
      );
      assert.match(
        (await snapshots.read({ query: "CLICKED" })).text,
        /button "Clicked" \(in form "Main form"\)/,
      );
      assert.match(
        (await snapshots.read({ query: "lower button" })).text,
        /button "Lower button"/,
      );
      assert.equal(
        (await snapshots.read({ query: "absent" })).note,
        messages.note.noElements,
      );
      await page.getByRole("link", { name: "Follow link" }).click();
      assert.throws(() => snapshots.locator(mainField), {
        message: messages.browser.staleRef,
      });
      assert.match((await snapshots.read()).text, /Second page/);
      await goBack(page);
      assert.equal(blocked(), undefined);
      assert.equal(doc.status, 200);
      await captcha.wait(() => doc.mitigated);
      const restored = (await snapshots.read()).text;
      assert.match(restored, /Fixture heading/);
      const ref = /^((?:f\d+)?e\d+) searchbox "Search Wikipedia"/m.exec(
        restored,
      )?.[1];
      assert(ref);
      const inputs = browserInputs(page);
      await inputs.fill(snapshots.locator(ref), "Model Context Protocol", ref);
      assert.match(
        (await snapshots.read()).text,
        /combobox "Search Wikipedia" value="Model Context Protocol"/,
      );
      await inputs.press(snapshots.locator(ref), "Enter", ref);
      assert.equal(new URL(page.url()).pathname, "/next");
      assert.equal(blocked(), undefined);
    } finally {
      await browser.close();
    }
  },
);

test("browser diagnostics use safe action details without quoting page data", () => {
  assert.equal(
    browserActionError(
      new Error(
        'locator.fill: Error: strict mode violation: locator("private selector") resolved to 3 elements:\nprivate HTML',
      ),
      "fill",
    ).message,
    messages.browser.ambiguous("3"),
  );
  assert.equal(
    browserActionError(
      new Error(
        "locator.click: Timeout 15000ms exceeded.\n - element is not visible\nhttps://user:password@example.com",
      ),
      "click",
    ).message,
    messages.browser.elementState("visible"),
  );
});
