import { RequestLimits } from "./request-limits.js";
import { Usage } from "./usage.js";
import { ResultCache } from "../tools/result-cache.js";
import type { SearchHit, ScrapeResult } from "../providers/types.js";
import type { Config } from "../config/index.js";
import {
  browserScraper,
  scrapflyBrowser,
} from "../providers/scrapfly-browser.js";
import { scrapflyScrape } from "../providers/scrapfly-scrape.js";
import { serper } from "../providers/serper.js";
import { registerBrowser } from "../tools/browser.js";
import { OutputFiles } from "../tools/output-files.js";
import { registerScrape } from "../tools/scrape.js";
import { registerSearch } from "../tools/search.js";
import { createMcpHttp } from "./http.js";

export function createApp(config: Config) {
  const limits = new RequestLimits(config);
  const usage = new Usage(config);
  const searchCache = new ResultCache<SearchHit[]>(config);
  const scrapeCache = new ResultCache<ScrapeResult & { tried: string[] }>(
    config,
  );
  const search = { serper: serper(config.serperKey, config, limits, usage) };
  const browser = config.scrapflyKey
    ? { scrapfly: scrapflyBrowser(config.scrapflyKey, config, limits, usage) }
    : undefined;
  const scrape =
    config.scrapflyKey && browser
      ? {
          scrapfly: scrapflyScrape(config.scrapflyKey, config, limits, usage),
          "scrapfly-browser": browserScraper(browser.scrapfly),
        }
      : undefined;

  const files = new OutputFiles(config.outputDirectory, config);
  files.cleanup();
  const server = createMcpHttp(
    config.token,
    (mcp) => {
      registerSearch(
        mcp,
        config.searchProviders.map((name) => search[name]),
        config,
        searchCache,
      );
      if (scrape)
        registerScrape(
          mcp,
          config.scrapeProviders.map((name) => scrape[name]),
          files,
          config,
          scrapeCache,
        );
      if (browser)
        return registerBrowser(
          mcp,
          config.browserProviders.map((name) => browser[name]),
          files,
          config,
        );
    },
    config,
  );
  const cleanup = setInterval(
    () => {
      try {
        files.cleanup();
      } catch {
        console.error("Could not clean up saved tool outputs.");
      }
    },
    Math.min(15 * 60_000, config.outputMaxAgeMs),
  ).unref();
  server.once("close", () => clearInterval(cleanup));
  return server;
}
