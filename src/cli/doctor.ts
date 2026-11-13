import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadProviderKeys, loadSettings } from "../config/index.js";
import { version } from "../config/version.js";
import { safeError } from "../server/error.js";
import {
  COMMAND,
  FAIL,
  LABEL,
  OK,
  SERVER,
  WARN,
  type Say,
  desktopConfigFile,
  logsDirectory,
  plistFile,
  run,
} from "./paths.js";

const brewYtDlp = "/opt/homebrew/opt/yt-dlp/libexec/bin/python3";

/** Open a real MCP session against the running server and list its tools. Costs no provider credits. */
export async function probe(settings: { port: number; token: string }) {
  const client = new Client({ name: `${COMMAND}-doctor`, version });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${settings.port}/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${settings.token}` },
        signal: AbortSignal.timeout(10_000),
      },
    },
  );
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return {
      version: client.getServerVersion()?.version,
      tools: tools.map((tool) => tool.name),
    };
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

/** Wait for a freshly started server to answer. */
export async function waitForServer(
  settings: { port: number; token: string },
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await probe(settings);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(500);
    }
  }
}

type Check = [mark: string, what: string, fix?: string];

function desktopEntry(): { command?: string } | undefined {
  try {
    const config = JSON.parse(readFileSync(desktopConfigFile(), "utf8")) as {
      mcpServers?: Record<string, { command?: string }>;
    };
    return config.mcpServers?.[SERVER];
  } catch {
    return undefined;
  }
}

/**
 * Node 26 before 26.13.1 can exit on an idle HTTP/2 connection to a provider
 * (nodejs/undici#5936). launchd restarts the server, but calls in flight fail.
 */
export function nodeHttp2Warning(version: string) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return major === 26 && (minor < 13 || (minor === 13 && patch < 1))
    ? `Node ${version} can crash the server on an idle provider connection; 26.13.1 fixes it`
    : undefined;
}

export async function checks(): Promise<Check[]> {
  const found: Check[] = [];
  const setup = `Run \`${COMMAND} setup\`.`;
  found.push([
    process.platform === "darwin" ? OK : FAIL,
    `${COMMAND} ${version}, Node ${process.versions.node}, ${process.platform}`,
    process.platform === "darwin" ? "" : "The background agent needs macOS.",
  ]);

  const node = nodeHttp2Warning(process.versions.node);
  if (node) found.push([WARN, node, "brew upgrade node"]);

  try {
    const keys = loadProviderKeys();
    found.push(
      keys.scrapflyKey
        ? [OK, "Provider keys: Serper and Scrapfly"]
        : [
            WARN,
            "Provider keys: Serper only, so scrape and browser are off",
            "Add SCRAPFLY_API_KEY to ~/.config/search-scrape-mcp/env, then run `search-scrape-mcp restart`.",
          ],
    );
  } catch (error) {
    found.push([FAIL, `Provider keys: ${safeError(error).message}`, setup]);
  }

  let settings: ReturnType<typeof loadSettings> | undefined;
  try {
    settings = loadSettings();
    found.push([OK, `Settings: port ${settings.port}`]);
  } catch (error) {
    found.push([FAIL, `Settings: ${safeError(error).message}`, setup]);
  }

  const loaded = run("launchctl", [
    "print",
    `gui/${process.getuid?.()}/${LABEL}`,
  ]).ok;
  found.push(
    loaded && existsSync(plistFile())
      ? [OK, `Background agent: loaded (${LABEL})`]
      : [FAIL, "Background agent: not loaded", setup],
  );

  if (settings) {
    try {
      const server = await probe(settings);
      found.push(
        server.version === version
          ? [OK, `Server answers: ${server.tools.join(", ")}`]
          : [
              WARN,
              `Server answers, but runs ${server.version} while ${version} is installed`,
              `Run \`${COMMAND} restart\`.`,
            ],
      );
    } catch {
      found.push([
        FAIL,
        `Server does not answer on 127.0.0.1:${settings.port}`,
        `Run \`${COMMAND} logs\` to see why, then \`${COMMAND} restart\`.`,
      ]);
    }
  }

  const ytDlp = process.env.YT_DLP_PYTHON || brewYtDlp;
  found.push(
    existsSync(ytDlp)
      ? [OK, "yt-dlp: installed"]
      : [
          WARN,
          "yt-dlp: not found, so the youtube tool may fail",
          "brew install yt-dlp",
        ],
  );

  const claude = run("claude", ["mcp", "get", SERVER]);
  found.push(
    claude.missing
      ? [WARN, "Claude Code: not installed"]
      : claude.ok
        ? [OK, "Claude Code: connected"]
        : [WARN, "Claude Code: not connected", setup],
  );

  // Setup no longer registers the Claude desktop app; an entry left by an earlier
  // version keeps its Code tab on the relay and its 60-second limit.
  if (desktopEntry())
    found.push([
      WARN,
      "Claude desktop app: an old relay entry keeps its Code tab on a 60-second limit",
      `${setup} Then restart the Claude app.`,
    ]);

  const codex = run("codex", ["mcp", "get", SERVER]);
  if (!codex.missing)
    found.push(
      codex.ok
        ? [OK, "Codex: connected"]
        : [WARN, "Codex: not connected", setup],
    );

  found.push([OK, `Logs: ${logsDirectory()}`]);
  return found;
}

/** Print the checks. True when nothing failed. */
export function printChecks(found: Check[], say: Say = console.log) {
  for (const [mark, what, fix] of found)
    say(` ${mark} ${what}${fix ? `\n     → ${fix}` : ""}`);
  return !found.some(([mark]) => mark === FAIL);
}
