import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { clientTimeoutMs } from "../config/deadline.js";
import type { Tuning } from "../config/tuning.js";
import {
  keysFile,
  loadProviderKeys,
  parseSettings,
  readSettings,
  settingsFile,
} from "../config/index.js";
import { AppError } from "../server/error.js";
import { checks, printChecks, waitForServer } from "./doctor.js";
import {
  COMMAND,
  FAIL,
  LABEL,
  OK,
  SERVER,
  type Say,
  brewCommand,
  checkout,
  desktopConfigFile,
  isCheckout,
  logsDirectory,
  plistFile,
  run,
  runVisible,
  selfCommand,
} from "./paths.js";

const domain = () => `gui/${process.getuid?.()}`;

function writePrivate(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
  renameSync(temp, file);
}

/** Read a line from the terminal without echoing it. */
function askSecret(question: string) {
  return new Promise<string>((resolve, reject) => {
    const { stdin, stdout } = process;
    let value = "";
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          finish();
          return resolve(value.trim());
        }
        if (char === "\u0003" || char === "\u0004") {
          finish();
          return reject(new AppError("config", "Setup cancelled."));
        }
        if (char === "\u007f") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** Make sure the private env file holds valid provider keys, asking for them on first run. */
async function ensureKeys(say: Say) {
  const file = keysFile();
  if (existsSync(file)) {
    loadProviderKeys();
    return say(` ${OK} Provider keys: ${file}`);
  }
  if (!process.stdin.isTTY)
    throw new AppError(
      "config",
      `Put SERPER_API_KEY and SCRAPFLY_API_KEY in ${file} (chmod 600), or run \`${COMMAND} setup\` in a terminal to be asked for them.`,
    );
  say(
    "Provider keys (typing is hidden; they are stored only in a private file on this Mac):",
  );
  const serper = await askSecret("  Serper API key (https://serper.dev): ");
  const scrapfly = await askSecret(
    "  Scrapfly API key (https://scrapfly.io; Enter to skip scrape and browser): ",
  );
  writePrivate(
    file,
    `SERPER_API_KEY=${serper}\n${scrapfly ? `SCRAPFLY_API_KEY=${scrapfly}\n` : ""}`,
  );
  try {
    loadProviderKeys();
  } catch (error) {
    rmSync(file);
    throw error;
  }
  say(` ${OK} Provider keys saved to ${file}`);
}

/** Create the settings file with a fresh bearer token on first run, and drop keys an early version kept in it. */
function ensureSettings(say: Say) {
  const file = settingsFile();
  const render = (settings: unknown) =>
    `${JSON.stringify(settings, null, 2)}\n`;
  if (!existsSync(file)) {
    const chosen = { token: randomBytes(32).toString("base64url") };
    writePrivate(file, render(chosen));
    say(` ${OK} Settings created: ${file}`);
    return parseSettings(chosen);
  }
  const { settings, legacyKeys } = readSettings(file);
  const saved = Object.keys(
    JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>,
  ).filter((name) => name in settings);
  const chosen = chosenSettings(settings, saved);
  const dropped = saved.length - Object.keys(chosen).length;
  if (legacyKeys || dropped) writePrivate(file, render(chosen));
  say(
    ` ${OK} Settings: ${file}` +
      (dropped
        ? ` (removed ${dropped} entries that only repeated the defaults)`
        : ""),
  );
  return settings;
}

/**
 * The settings that differ from the defaults. Only these are saved, so that a later
 * version's changed default takes effect instead of being pinned by an old copy.
 */
export function chosenSettings(
  settings: Record<string, unknown>,
  saved = Object.keys(settings),
) {
  const standard = parseSettings({ token: "x".repeat(32) }) as Record<
    string,
    unknown
  >;
  return Object.fromEntries(
    Object.entries(settings).filter(
      ([name, value]) =>
        saved.includes(name) &&
        (name === "token" || !isDeepStrictEqual(value, standard[name])),
    ),
  );
}

const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function renderPlist(
  program: string[],
  environment: Record<string, string>,
  logs: string,
) {
  const strings = (values: string[]) =>
    values.map((value) => `<string>${xml(value)}</string>`).join("");
  const env = Object.entries(environment)
    .map(
      ([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`,
    )
    .join("\n    ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${strings(program)}</array>
  <key>EnvironmentVariables</key><dict>
    ${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logs)}/stdout.log</string>
  <key>StandardErrorPath</key><string>${xml(logs)}/stderr.log</string>
</dict></plist>
`;
}

function unloadAgent() {
  const target = `${domain()}/${LABEL}`;
  if (!run("launchctl", ["print", target]).ok) return false;
  run("launchctl", ["bootout", target]);
  return true;
}

/** Write the LaunchAgent that keeps the server running, and (re)start it. */
async function installAgent(say: Say) {
  const logs = logsDirectory();
  const file = plistFile();
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(
    temp,
    renderPlist(
      [...selfCommand(), "serve"],
      {
        MCP_CONFIG: settingsFile(),
        MCP_KEYS_FILE: keysFile(),
        MCP_STATS_LOG: `${logs}/tools.jsonl`,
      },
      logs,
    ),
    { mode: 0o600 },
  );
  renameSync(temp, file);
  unloadAgent();
  // launchd can refuse to load a label for a moment after unloading it.
  let loaded = run("launchctl", ["bootstrap", domain(), file]);
  for (let attempt = 0; !loaded.ok && attempt < 10; attempt++) {
    await sleep(500);
    loaded = run("launchctl", ["bootstrap", domain(), file]);
  }
  if (!loaded.ok)
    throw new AppError(
      "config",
      `launchd could not load the background agent: ${loaded.output.slice(-300)}`,
    );
  say(` ${OK} Background agent loaded (${LABEL})`);
}

const shellQuote = (value: string) => `"${value.replace(/["\\$`]/g, "\\$&")}"`;

/** Claude Code talks to the HTTP server directly and asks this install for the bearer token on each connection. */
export function claudeCodeEntry(
  port: number,
  command: string[],
  timeout: number,
) {
  return {
    type: "http",
    url: `http://127.0.0.1:${port}/mcp`,
    headersHelper: [...command, "headers"].map(shellQuote).join(" "),
    // Without this, Claude Code gives up on a call after 60 seconds and drops the
    // connection, which also fails the session's other calls in flight.
    timeout,
  };
}

function registerClaudeCode(settings: Tuning & { port: number }, say: Say) {
  if (run("claude", ["--version"]).missing)
    return say(
      ` - Claude Code isn't installed, so it is skipped (install it later and run \`${COMMAND} setup\` again).`,
    );
  run("claude", ["mcp", "remove", "--scope", "user", SERVER]);
  const added = run("claude", [
    "mcp",
    "add-json",
    "--scope",
    "user",
    SERVER,
    JSON.stringify(
      claudeCodeEntry(settings.port, selfCommand(), clientTimeoutMs(settings)),
    ),
  ]);
  say(
    added.ok
      ? ` ${OK} Claude Code connected (new sessions pick it up)`
      : ` ${FAIL} Could not connect Claude Code: ${added.output.slice(-300)}`,
  );
}

/** Return the Claude Desktop config with this server's entry set (or removed), or undefined when nothing changes. */
export function mergeDesktopConfig(
  text: string,
  command: string[] | undefined,
): string | undefined {
  const config: unknown = text.trim() ? JSON.parse(text) : {};
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new SyntaxError("not a JSON object");
  const root = config as { mcpServers?: Record<string, unknown> };
  const servers = (root.mcpServers ??= {});
  const wanted = command && {
    command: command[0],
    args: [...command.slice(1), "relay"],
  };
  if (JSON.stringify(servers[SERVER]) === JSON.stringify(wanted))
    return undefined;
  if (wanted) servers[SERVER] = wanted;
  else delete servers[SERVER];
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** Claude Desktop's chat only starts stdio servers, so it gets the relay to the shared HTTP server. */
function registerDesktop(command: string[] | undefined, say: Say) {
  const file = desktopConfigFile();
  if (!existsSync(dirname(file))) {
    if (command)
      say(" - Claude Desktop isn't installed, so its chat is skipped.");
    return;
  }
  try {
    const updated = mergeDesktopConfig(
      existsSync(file) ? readFileSync(file, "utf8") : "",
      command,
    );
    if (updated !== undefined) {
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, updated);
      renameSync(temp, file);
    }
    if (command)
      say(
        ` ${OK} Claude Desktop chat connected${updated === undefined ? "" : " (restart the Claude app to pick it up)"}`,
      );
  } catch {
    say(
      ` ${FAIL} Could not read ${file}; left it unchanged. Fix or remove it, then run \`${COMMAND} setup\` again.`,
    );
  }
}

/** Codex gets the stdio relay too, so no bearer token has to live in its config or the shell environment. */
function registerCodex(say: Say) {
  if (run("codex", ["--version"]).missing) return;
  run("codex", ["mcp", "remove", SERVER]);
  const added = run("codex", [
    "mcp",
    "add",
    SERVER,
    "--",
    ...selfCommand(),
    "relay",
  ]);
  say(
    added.ok
      ? ` ${OK} Codex connected`
      : ` ${FAIL} Could not connect Codex: ${added.output.slice(-300)}`,
  );
}

/** The steps after installing, safe to run again: keys, settings, background agent, clients, checks. */
export async function setup(say: Say = console.log) {
  if (process.platform !== "darwin")
    throw new AppError("config", `\`${COMMAND} setup\` needs macOS.`);
  say(
    "Search Scrape MCP: web search, scraping and a remote browser for your AI agents.\n",
  );
  await ensureKeys(say);
  const settings = ensureSettings(say);
  await installAgent(say);
  try {
    await waitForServer(settings);
  } catch {
    // The checks below report it with the fix.
  }
  registerClaudeCode(settings, say);
  registerDesktop(selfCommand(), say);
  registerCodex(say);
  say("\nChecking everything:");
  if (!printChecks(await checks(), say)) {
    say(`\nFix the items marked ${FAIL}, then run \`${COMMAND} setup\` again.`);
    return 1;
  }
  say(
    `\nAll set. Useful commands:\n` +
      `  ${COMMAND} doctor      check that everything works\n` +
      `  ${COMMAND} update      get the latest version\n` +
      `  ${COMMAND} restart     restart the server, for example after changing keys or settings\n` +
      `  ${COMMAND} logs        show recent server logs\n` +
      `  ${COMMAND} uninstall   stop the server and disconnect the clients`,
  );
  return 0;
}

/** Install the latest version, then apply its setup (which restarts the server on the new code). */
export function update(say: Say = console.log) {
  const brew = brewCommand();
  if (brew) {
    say("Updating with Homebrew…");
    if (
      !runVisible("brew", ["update", "--quiet"]) ||
      !runVisible("brew", ["upgrade", COMMAND])
    )
      return fail(
        "Update failed. Fix the Homebrew error above, then try again.",
      );
  } else if (isCheckout()) {
    const repo = checkout();
    say(`Updating the checkout at ${repo} …`);
    if (
      !runVisible("git", ["pull", "--ff-only"], repo) ||
      !runVisible("npm", ["ci"], repo) ||
      !runVisible("npm", ["run", "build"], repo)
    )
      return fail("Update failed. Fix the error above, then try again.");
  } else
    return fail(
      `This copy wasn't installed by Homebrew or from a git checkout, so it can't update itself.`,
    );
  say("\nApplying the new version's setup…");
  const [command, ...args] = selfCommand();
  return runVisible(command!, [...args, "setup"]) ? 0 : 1;
}

function fail(message: string) {
  console.error(message);
  return 1;
}

export function restart(say: Say = console.log) {
  const done = run("launchctl", ["kickstart", "-k", `${domain()}/${LABEL}`]);
  if (!done.ok)
    return fail(`The background agent isn't loaded. Run \`${COMMAND} setup\`.`);
  say("Restarted. Open MCP sessions reconnect on their next call.");
  return 0;
}

/** Stop the server and disconnect the clients. Keys, settings and logs stay. */
export function uninstall(say: Say = console.log) {
  const unloaded = unloadAgent();
  rmSync(plistFile(), { force: true });
  say(
    ` ${OK} Background agent ${unloaded ? "stopped and removed" : "was not loaded"}`,
  );
  if (run("claude", ["mcp", "remove", "--scope", "user", SERVER]).ok)
    say(` ${OK} Claude Code disconnected`);
  registerDesktop(undefined, say);
  if (run("codex", ["mcp", "remove", SERVER]).ok)
    say(` ${OK} Codex disconnected`);
  say(
    `\nYour keys and settings are still in ${dirname(settingsFile())} and logs in ${logsDirectory()}; delete those folders to remove them.` +
      (brewCommand()
        ? `\nTo remove the program: brew uninstall ${COMMAND}`
        : ""),
  );
  return 0;
}
