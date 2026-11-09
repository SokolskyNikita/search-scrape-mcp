# Search Scrape MCP

I built this because I wanted a web research MCP for coding agents that could recover from a bad scrape on its own and show me what each attempt cost.

The MCP server runs on your Mac. It gets Google results through Serper, fetches pages and runs interactive browser sessions through Scrapfly, and uses yt-dlp to fetch metadata and captions directly from YouTube. Defuddle extracts the main text from fetched HTML locally.

[Bright Data MCP](https://github.com/brightdata/brightdata-mcp) covers more sites with dedicated scrapers. This project focuses on the search-and-read loop.

- **Readable pages.** Extract the main text with links, retry extraction on the same HTML, and save the source locally if extraction still falls short.
- **Visible scrape costs.** Set a credit budget per scrape. Logs show which fetch strategy ran and what Scrapfly reported charging. Higher-cost retries can require explicit opt-in.
- **Results agents can reuse.** Deduplicate links across search queries, cache repeat requests, and return timestamped YouTube captions with time-range excerpts.

[Install and connect a client](USAGE.md#install-or-upgrade-on-macos) · [MIT](LICENSE)
