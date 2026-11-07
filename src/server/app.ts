import type { Config } from "../config/index.js";
import {
  browserScraper,
  scrapflyBrowser,
} from "../providers/scrapfly-browser.js";
import { scrapflyScrape } from "../providers/scrapfly-scrape.js";
import { serper } from "../providers/serper.js";
import { registerBrowser } from "../tools/browser.js";
import { PageCache } from "../tools/page-cache.js";
import { registerScrape } from "../tools/scrape.js";
import { registerSearch } from "../tools/search.js";
import { createMcpHttp } from "./http.js";

export function createApp(config: Config) {
  const search = { serper: serper(config.serperKey) };
  const browser = config.scrapflyKey
    ? { scrapfly: scrapflyBrowser(config.scrapflyKey) }
    : undefined;
  const scrape =
    config.scrapflyKey && browser
      ? {
          scrapfly: scrapflyScrape(config.scrapflyKey),
          "scrapfly-browser": browserScraper(browser.scrapfly),
        }
      : undefined;

  const cache = new PageCache();
  return createMcpHttp(config.token, (mcp) => {
    registerSearch(
      mcp,
      config.searchProviders.map((name) => search[name]),
    );
    if (scrape)
      registerScrape(
        mcp,
        config.scrapeProviders.map((name) => scrape[name]),
        cache,
      );
    if (browser)
      return registerBrowser(
        mcp,
        config.browserProviders.map((name) => browser[name]),
      );
  });
}
