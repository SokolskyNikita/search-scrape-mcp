import { loadConfig } from "../config/index.js";
import { scrapflyScrape } from "../providers/scrapfly-scrape.js";
import { registerScrape } from "../tools/scrape.js";
import { serper } from "../providers/serper.js";
import { registerSearch } from "../tools/search.js";
import { safeError } from "./error.js";
import { createMcpHttp } from "./http.js";

try {
  const config = loadConfig();
  const providers = { serper: serper(config.serperKey) };
  const scrape = config.scrapflyKey && scrapflyScrape(config.scrapflyKey);
  const server = createMcpHttp(config.token, (mcp) => {
    registerSearch(
      mcp,
      config.searchProviders.map((name) => providers[name]),
    );
    if (scrape) registerScrape(mcp, [scrape]);
  });
  server.on("error", () => {
    console.error("Could not bind the MCP loopback port.");
    process.exitCode = 1;
  });
  server.listen(config.port, "127.0.0.1", () =>
    console.log("MCP listening on loopback."),
  );
} catch (error) {
  console.error(safeError(error).message);
  process.exitCode = 1;
}
