import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadProviderKeys, parseSettings } from "../config/index.js";
import { createApp } from "./app.js";
import { AppError, safeError } from "./error.js";

async function smoke() {
  const challenge = process.argv.includes("--challenge");
  const browserOnly = challenge || process.argv.includes("--browser-only");
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
    async function call(
      name: string,
      args: Record<string, unknown>,
      expected: RegExp,
      label = name,
    ) {
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: 240_000 },
      );
      if (result.isError) {
        const first = Array.isArray(result.content)
          ? result.content[0]
          : undefined;
        const reason =
          first?.type === "text" && typeof first.text === "string"
            ? first.text.split(":", 1)[0]
            : undefined;
        const code =
          reason && /^[a-z_0-9]{1,30}$/.test(reason) ? reason : "tool_error";
        throw new AppError("smoke", `${label} failed (${code}).`);
      }
      if (!expected.test(JSON.stringify(result)))
        throw new AppError("smoke", `${label} returned unexpected content.`);
      console.log(`${label}: OK`);
      return result;
    }
    const url = challenge
      ? "https://zerocaptcha.io/captcha-test/cloudflare-managed-challenge"
      : "https://example.com/";
    if (!browserOnly) {
      await call(
        "search",
        { query: "example.com Example Domain", limit: 1 },
        /https?:\/\//,
      );
      await call("scrape", { url }, /Example Domain/i);
    }
    await call(
      "browser",
      { command: { action: "navigate", url } },
      challenge
        ? /Cloudflare WAF managed challenge test page/i
        : /Example Domain/i,
      challenge ? "browser real challenge" : "browser navigate",
    );
    if (!challenge) {
      const snapshot = await call(
        "browser",
        { command: { action: "snapshot" } },
        /- (?:heading|link|paragraph|text|generic)\b/i,
        "browser snapshot",
      );
      const ref = JSON.stringify(snapshot).match(/\[ref=(s\d+-e\d+)\]/)?.[1];
      if (!ref)
        throw new AppError(
          "smoke",
          "Browser snapshot returned no element refs.",
        );
      await call(
        "browser",
        { command: { action: "press", ref, key: "Tab" } },
        /\[ref=s\d+-e\d+\]/,
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
