import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export const COMMAND = "search-scrape-mcp";
/** The name clients know the server by. */
export const SERVER = "search-scrape";
export const LABEL = "local.search-scrape-mcp";

export const OK = "✓";
export const WARN = "!";
export const FAIL = "✗";
export type Say = (line: string) => void;

export const plistFile = () =>
  join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
export const logsDirectory = () => join(homedir(), "Library", "Logs", COMMAND);
export const desktopConfigFile = () =>
  join(
    homedir(),
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json",
  );

/** The Homebrew wrapper sets this to its own path, which survives upgrades (the Cellar path does not). */
export const brewCommand = () => process.env.SEARCH_SCRAPE_MCP_COMMAND;

/** The checkout this build runs from, when it was not installed by Homebrew. */
export const checkout = () => fileURLToPath(new URL("../../", import.meta.url));

/** How launchd and MCP clients start this install: absolute paths, since they don't share the shell's PATH. */
export function selfCommand(): string[] {
  const brew = brewCommand();
  if (brew) return [brew];
  return [stableNode(), fileURLToPath(new URL("./main.js", import.meta.url))];
}

/** Prefer the PATH entry for this Node (such as /opt/homebrew/bin/node) over its versioned real path. */
function stableNode() {
  const running = process.execPath;
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(folder, "node");
    try {
      if (folder && realpathSync(candidate) === realpathSync(running))
        return candidate;
    } catch {
      // Not a Node in this folder.
    }
  }
  return running;
}

export function run(command: string, args: string[], timeout = 60_000) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout });
  return {
    ok: result.status === 0,
    missing:
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

/** Run a command the person should watch (Homebrew, npm), with its output on the terminal. */
export function runVisible(command: string, args: string[], cwd?: string) {
  return spawnSync(command, args, { stdio: "inherit", cwd }).status === 0;
}

export const isCheckout = () =>
  !brewCommand() && existsSync(join(checkout(), ".git"));
