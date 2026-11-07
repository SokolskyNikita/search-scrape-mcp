import { loadConfig } from "../config/index.js";
import { createApp } from "./app.js";
import { safeError } from "./error.js";

try {
  const config = loadConfig();
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
