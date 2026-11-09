# Search Scrape MCP

One Node process serves MCP clients over Streamable HTTP at
`http://127.0.0.1:8765/mcp`. Each MCP session can open its own remote Scrapfly
browser with one controlled tab.

## Install or upgrade on macOS

Use Node 22 or newer. Put your [Serper](https://serper.dev/) and
[Scrapfly](https://scrapfly.io/) keys in the private dotenv file
`~/.config/search-scrape-mcp/env`. The installer reuses this file if it exists.

```dotenv
SERPER_API_KEY=your-serper-key
SCRAPFLY_API_KEY=your-scrapfly-key
```

```sh
chmod 600 ~/.config/search-scrape-mcp/env
# From the repository directory
./scripts/install.sh
```

The installer builds the project, creates a private `config.json` with a
bearer token on first run, and loads `local.search-scrape-mcp`. Restart the
agent after changing provider keys or settings.

```sh
launchctl print "gui/$(id -u)/local.search-scrape-mcp"
tail -n 30 ~/Library/Logs/search-scrape-mcp/tools.jsonl
launchctl kickstart -k "gui/$(id -u)/local.search-scrape-mcp"
```

To remove the agent, run:

```sh
launchctl bootout "gui/$(id -u)/local.search-scrape-mcp"
rm ~/Library/LaunchAgents/local.search-scrape-mcp.plist
```

## Register clients

From the repository directory, register Claude Code with a `headersHelper`.
The helper reads the token from the private settings file and uses an absolute
Node path, so it works without your shell environment. If upgrading an existing
registration, first run `claude mcp remove --scope user search-scrape`.

```sh
claude mcp add-json --scope user search-scrape "$(node -p '
  const quote = (s) => "\"" + s.replace(/["\\$`]/g, "\\$&") + "\"";
  JSON.stringify({
    type: "http",
    url: "http://127.0.0.1:8765/mcp",
    headersHelper: [process.execPath, process.cwd() + "/scripts/claude-headers.mjs"].map(quote).join(" ")
  })
')"
```

[Claude Code dynamic headers documentation](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication)

For the Codex CLI, load the bearer token in each shell that starts Codex:

```sh
export SEARCH_SCRAPE_TOKEN="$(node -p 'require(process.argv[1]).token' "$HOME/.config/search-scrape-mcp/config.json")"
codex mcp add search-scrape --url http://127.0.0.1:8765/mcp \
  --bearer-token-env-var SEARCH_SCRAPE_TOKEN
```

For GUI Codex without that environment variable, replace the
`bearer_token_env_var` line in `[mcp_servers.search-scrape]` with
`http_headers = { Authorization = "Bearer YOUR_LOCAL_TOKEN" }` in your
private user config. [OpenAI documentation for Codex MCP](https://developers.openai.com/codex/mcp)

For Claude Desktop's local stdio configuration, add this entry under
`mcpServers` in `~/Library/Application Support/Claude/claude_desktop_config.json`.
Use the absolute Node path from `command -v node` and restart Claude Desktop.
The relay forwards requests to the shared HTTP process.
[Claude Desktop local MCP documentation](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers)

```json
{
  "mcpServers": {
    "search-scrape": {
      "command": "/opt/homebrew/bin/node",
      "args": [
        "/Users/YOU/projects2/search-scrape-mcp/dist/server/desktop-relay.js"
      ]
    }
  }
}
```

## Tools

| Tool           | Example arguments                                                | Result                                                              |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `search`       | `{"q":"example"}`                                                | Defaults to 10 results per page, with a maximum of 10.              |
| `search_batch` | `{"searches":[{"q":"example"}]}`                                 | Up to five searches, each with the same per-page limit as `search`. |
| `scrape`       | `{"url":"https://example.com/"}`                                 | Markdown or a saved binary download.                                |
| `scrape_batch` | `{"urls":["https://example.com/"]}`                              | Up to three scrapes.                                                |
| `browser`      | `{"command":{"action":"navigate","url":"https://example.com/"}}` | Open a remote browser tab and return page text.                     |
| `youtube`      | `{"url":"https://youtu.be/0yIfx7JlkiM","transcript":true}`       | Video metadata and optional timestamped captions.                   |

Batches preserve input order and report errors per item. Search batches keep a
duplicate link in its first query, with `also_found_in` listing later query
indices and original ranks. Affected queries report `duplicates_removed`.
Scrape batches start with a per-URL status summary. They run up to two
items concurrently and serialize items for the same hostname. The tool deadline
can interrupt a batch before all items finish.

Results open with the MCP name, operation, and URL or search query when
available. When a result needs a notice, it shows the most relevant MCP-labeled
warning, error, or note. Retry instructions and saved-file paths appear before
the content. A row of `#` characters separates the header from the content and
closes the output. Each batch item gets its own header and divider.
Programmatic clients can read `structuredContent` for results and status fields.
Tool argument errors use the same layout and identify the fields to correct.

Pass `fresh: true` to either scrape tool, a single search, or a search batch item
to bypass the cache. Structured cache hits include `cached: true` and the
insertion timestamp `cached_at`. A cached result is also labeled in the text.

### YouTube

The `youtube` tool accepts watch, Shorts, live, embed, and youtu.be video links. It returns
metadata by default, including a `chapters` array with `start_seconds` and
`title` when the description contains an ordered timestamp list. Set
`transcript: true` to request one caption track.
It prefers original-language captions, then English, and reports when no
captions are available or YouTube rate-limits the request. The transcript's
`text` field contains all caption text in order, with a timestamp at the start
of each occupied 15-second block. Large transcripts return a bounded preview
and a local plain-text file reference. Use `start_seconds` (inclusive) and
`end_seconds` (exclusive) to select captions by their original start times
before grouping them. Excerpts reuse the cached full transcript. Set
`fresh: true` to bypass the MCP result cache. If captions are missing or
unavailable, the result suggests trying a different video. Use `youtube` for
YouTube video links. The scrape and browser tools reject `youtube.com` and
`youtu.be` URLs, including subdomains.

The server runs one yt-dlp job at a time in arrival order. Clients that request
MCP progress get an estimated start and finish when the job joins the queue.
Estimates use 8 seconds for metadata and 20 seconds for transcripts, plus the
configured rest and any active cooldown.

Install yt-dlp with Homebrew on Apple Silicon, or set `YT_DLP_PYTHON` in the
server environment to an absolute path to a Python interpreter with the
`yt_dlp` module installed. The server uses the Homebrew yt-dlp interpreter when
present and falls back to `python3`.

### Search

Provide exactly one of `q` or `query` for the search text in each search.
Double quotes request a phrase and uppercase `OR` requests alternatives,
including between quoted phrases. These operators are passed through to the
search provider, which applies them on a best-effort basis.
Filter by `site`, `exclude_domains`, country (`gl`), language (`hl`), or time (`recency` or `tbs`). Use `page` for
pagination and `autocorrect` to control spelling correction. The `location`
and `gl` fields are best-effort hints. Include the place name in the query when
it matters.
Each search result header identifies the requested page number.

### Scrape

Scrape and browser tools reject URLs on these GitHub domains and their
subdomains: `github.com`, `githubusercontent.com`, `githubassets.com`, `github.io`,
`github.dev`, `githubapp.com`, `githubcopilot.com`, and `ghcr.io`. Use the GitHub
CLI (`gh`) for GitHub repository and API access. Matching results from
`search` and `search_batch` include an `accessHint` recommending `gh`.
Reddit domains (`reddit.com` and `redd.it`, including subdomains) use
`scrape` or `scrape_batch`. The browser rejects those destinations, and
matching search hits include that guidance. Reddit page fetches render
JavaScript with residential IPs by default.

Both scrape tools default to `content_mode: "main"`. Defuddle extracts the
main text from Scrapfly HTML and retains links within that content. Set
`content_mode: "full"` for Scrapfly’s whole-page Markdown without images,
including replies, listings, and details the extractor may omit. The mode
applies to the entire batch and is part of the cache key.

If extraction yields an empty page or mostly navigation, the server can retry
locally with less aggressive filtering on the same HTML. If Defuddle still
cannot reliably extract the main content, the result includes any Markdown
it produced, an `extractionWarning`, and an `htmlPath` to the saved original
HTML on the server. Empty or unusable extraction is reported as
`check.code: "extraction_failed"`. When the HTML contains a meaningful title
or excerpt, the result can also include `fallbackText` within the inline text
limit. For sites without a custom rule, the server can try one stronger fetch
within the deadline and current credit limit. If a separate call is needed,
the result can include retry arguments. Unresolved extractions bypass caching.
To enable Cloud Browser
as a secondary scrape provider, set
`"scrapeProviders": ["scrapfly", "scrapfly-browser"]`. It returns page text
in main mode. Full mode requires the Scrapfly Scrape API.

Results report a page check and the rungs tried. Page scrapes enable Scrapfly
Unblocker and render JavaScript by default. The initial rendered fetch uses
the configured render pool. If a rendered fetch needs escalation, the server
can render with residential IPs. Set `start_rung` to `datacenter` or
`unblocker` to use the static-first ladder, or use `residential_render` to
start with residential rendering. Follow the returned hint when a stronger rung
needs a fresh call.

File URLs and known file hosts get a datacenter HEAD check. File preflight
and download requests use the datacenter pool without Unblocker. Downloads require
a reported length of at most 5 MB. Binary results include a private file path,
MIME type, and byte count. Long scrape and browser text results spill to the
private `outputDirectory` with a preview and local path. The default inline
thresholds are 16,000 characters for `scrape` and 20,000 characters per page
for `scrape_batch`. Set `max_chars` on either tool to cap inline Markdown
per page. When shortened by the effective limit, the result includes a preview,
`truncated: true`, and the path to the full Markdown. The settings below
list the retention limits.

On rare occasions a page is unusually costly to scrape. If the error includes
a `retry` call, run it to allow a higher-cost fetch. For a batch, the retry
call fetches only the affected URL.

### Browser

Use `snapshot` to list viewport controls and headings. Use `scope: "page"`
to include controls outside the viewport or `scope: "full"` for the JSON
accessibility tree. Use `target` to inspect a subtree or `find` to locate
matching elements. For `click`, `fill`, and `press`, pass a ref from the latest
snapshot, such as `"e7"`, or use a CSS or Playwright `selector`.

`click`, `fill`, `press`, `scroll`, and `back` return a viewport snapshot.
`scroll` takes signed `pixels`. `wait` takes up to 10,000 `ms` and an optional
selector. `screenshot` returns a viewport JPEG. The server enables Scrapfly’s
solver on detected challenges, which can incur charges. Use `close` to stop
session charges or `navigate` again after a session expires.

## Settings, costs, and logs

Settings live in `~/.config/search-scrape-mcp/config.json`. Set `MCP_CONFIG`
and `MCP_KEYS_FILE` to override the paths with absolute filenames. Omitting
`SCRAPFLY_API_KEY` leaves search enabled.

Run `npm run config` for effective settings, derived deadlines, usage totals,
and known file or higher-cost hosts. It omits the bearer token. Run
`npm run config:docs` after changing setting definitions. The test suite checks
the generated table.

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
| `mcpConcurrentToolCalls` | `100` | Maximum simultaneous tool calls across all MCP sessions. |
| `scrapeInlineChars` | `16000` | Inline character limit for a single scrape. |
| `scrapeBatchInlineChars` | `20000` | Inline character limit per batch scrape. |
| `browserInlineChars` | `12000` | Inline character limit for browser text output. |
| `outputPreviewChars` | `600` | Preview character limit for saved outputs. |
| `outputDirectory` | `"/tmp/search-scrape-mcp"` | Absolute local spill directory. It must be private and owned by the server user. |
| `outputMaxAgeMs` | `14400000` | Saved output retention in milliseconds. |
| `outputMaxBytes` | `67108864` | Total saved output size cap in bytes. |
| `siteMemoryMs` | `14400000` | How long a hostname's successful rung or protection is remembered in milliseconds. |
| `siteMemorySize` | `256` | Maximum remembered hostnames. Zero disables memory. |
| `statsLogMaxBytes` | `2097152` | Rotate the JSONL stats file at this size in bytes. |
| `searchProviders` | `["serper"]` | Search provider order. |
| `scrapeProviders` | `["scrapfly"]` | Scrape provider order. |
| `browserProviders` | `["scrapfly"]` | Interactive browser provider order. |

<!-- settings:end -->

Provider limits and hostname pacing apply across sessions. The Scrape API and
Serper have independent queues. Hedges, retries, and escalation each consume a
request permit. The admission wait is shared across the attempts for one
scrape or search, and each batch item has its own admission budget within the
batch deadline. A Scrape API HTTP 429 pauses new Scrape API requests for the
reported retry interval. Cloud Browser opens wait separately for a session
lease. Commands on an open session use that existing lease.

A scrape batch returns completed results and individual errors, including for
items that did not finish before the deadline. Clients with their own request
timeout need to allow at least the configured tool deadline plus time to
receive the result.

Each Scrapfly scrape API request has a 100-credit requested budget across all
rungs. If the provider reports a charge above 100 credits, the server stops
automatic retries for that scrape. Scrapfly can bill above the requested budget.
After three reported charges of 100 credits or more for a hostname, subsequent
scrapes of that host require `allow_higher_cost: true`. This flag also selects
the configured higher request budget (200 credits by default).
Browser sessions and binary bandwidth can also incur charges.
[Scrapfly billing documentation](https://scrapfly.io/docs/scrape-api/billing)

The LaunchAgent writes `tools.jsonl` and separate stdout and stderr logs under
`~/Library/Logs/search-scrape-mcp/`. Tool records report outcomes, including
individual batch items. Provider records report requests, known charges, and
Scrapfly proxy and cost details. Logs exclude arguments and fetched content.

## Security and sessions

The server requires a bearer token and accepts requests only on IPv4 loopback
with the exact Host header and no Origin header. Keep the settings file and
client token private. If an expired MCP session returns HTTP 404, reconnect
from the client.

The server validates public HTTP(S) targets and checks reported scrape redirects
and intercepted top-level browser navigations. Browser subresources and iframes
use Scrapfly’s cloud egress. Queries go to Serper, and Scrapfly or the target
site receives URLs and browser input. Treat fetched content as untrusted.
[MCP transport security guidance](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

## Tests

```sh
npm ci
npm test
npm run lint
npm run format:check
npm run smoke
npm run smoke -- --challenge
npm run smoke -- --captcha-form
npm run smoke -- --render
npm run smoke -- --batch
npm run smoke -- --idle
npm run smoke -- --unblocker https://your-protected-test-url.example/
```

Local Chrome tests are opt-in. Run them outside the macOS Codex sandbox:

```sh
MCP_TEST_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm test
```

The offline suite uses fixtures and loopback. The default live smoke test runs a
search, a scrape, and a browser session. The flags above select focused checks.
See [AGENTS.md](AGENTS.md) for live provider budgets and
[the extraction benchmark](benchmarks/extraction/RESULTS.md) for the Defuddle
comparison.
