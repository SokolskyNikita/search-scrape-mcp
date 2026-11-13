#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadSettings } from "../config/index.js";
import { version } from "../config/version.js";
import { safeError } from "../server/error.js";
import { COMMAND, logsDirectory } from "./paths.js";

const HELP = `${COMMAND} ${version}: web search, scraping and a remote browser for your AI agents.

Usage: ${COMMAND} <command>

  setup       after installing: save your keys, start the server, connect Claude Code,
              Claude Desktop and Codex, and check everything (safe to run again)
  update      install the latest version, then apply its setup
  doctor      check that everything works
  restart     restart the server, for example after changing keys or settings
  logs        show recent server logs
  uninstall   stop the server and disconnect the clients

Used by the background agent and the clients:
  serve       run the MCP server on 127.0.0.1
  relay       stdio relay to the running server
  headers     print the authorization header for Claude Code
`;

async function main(command: string | undefined): Promise<number> {
  switch (command) {
    case "serve":
      await import("../server/main.js");
      return 0;
    case "relay":
      await import("../server/desktop-relay.js");
      return 0;
    case "headers":
      process.stdout.write(
        JSON.stringify({ Authorization: `Bearer ${loadSettings().token}` }),
      );
      return 0;
    case "setup":
      return (await import("./install.js")).setup();
    case "update":
      return (await import("./install.js")).update();
    case "restart":
      return (await import("./install.js")).restart();
    case "uninstall":
      return (await import("./install.js")).uninstall();
    case "doctor": {
      const { checks, printChecks } = await import("./doctor.js");
      return printChecks(await checks()) ? 0 : 1;
    }
    case "logs": {
      const logs = logsDirectory();
      spawnSync(
        "tail",
        ["-n", "30", `${logs}/stderr.log`, `${logs}/tools.jsonl`],
        { stdio: "inherit" },
      );
      console.log(`\n(logs: ${logs})`);
      return 0;
    }
    case "--version":
    case "-v":
      console.log(`${COMMAND} ${version}`);
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

try {
  const code = await main(process.argv[2]);
  if (code) process.exitCode = code;
} catch (error) {
  console.error(safeError(error).message);
  process.exitCode = 1;
}
