import { loadConfig } from "../config/index.js";
import { createApp } from "./app.js";
import { safeError } from "./error.js";
import { writeCrash } from "./stats.js";

try {
  const config = loadConfig();
  // Record crashes in the stats log with a timestamp before exiting, so they can be
  // matched with tool calls. launchd restarts the server.
  const crash = (kind: string) => (error: unknown) => {
    writeCrash(kind, error, config);
    console.error(
      `${new Date().toISOString()} ${kind}:`,
      error instanceof Error ? (error.stack ?? error.message) : typeof error,
    );
    process.exit(1);
  };
  process.on("uncaughtException", crash("uncaughtException"));
  process.on("unhandledRejection", crash("unhandledRejection"));
  const server = createApp(config);
  server.on("error", () => {
    console.error("Could not bind the MCP loopback port.");
    process.exitCode = 1;
  });
  server.listen(config.port, "127.0.0.1", () =>
    console.log("MCP listening on loopback."),
  );
  function stop() {
    server.close();
    server.closeAllConnections();
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  console.error(safeError(error).message);
  process.exitCode = 1;
}
