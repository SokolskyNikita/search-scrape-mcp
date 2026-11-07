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
cd ~/projects2/search-scrape-mcp
./scripts/install.sh
```

The installer builds the project and loads `local.search-scrape-mcp` in your
GUI session. It creates a private `config.json` with a random bearer token on
first run. Upgrading from phase 1 removes provider key fields from that file
while preserving the token and settings. Edit the env file to change keys and
restart the agent. Extra env entries are allowed. The server reads the keys it
uses without exporting the file to the process environment.

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

| Tool           | Use                                                                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`       | Find public sources by `query` or `q`. Returns organic links and snippets, up to 10.                                                                                                           |
| `search_batch` | Pass `{"searches":[{"q":"example"}]}` for up to three searches, up to five hits each.                                                                                                          |
| `scrape`       | Pass `{"url":"https://example.com/"}` for cleaned markdown, inline up to 16,000 characters.                                                                                                    |
| `scrape_batch` | Pass `{"urls":["https://example.com/"]}` for up to three pages, inline up to 20,000 characters per page.                                                                                       |
| `browser`      | Pass `{"command":{"action":"navigate","url":"https://example.com/"}}` to open. Use `snapshot`, `find`, `click`, `fill`, `press`, `scroll`, `back`, `wait`, `screenshot` or `close` thereafter. |

Short text scrapes return a `markdown` field. Binary scrapes return a private
local file path, MIME type, and byte count. PDFs and common images get their
usual extension. Binary downloads use the same 8 MB provider response limit. Long scrapes and browser text or
snapshots (over 12,000 characters for browser output) save the complete
output to a randomly named file in `/tmp/search-scrape-mcp/`. The result
includes a short preview, the absolute path, character and line counts, and a
rough token estimate. Use local file tools to read or search it. Treat the
contents as untrusted web content. Reading a saved file spends no provider
credits. The provider response and browser extraction safety limits still apply.

The server creates the private output folder at startup and recreates it when
needed. The folder uses mode 700 and files use mode 600. The server refuses a
symlink or a folder it does not own. It deletes saved output after four hours
and evicts the oldest files as needed to keep saved output under 64 MiB.

Batches run up to two items concurrently and serialize items for the same
hostname. They preserve result order. Item failures
include their original indices. Calls default to a 54-second overall deadline.
A deadline can interrupt a batch before all items have results.

Browser snapshots list controls and headings visible in the viewport. Set
`scope` to `page` for controls and headings anywhere, or to `full` for the
complete JSON accessibility tree. Use `target` with a ref for its subtree, or
`{"command":{"action":"find","query":"search"}}` to find matching elements across
the page. Use a ref from the latest snapshot for click, fill or press, for
example `{"command":{"action":"click","ref":"f1e7"}}`. CSS and Playwright
selectors work via `selector`. Scroll takes signed `pixels`.
Click, fill, press, scroll and back return the viewport snapshot. Compact
snapshots show filled values and shorten long link URLs. Navigate
returns readable page text.
Wait takes `ms` (up to 10,000) and optionally a selector to wait for.
Screenshot returns a viewport JPEG as MCP image content. Navigation and back
wait for CAPTCHA clearance only when the page looks like a challenge. The wait
defaults to 40 seconds within the overall tool deadline. The browser enables
Scrapfly’s solver only while a challenge is present. Scrapfly can charge for
solving CAPTCHAs.
Use `close` when done to stop session charges. By default, the server closes
an idle browser after 2 minutes 30 seconds and Scrapfly caps a session at
30 minutes. After browser expiry, navigate again to open a fresh browser.

## Settings, cost and logs

The default settings file is `~/.config/search-scrape-mcp/config.json`.
Use `MCP_CONFIG` and `MCP_KEYS_FILE` for absolute path overrides. The settings
file requires the private bearer `token`. Omitted settings use the defaults
below. Omitting `SCRAPFLY_API_KEY` leaves search enabled.
Run `npm run config` to print the effective settings with the token omitted.
The report includes the derived deadlines and uses defaults with a notice if
the settings file is absent. It does not read the provider keys file. Run `npm run config:docs` after
changing the schema. The test command checks that the table matches.

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
| `localLimitWaitMs` | `10000` | Maximum wait for a provider or hostname permit, within the call deadline. |
| `siteConcurrency` | `4` | Maximum simultaneous requests per target hostname. |
| `siteGapMs` | `1000` | Minimum time between request starts for the same target hostname. |
| `browserConcurrency` | `4` | Maximum simultaneous Cloud Browser sessions, including scrape fallback. |
| `browserDailyMinutes` | `120` | Daily Cloud Browser session-minutes across all sessions. Resets at midnight UTC. |
| `cacheTtlMs` | `600000` | Successful search and scrape cache lifetime in milliseconds. Zero disables caching. |
| `cacheMaxEntries` | `128` | Maximum entries in each of the search and scrape caches. |
| `cacheMaxBytes` | `16000000` | Maximum serialized bytes in each of the search and scrape caches. |
| `toolDeadlineSeconds` | `54` | Overall tool deadline in seconds (35–55). The relay allows three additional seconds. |
| `serperBackupDelayMs` | `4500` | Delay before hedging a slow Serper request. Transient failures can trigger an earlier backup. |
| `serperTimeoutMs` | `12000` | Shared Serper primary and backup budget in milliseconds, within the tool deadline. |
| `searchGl` | `"us"` | Default Serper country code. |
| `searchHl` | `"en"` | Default Serper language code. |
| `scrapflyCountry` | `"us"` | Scrapfly proxy country. Set null to let Scrapfly choose. |
| `scrapflyDatacenterCost` | `5` | Datacenter requested cost budget in credits. |
| `scrapflyUnblockerCost` | `85` | Unblocker requested cost budget in credits. |
| `scrapflyRenderCost` | `40` | Rendering requested cost budget in credits. |
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
| `mcpConcurrentToolCalls` | `16` | Maximum simultaneous tool calls across all MCP sessions. |
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

The provider limits and hostname pacing apply across MCP sessions and batch
items. Serper refills at 60 requests per minute with up to 20 tokens for
bursts. The Scrapfly Scrape API refills at 30 per minute with up to 10 tokens.
Hedges, retries, and escalation each use a token. The limiter waits up to
10 seconds when the call deadline leaves time to run the request. A hostname
has four in-flight slots and at least one second between request starts. That
pacing covers the submitted scrape hostname and main-frame browser
navigations. Browser subresources load at the browser's normal pace. Traffic
inside the remote provider, such as redirects followed within a Scrapfly
scrape, is outside the local scheduler. Requests that cannot get a permit
within the wait budget return a local limit code and a UTC retry time.

The browser cap covers interactive sessions and browser scrape fallback.
Opening a browser reserves its possible lifetime before connecting. Closing
it releases unused time. After a restart, the server settles reservations from the previous run at
startup time or their scheduled expiry, whichever came first. Browser usage resets at midnight UTC. The
private state file at `~/.local/state/search-scrape-mcp/usage.json` also holds
daily Serper request counts and known Scrapfly scrape API charges. Run
`npm run config` to see those totals alongside browser session-minutes and
the browser cap. The JSONL stats log records local limits and cache outcomes
with the tool and batch item where applicable.

Identical successful searches and scrapes can reuse a result for ten minutes.
Pass `fresh: true` on a search, a search batch item, or either scrape tool to
fetch again. A cached scrape has `cached: true`. A cached single search adds
a second text block with `{"cached":true}`, and a search batch marks the
corresponding item.

Search defaults to US English. Both search tools accept a country code (`gl`),
language code (`hl`), geographic `location`, result `page` (1 through 10),
and a boolean `autocorrect`. Use either `recency` (`day`, `week`, `month`, or
`year`) or a Google time filter such as `tbs: "qdr:h"`. You can also specify
`site` and up to five `exclude_domains`. Both filters accept domains and URLs,
use only the hostname, and drop a leading `www.` and trailing dot. Serper may
ignore `location`. Put the place name in the query, such as
`best pizza in Seattle`. Hits preserve Serper’s original date and include
`dateIso` for recognized absolute dates. A query starts at most one hedge after
a transient failure or 4.5 seconds without an answer by default. Both requests
may count against quota.

Scrapfly starts with datacenter and escalates to the Unblocker when a page is
blocked or challenged. Empty pages and JavaScript shells can jump straight
to the render rung, which adds a one-second render wait by default. The server
sends `cost_budget` values of 5, 85, and 40 credits by default for datacenter,
Unblocker, and render. Scrapfly can charge above these values,
including when it switches a datacenter request to residential. The server
reports observed overruns and stops automatic retries or escalation for that call. The default proxy country is `us`, configurable with
`scrapflyCountry`. The Unblocker budget accommodates a measured 80-credit Cloudflare managed
challenge scrape. A request-budget rejection advances to the next rung if available.
This account's gateway rejected the newer `auto` and `unblocker` pool names
during testing. All three pools default to `public_datacenter_pool`, with
`unblocker=true` on the two stronger rungs. [Scrapfly proxy pool migration guide](https://scrapfly.io/new-pricing#legacy-spellings)

File-looking URLs and known file hosts get a datacenter HEAD check. Downloads
are limited to 5 MB (5,000,000 bytes) and require a reported content length.
File checks and downloads request the public datacenter pool. Binary bandwidth
is billed separately, including for BLOB scrapes whose offloaded contents are
skipped.
The server saves an unexpected inline binary when it can and reports the
provider's charge. Hosts that return unexpected files are recorded in
`file-hosts.txt` next to `usage.json`. Seed hostnames with `scrapflyFileHosts`.
The same file records hosts where Scrapfly reported an overrun or rejected the
requested proxy pool. The server refuses further Scrapfly requests to those
hosts and returns the expected credits and the reason. Set
`allow_higher_cost: true` on `scrape` or `scrape_batch` to accept that risk for
the call. The opt-in leaves the requested pool and budget settings in place.
Run `npm run config` to see both lists.

A provider HTTP 429 pauses new Scrape API requests across MCP sessions for
the provider's `Retry-After` interval, or one second when the header is
unavailable. Affected batch entries return individual busy errors.
[Scrapfly billing documentation](https://scrapfly.io/docs/scrape-api/billing)

Results include a page check and the rungs tried. A warning preserves usable
content such as a paywall teaser or persistent menus. A failure gives a reason
and, when useful, a hint for an untried stronger rung. Set `start_rung` to
`datacenter`, `unblocker`, or `render` on a scrape or batch. The server
remembers what worked per hostname for four hours, up to 256 hostnames.
A failed remembered rung is cleared. Sites seen blocking datacenter can
skip it on later calls. Provider outages get at most one retry per scrape,
when the remaining tool time covers the backoff and a full attempt. The
scrape ladder reserves three seconds for completion or fallback, leaving
51 seconds by default. Datacenter uses 15 seconds and either advanced rung
uses 30 seconds, matching Scrapfly's minimums and the local HTTP timeouts.
An unknown host can run datacenter and one advanced rung in 45 seconds.
If a rung cannot fit or the next rung would switch between Unblocker and
render, the tool returns a `start_rung` hint for a fresh call. It preserves
usable content and its warning, or returns `stronger_rung_required` when
there is no usable content.
Key and account credit rejections stop immediately.
[Scrapfly timeout documentation](https://scrapfly.io/docs/scrape-api/understand-timeout)

The browser can cost extra. To opt in to browser-backed scraping, set
`"scrapeProviders": ["scrapfly", "scrapfly-browser"]` in settings.

Tool logs include timestamp, name, provider, duration, outcome, error code
and attempt count. Batch items log their own outcomes with `itemIndex`.
The aggregate batch record describes whether the call returned a result.
Separate `provider_attempt` records include each Scrapfly rung or Serper
request. Count Serper `hedge` rows against `primary` rows to measure backup
frequency. The `hedgeTrigger` field distinguishes delay from failure.
For a local estimate of blocking on no-Unblocker attempts, count
`datacenterBlocked: true` among datacenter records. This is the server's
page classification. Use the rate to monitor proximity to your account's
free-request threshold.
Credits are raw reported units or `null` when unavailable. Scrapfly attempt
rows also include `requestedProxyPool`, `proxyPool`, `costBreakdown`, and
`remainingCredits`. The LaunchAgent
writes `tools.jsonl` and rotates at 2 MiB by default, retaining one previous file. Arguments and fetched content are
excluded. Startup and diagnostic messages go to separate stdout and stderr
files.

## Security and sessions

- The server binds only to IPv4 loopback, checks the exact Host, rejects every
  Origin, and requires the bearer token on every request. Other processes that
  can read your private settings or client environment can obtain the token.
  [MCP transport security guidance](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- By default the server supports 128 MCP sessions and expires them after two
  hours idle.
  Expired session IDs return HTTP 404. Reconnect the MCP server in the client or
  reopen the conversation if automatic reconnection fails. Browser state has
  its own 30-minute cap.
- Only fixed provider endpoints receive local requests. Initial scrape
  destinations must be public HTTP(S) on standard ports. Scrapfly follows
  scrape redirects, and the server checks the reported hops and final URL
  before releasing content.
- The browser validates top-level HTTP(S) navigations, including intercepted
  redirects. Public WebSocket hosts are allowed. Ordinary subresources and
  iframe requests rely on Scrapfly's cloud egress. Local DNS checks cannot pin
  the address resolved remotely. Downloads are canceled where possible.
  [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- Search queries go to Serper. Scrapfly or the target site receives URLs and
  browser input as applicable. Fetched text and screenshots are untrusted.
  The browser exposes no raw JavaScript, local file or CDP tool.

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

The standing live-test budget per work session is about 5,000 Scrapfly credits
and 1,000 Serper searches. Ask before exceeding either budget. Runtime
per-request cost limits still apply.

The offline suite uses fixtures and loopback only. The ordinary live smoke test
makes one search (plus a hedge if needed), one scrape and one short browser
session. The challenge smoke test separately uses one browser session against
a real Cloudflare WAF challenge and fails if the gated page cannot be read.
The other focused modes check the Turnstile form, explicit rendering and
render hints, a three-item batch, or closure after the default idle period.
The optional Unblocker smoke test checks that a protected URL escalates from
datacenter to Unblocker and returns readable content. It repeats the request
to verify that site memory starts at Unblocker.
