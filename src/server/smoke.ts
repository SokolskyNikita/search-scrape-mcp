import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { relayTimeoutMs } from "../config/deadline.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadProviderKeys, parseSettings } from "../config/index.js";
import { createApp } from "./app.js";
import { AppError, safeError } from "./error.js";

async function smoke() {
  const unblocker = process.argv.includes("--unblocker");
  const challenge = process.argv.includes("--challenge");
  const captchaForm = process.argv.includes("--captcha-form");
  const idle = process.argv.includes("--idle");
  const browserOnly =
    challenge || captchaForm || idle || process.argv.includes("--browser-only");
  const config = {
    ...parseSettings({ token: randomBytes(32).toString("base64url") }),
    ...loadProviderKeys(),
  };
  if (!config.scrapflyKey)
    throw new AppError(
      "config",
      "A Scrapfly key is required for the live smoke test.",
    );

  // Exercise the primary API independently so browser fallback cannot mask failures.
  const server = createApp({ ...config, scrapeProviders: ["scrapfly"] });
  server.listen(0, "127.0.0.1");
  const client = new Client({ name: "live-smoke", version: "1.0.0" });
  let transport: StreamableHTTPClientTransport | undefined;
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new AppError("smoke", "Could not bind the smoke server.");
    transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      {
        requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
      },
    );
    await client.connect(transport);
    const invoke = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args }, undefined, {
        timeout: relayTimeoutMs(config),
      });
    async function call(
      name: string,
      args: Record<string, unknown>,
      expected: RegExp | undefined,
      label = name,
    ) {
      const result = await invoke(name, args);
      if (result.isError) {
        const reason = (result.structuredContent as { code?: string })?.code;
        const code =
          typeof reason === "string" && /^[a-z_0-9]{1,30}$/.test(reason)
            ? reason
            : "tool_error";
        throw new AppError("smoke", `${label} failed (${code}).`);
      }
      if (expected && !expected.test(JSON.stringify(result)))
        throw new AppError("smoke", `${label} returned unexpected content.`);
      if (expected) console.log(`${label}: OK`);
      return result;
    }
    const url = challenge
      ? "https://zerocaptcha.io/captcha-test/cloudflare-js-challenge"
      : captchaForm
        ? "https://zerocaptcha.io/captcha-test/cloudflare-turnstile-login-form"
        : "https://example.com/";
    if (process.argv.includes("--render")) {
      const url = "https://quotes.toscrape.com/js/";
      const quotes = /The world as we have created it/i;
      const preview = await call(
        "scrape",
        { url },
        /start_rung.*render/i,
        "render hint",
      );
      if (quotes.test(JSON.stringify(preview)))
        throw new AppError(
          "smoke",
          "JavaScript fixture already contained quotes before rendering.",
        );
      await call(
        "scrape",
        { url, start_rung: "render" },
        quotes,
        "follow render hint",
      );
      await call(
        "scrape",
        { url, start_rung: "render" },
        quotes,
        "explicit render",
      );
      return;
    }
    if (process.argv.includes("--batch")) {
      const result = await call(
        "scrape_batch",
        {
          urls: [
            "https://example.com/",
            "https://example.com/?smoke=2",
            "https://www.leboncoin.fr/",
          ],
        },
        undefined,
      );
      const items = (
        result.structuredContent as {
          items?: {
            index: number;
            error?: object;
            result?: { tried?: string[] };
          }[];
        }
      )?.items;
      if (
        items?.length !== 3 ||
        items.some(
          (item: { index: number; error?: object }, index: number) =>
            item.index !== index || item.error,
        ) ||
        !items[2]?.result?.tried?.includes("unblocker")
      )
        throw new AppError(
          "smoke",
          "Batch did not return three ordered successes with Unblocker on the protected item.",
        );
      console.log("scrape batch: OK");
      return;
    }
    if (unblocker) {
      const target = process.argv[process.argv.indexOf("--unblocker") + 1];
      if (!target)
        throw new AppError(
          "smoke",
          "Supply a protected URL after --unblocker.",
        );
      const result = await call(
        "scrape",
        { url: target },
        /\\"code\\"\s*:\s*\\"ok\\"/i,
        "scrape protected page",
      );
      const page = result.structuredContent as
        { check?: { code: string }; tried?: string[] } | undefined;
      if (
        page?.check?.code !== "ok" ||
        page?.tried?.[0] !== "datacenter" ||
        !page.tried.includes("unblocker")
      )
        throw new AppError(
          "smoke",
          "Protected page did not return readable content after escalation to Unblocker.",
        );
      console.log("scrape protected page: OK");
      const second = await call(
        "scrape",
        { url: target },
        undefined,
        "remembered Unblocker",
      );
      const remembered = second.structuredContent as typeof page;
      if (
        remembered?.check?.code !== "ok" ||
        remembered?.tried?.[0] !== "unblocker"
      )
        throw new AppError(
          "smoke",
          "Repeat scrape did not start at the remembered Unblocker rung.",
        );
      console.log("remembered Unblocker: OK");
      return;
    }
    if (!browserOnly) {
      await call(
        "search",
        { query: "example.com Example Domain", limit: 1 },
        /https?:\/\//,
      );
      await call(
        "scrape",
        { url: "https://www.iana.org/domains/reserved" },
        /\[RFC 2606\]\(https:\/\//i,
      );
    }
    await call(
      "browser",
      { command: { action: "navigate", url } },
      challenge
        ? /Cloudflare 5-second JS challenge test page/i
        : captchaForm
          ? /Cloudflare Turnstile login form demo/i
          : /Example Domain/i,
      challenge ? "browser real challenge" : "browser navigate",
    );
    if (idle) {
      await delay(config.browserIdleMs + 1_000);
      const snapshot = await invoke("browser", {
        command: { action: "snapshot" },
      });
      if (!snapshot.isError || !/browser_closed/.test(JSON.stringify(snapshot)))
        throw new AppError("smoke", "Idle browser session did not close.");
      console.log("browser idle close: OK");
      return;
    }
    if (!challenge && !captchaForm) {
      await call(
        "browser",
        { command: { action: "navigate", url: `${url}#smoke` } },
        /Example Domain/i,
        "browser fragment navigate",
      );
      const snapshot = await call(
        "browser",
        { command: { action: "snapshot", scope: "page" } },
        /\b(?:f\d+)?e\d+ (?:heading|link)\b/i,
        "browser snapshot",
      );
      const ref = JSON.stringify(snapshot).match(
        /\b((?:f\d+)?e\d+) link\b/,
      )?.[1];
      if (!ref)
        throw new AppError(
          "smoke",
          "Browser snapshot returned no element refs.",
        );
      await call(
        "browser",
        { command: { action: "press", ref, key: "Tab" } },
        /Browser press.*Example Domain|Browser press.*e\d+ link/i,
        "browser ref press",
      );
      await call(
        "browser",
        { command: { action: "screenshot" } },
        /image\/jpeg/,
        "browser screenshot",
      );
    }
    await call(
      "browser",
      { command: { action: "close" } },
      /Browser closed/,
      "browser close",
    );
  } finally {
    try {
      if (transport?.sessionId) await transport.terminateSession();
    } finally {
      await client.close();
      server.close();
      server.closeAllConnections();
    }
  }
}

try {
  await smoke();
} catch (error) {
  console.error(safeError(error).message);
  process.exitCode = 1;
}
