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
  const search = { serper: serper(config.serperKey, config) };
  const browser = config.scrapflyKey
    ? { scrapfly: scrapflyBrowser(config.scrapflyKey, config) }
    : undefined;
  const scrape =
    config.scrapflyKey && browser
      ? {
          scrapfly: scrapflyScrape(config.scrapflyKey, config),
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
      );
      if (scrape)
        registerScrape(
          mcp,
          config.scrapeProviders.map((name) => scrape[name]),
          files,
          config,
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
