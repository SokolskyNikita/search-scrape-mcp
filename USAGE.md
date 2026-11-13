# Using Search Scrape MCP

The server runs on your Mac as a background process at `http://127.0.0.1:8765/mcp` and is shared by all your MCP clients.

## Setup

You need a Mac with [Homebrew](https://brew.sh).

### 1. Get your API keys

| Provider | Used for | Where to get the key |
| --- | --- | --- |
| [Serper](https://serper.dev/) (required) | `search`, `search_batch` | [Sign up](https://serper.dev/signup), then copy the key from the [API keys page](https://serper.dev/api-keys). |
| [Scrapfly](https://scrapfly.io/) (optional) | `scrape`, `scrape_batch`, `browser` | [Register](https://scrapfly.io/register), then copy the **Live** key shown at the top of your dashboard ([where to find it](https://scrapfly.io/docs/project)). Each project also has a Test key; don't use that one. |

Both providers give free credits on signup without a credit card (2,500 searches from Serper and 1,000 credits from Scrapfly at the time of writing). The `youtube` tool needs no key.

### 2. Install

```sh
brew tap sokolskynikita/search-scrape https://github.com/SokolskyNikita/search-scrape-mcp
```

```sh
brew trust sokolskynikita/search-scrape
```

```sh
brew install search-scrape-mcp
```

Recent versions of Homebrew require `brew trust` for a tap outside Homebrew itself. Node and yt-dlp are installed as dependencies.

### 3. Run setup

```sh
search-scrape-mcp setup
```

Setup asks for the two keys (typing is hidden; press Enter to skip Scrapfly), then:

- saves the keys to the private file `~/.config/search-scrape-mcp/env`;
- creates `~/.config/search-scrape-mcp/config.json` with a bearer token;
- starts the server as the background agent `local.search-scrape-mcp`, which also starts at login;
- connects Claude Code, the Claude desktop app and the Codex CLI, whichever are installed;
- checks that everything works and says what to fix if something doesn't.

It is safe to run again, and reuses the keys and token it finds.

### 4. Try it

Restart the Claude desktop app so its chat picks up the connection. New Claude Code and Codex sessions pick it up on their own. Then ask your agent to search the web for something.

To add or change a key later, edit `~/.config/search-scrape-mcp/env` and run `search-scrape-mcp restart`:

```dotenv
SERPER_API_KEY=your-serper-key
SCRAPFLY_API_KEY=your-scrapfly-key
```

## Commands

| Command | What it does |
| --- | --- |
| `search-scrape-mcp update` | Installs the latest version, restarts the server and reapplies setup. |
| `search-scrape-mcp doctor` | Checks keys, settings, the background agent, the running server and each client. |
| `search-scrape-mcp restart` | Restarts the server. Run it after changing keys or settings. |
| `search-scrape-mcp logs` | Shows the end of the server's error log and tool log. |
| `search-scrape-mcp uninstall` | Stops the background agent and disconnects the clients. Keys, settings and logs stay. |
| `search-scrape-mcp --version` | Prints the installed version. |

Updating or restarting ends open MCP sessions and closes any open remote browser tab. Clients start a new session on their next call.

To remove the program, run `search-scrape-mcp uninstall` and then `brew uninstall search-scrape-mcp`.

## Other MCP clients

Setup registers the server as `search-scrape` in each client it finds. To connect another client, use either of these:

- **stdio:** run `/opt/homebrew/bin/search-scrape-mcp relay`. It forwards to the running server, and no token goes in the client's configuration. Claude Desktop and Codex are connected this way.
- **Streamable HTTP:** connect to `http://127.0.0.1:8765/mcp` with the header `Authorization: Bearer TOKEN`, using the `token` value from `config.json`. Claude Code is connected this way, and runs `search-scrape-mcp headers` to read the token on each connection.

## Tools

| Tool | Example arguments | Result |
| --- | --- | --- |
| `search` | `{"q":"example"}` | Up to 10 results per page. |
| `search_batch` | `{"searches":[{"q":"example"}]}` | Up to five searches. |
| `scrape` | `{"url":"https://example.com/"}` | Markdown or a saved binary download. |
| `scrape_batch` | `{"urls":["https://example.com/"]}` | Up to three scrapes. |
| `browser` | `{"command":{"action":"navigate","url":"https://example.com/"}}` | A remote browser tab, one per MCP session, returning page text. |
| `youtube` | `{"url":"https://youtu.be/0yIfx7JlkiM","transcript":true}` | Video metadata and optional timestamped captions. |

**Results.** Each result opens with the MCP name, the operation, and the URL or query. A notice (warning, error or note), retry instructions and saved-file paths come before the content. A row of `#` characters separates the header from the content and closes the output. Programmatic clients can read `structuredContent` for results and status fields. Tool argument errors use the same layout and name the fields to correct.

**Batches.** Batches preserve input order, give each item its own header, and report errors per item, including for items the tool deadline cut off. A search batch keeps a duplicate link in its first query, with `also_found_in` listing the later query indices and original ranks; affected queries report `duplicates_removed`. A scrape batch starts with a per-URL status summary, runs up to two items at once, and runs items for the same hostname one after another.

**Cache.** Pass `fresh: true` to `search`, either scrape tool, `youtube`, or a search batch item to bypass the result cache. Cached results are labeled in the text and carry `cached: true` and the insertion timestamp `cached_at`.

### Search

Provide exactly one of `q` or `query` per search. Double quotes request a phrase and uppercase `OR` requests alternatives, including between quoted phrases; Serper applies these on a best-effort basis. Filter by `site`, `exclude_domains`, country (`gl`), language (`hl`), or time (`recency` or `tbs`). Use `page` for pagination and `autocorrect` to control spelling correction. `location` and `gl` are best-effort hints, so include the place name in the query when it matters.

### Scrape

**Content mode.** The default `content_mode: "main"` has Defuddle extract the main text from Scrapfly's HTML, keeping the links in it. `content_mode: "full"` returns Scrapfly's whole-page Markdown without images, including replies, listings, and details the extractor may omit. The mode applies to a whole batch and is part of the cache key.

**When extraction falls short.** If extraction yields an empty page or mostly navigation, the server retries locally with less aggressive filtering on the same HTML. If that still fails, the result has `check.code: "extraction_failed"`, any Markdown produced, an `extractionWarning`, an `htmlPath` to the saved original HTML, and `fallbackText` when the HTML has a meaningful title or excerpt. For sites without a custom rule, the server can try one stronger fetch within the deadline and credit limit; if a separate call is needed, the result includes retry arguments. Unresolved extractions are not cached.

**Fetch ladder.** Results report a page check and the rungs tried. Page scrapes use Scrapfly Unblocker and render JavaScript by default, starting on the configured render pool and escalating to residential IPs if needed. Set `start_rung` to `datacenter` or `unblocker` for the static-first ladder, or to `residential_render` to start with residential rendering. Follow the returned hint when a stronger rung needs a fresh call. If an error includes a `retry` call, run it to allow a higher-cost fetch; in a batch it fetches only the affected URL.

**Files.** File URLs and known file hosts get a HEAD check and are downloaded through the datacenter pool without Unblocker. Downloads need a reported length of at most 5 MB. Binary results include a private file path, MIME type, and byte count.

**Long output.** Text beyond the inline limit (16,000 characters for `scrape`, 20,000 per page for `scrape_batch`) is saved to the private `outputDirectory`, and the result has a preview, `truncated: true`, and the path to the full Markdown. Set `max_chars` to lower the limit per page.

**Sites with their own route.** Some sites are rejected by the scrape tools, the browser, or both. Matching search results carry a hint saying what to use:

- GitHub (`github.com`, `githubusercontent.com`, `githubassets.com`, `github.io`, `github.dev`, `githubapp.com`, `githubcopilot.com`, `ghcr.io`, and subdomains): rejected by both. Use the GitHub CLI (`gh`).
- YouTube (`youtube.com`, `youtu.be`, and subdomains): rejected by both. Use the `youtube` tool.
- Reddit (`reddit.com`, `redd.it`, and subdomains): rejected by the browser only. Use `scrape` or `scrape_batch`, which render Reddit with residential IPs by default.

To add Cloud Browser as a second scrape provider, set `"scrapeProviders": ["scrapfly", "scrapfly-browser"]`. It returns page text in main mode only.

### Browser

Use `snapshot` to list the viewport's controls and headings. `scope: "page"` includes controls outside the viewport and `scope: "full"` returns the JSON accessibility tree. Use `target` to inspect a subtree or `find` to locate matching elements. For `click`, `fill`, and `press`, pass a ref from the latest snapshot, such as `"e7"`, or a CSS or Playwright `selector`.

`click`, `fill`, `press`, `scroll`, and `back` return a viewport snapshot. `scroll` takes signed `pixels`. `wait` takes up to 10,000 `ms` and an optional selector. `screenshot` returns a viewport JPEG. Long text output is saved the same way as for scrapes. The server enables Scrapfly's solver on detected challenges, which can incur charges. Use `close` to stop session charges, or `navigate` again after a session expires.

### YouTube

The tool accepts watch, Shorts, live, embed, and youtu.be links. It returns metadata by default, including `duration` in seconds, and `channel_id` and `uploader_id` when available. Chapters have `start_seconds` and `title`; they come from yt-dlp, or from an ordered timestamp list in the description.

Set `transcript: true` for one caption track: original-language captions if available, then English. The `text` field holds all caption text in order, with a timestamp at the start of each occupied 15-second block. Use `start_seconds` (inclusive) and `end_seconds` (exclusive) to select captions by their start times; excerpts reuse the cached full transcript. Large transcripts return a preview and a local plain-text file. The result says when no captions are available or YouTube rate-limits the request.

The server runs one yt-dlp job at a time, in arrival order. Clients that request MCP progress get an estimated start and finish when the job joins the queue (8 seconds for metadata and 20 for transcripts, plus the configured rest and any cooldown).

## Settings

Settings live in `~/.config/search-scrape-mcp/config.json`. Run `search-scrape-mcp restart` after changing them. To keep the settings or keys elsewhere, set `MCP_CONFIG` and `MCP_KEYS_FILE` to absolute filenames.

<!-- settings:start -->

<!-- prettier-ignore -->
| Setting | Default | Description |
| --- | --- | --- |
| `port` | `8765` | Local MCP HTTP port. |
| `scrapflyFileHosts` | `[]` | Seed hostnames that always get a Scrapfly HEAD check. |
| `serperRequestsPerMinute` | `60` | Server-wide Serper request rate, including hedges. |
| `scrapflyRequestsPerMinute` | `30` | Server-wide Scrapfly scrape request rate, including retries and escalation. |
| `serperBurstCapacity` | `20` | Maximum accumulated Serper request tokens. |
| `scrapflyBurstCapacity` | `10` | Maximum accumulated Scrapfly scrape request tokens. |
| `youtubeJobGapMs` | `5000` | Rest after a yt-dlp job exits. At most one job runs at a time. |
| `youtubeLimitWaitMs` | `240000` | Maximum wait for a yt-dlp job permit, within the tool deadline. |
| `youtubeRequestGapMs` | `3000` | Delay between yt-dlp extraction requests and before the caption fetch. |
| `youtubeCooldownMs` | `120000` | Server-wide yt-dlp cooldown after an HTTP 429. |
| `providerConcurrency` | `5` | Maximum in-flight HTTP attempts per provider across all sessions. |
| `providerGapMs` | `500` | Minimum time between HTTP attempt starts for each provider. |
| `localLimitWaitMs` | `210000` | Maximum wait for a provider or hostname permit, within the call deadline. |
| `siteConcurrency` | `5` | Maximum simultaneous requests per target hostname. |
| `siteGapMs` | `1000` | Minimum time between request starts for the same target hostname. |
| `browserConcurrency` | `5` | Maximum simultaneous Cloud Browser sessions, including scrape fallback. |
| `browserDailyMinutes` | `120` | Daily Cloud Browser session-minutes across all sessions. Resets at midnight UTC. |
| `cacheTtlMs` | `600000` | Successful tool result cache lifetime in milliseconds. Zero disables caching. |
| `cacheMaxEntries` | `128` | Maximum entries in each result cache. |
| `cacheMaxBytes` | `16000000` | Maximum serialized bytes in each result cache. |
| `toolDeadlineSeconds` | `270` | Overall tool deadline in seconds (35–600). The relay allows three additional seconds. |
| `serperBackupDelayMs` | `4500` | Delay before hedging a slow Serper request. Transient failures can trigger an earlier backup. |
| `serperTimeoutMs` | `12000` | Shared Serper primary and backup budget in milliseconds, within the tool deadline. |
| `searchGl` | `"us"` | Default Serper country code. |
| `searchHl` | `"en"` | Default Serper language code. |
| `scrapflyCountry` | `"us"` | Scrapfly proxy country. Set null to let Scrapfly choose. |
| `scrapflyExpensiveCost` | `200` | Scrapfly requested cost budget in credits with allow_higher_cost enabled. |
| `scrapflyDatacenterPool` | `"public_datacenter_pool"` | Proxy pool sent on the datacenter rung. |
| `scrapflyUnblockerPool` | `"public_datacenter_pool"` | Initial proxy pool sent on the Unblocker rung. |
| `scrapflyRenderPool` | `"public_datacenter_pool"` | Initial proxy pool sent on the rendering rung. |
| `scrapflyRenderingWaitMs` | `1000` | Scrapfly rendering wait in milliseconds. |
| `captchaWaitMs` | `40000` | Maximum CAPTCHA challenge wait in milliseconds, within the tool deadline. |
| `browserSessionSeconds` | `1800` | Maximum remote browser session length in seconds. |
| `browserIdleMs` | `150000` | Close a browser after this many idle milliseconds. |
| `mcpSessionExpiryMs` | `7200000` | Expire idle MCP sessions after this many milliseconds. |
| `mcpSessionLimit` | `128` | Maximum number of MCP sessions. |
| `mcpSessionInFlightLimit` | `8` | Maximum simultaneous MCP requests per session. |
| `mcpSessionBusyWaitMs` | `5000` | Wait up to this many milliseconds for a free per-session slot before rejecting a request. |
| `mcpConcurrentToolCalls` | `100` | Maximum simultaneous tool calls across all MCP sessions. |
| `scrapeInlineChars` | `16000` | Inline character limit for a single scrape. |
| `scrapeBatchInlineChars` | `20000` | Inline character limit per batch scrape. |
| `browserInlineChars` | `12000` | Inline character limit for browser text output. |
| `outputPreviewChars` | `600` | Preview character limit for saved outputs. |
| `outputDirectory` | `"/tmp/search-scrape-mcp"` | Absolute local spill directory. It must be private and owned by the server user. |
| `outputMaxAgeMs` | `14400000` | Saved output retention in milliseconds. |
| `outputMaxBytes` | `67108864` | Total saved output size cap in bytes. |
| `siteMemoryMs` | `14400000` | How long a hostname's successful rung or protection is remembered in milliseconds. |
| `providerDownMemoryMs` | `300000` | After a scrape fails with provider_down, fail the same URL fast for this many milliseconds unless fresh is set. Zero disables it. |
| `siteMemorySize` | `256` | Maximum remembered hostnames. Zero disables memory. |
| `statsLogMaxBytes` | `10485760` | Rotate the JSONL stats file at this size in bytes. |
| `statsLogFiles` | `5` | Rotated JSONL stats files to keep, including the current one. |
| `searchProviders` | `["serper"]` | Search provider order. |
| `scrapeProviders` | `["scrapfly"]` | Scrape provider order. |
| `browserProviders` | `["scrapfly"]` | Interactive browser provider order. |

<!-- settings:end -->

## Limits and costs

Provider limits and hostname pacing apply across all sessions. Serper and the Scrape API have separate queues, and each hedge, retry, and escalation uses a request permit. The wait for a permit is shared across the attempts for one scrape or search; each batch item has its own within the batch deadline. A Scrape API HTTP 429 pauses new Scrape API requests for the reported retry interval. Opening a Cloud Browser session waits separately for a session lease.

Clients with their own request timeout need to allow at least the configured tool deadline plus time to receive the result.

Each scrape has a requested budget of 100 Scrapfly credits across all rungs, and automatic retries stop if Scrapfly reports a higher charge. Scrapfly can bill above the requested budget. After three reported charges of 100 credits or more for a hostname, scrapes of that host require `allow_higher_cost: true`, which also selects the higher budget (`scrapflyExpensiveCost`). Browser sessions and binary bandwidth can also incur charges. [Scrapfly billing documentation](https://scrapfly.io/docs/scrape-api/billing)

## Logs

The background agent writes `tools.jsonl`, `stdout.log` and `stderr.log` under `~/Library/Logs/search-scrape-mcp/`. Tool records report outcomes, including individual batch items. Provider records report requests, known charges, and Scrapfly proxy and cost details. Every record carries the server version, a per-process `runId` and, for tool calls, a `requestId` shared by the call, its batch items and its provider attempts. Crashes are recorded as `crash` events. Logs exclude arguments and fetched content.

From a checkout, two scripts summarize usage:

- `node scripts/stats.mjs [--since 36h] [--json]` summarizes the stats log: tools, durations, credits by rung, attempts over budget, failing hosts, repeated failures, limits and crashes. `--export DIR` copies the logs; `--archive` copies them to `archive/` in the log folder and empties them.
- `python3 -I scripts/session-stats.py [--hours 36]` reads Claude Code transcripts and reports the errors clients saw from search-scrape, matched with server calls that finished after the client gave up.

## Security and sessions

The server requires the bearer token and accepts requests only on IPv4 loopback, with the exact Host header and no Origin header. Keep `config.json` private. If an expired MCP session returns HTTP 404, reconnect from the client.

The server validates that targets are public HTTP(S) addresses, and checks reported scrape redirects and intercepted top-level browser navigations. Browser subresources and iframes use Scrapfly's cloud egress. Queries go to Serper, and URLs and browser input go to Scrapfly and the target site. Treat fetched content as untrusted. [MCP transport security guidance](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

## Development

To run the server from a git checkout instead of Homebrew, you need Node 22 or newer, and yt-dlp for the `youtube` tool (from Homebrew, or set `YT_DLP_PYTHON` in the server environment to a Python interpreter that has the `yt_dlp` module).

```sh
./scripts/install.sh
```

The script builds the project and runs the same setup, pointing the background agent and the clients at the checkout. The commands above then run as `node dist/cli/main.js COMMAND`; `update` pulls and rebuilds.

```sh
npm ci
npm test
npm run lint
npm run format:check
npm run smoke
```

`npm test` is offline, using fixtures and loopback. Its local Chrome tests are opt-in, and need to run outside the macOS Codex sandbox:

```sh
MCP_TEST_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm test
```

`npm run smoke` spends provider credits: it runs a live search, scrape, and browser session. Add `-- --challenge`, `-- --captcha-form`, `-- --render`, `-- --batch`, `-- --idle`, or `-- --unblocker URL` for a focused check. See [AGENTS.md](AGENTS.md) for the live testing budget and [the extraction benchmark](benchmarks/extraction/RESULTS.md) for the Defuddle comparison.

`npm run config` prints the effective settings, derived deadlines, usage totals, and known file or higher-cost hosts, without the bearer token. After changing setting definitions, run `npm run config:docs` to regenerate the table above; the test suite checks it.

To release a version to Homebrew users, run `scripts/release.sh VERSION` from an up-to-date `main`. It runs the tests, tags the release and points `Formula/search-scrape-mcp.rb` at it.
