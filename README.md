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

| Tool           | Use                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`       | Find public sources by `query` or `q`. Returns organic links and snippets, up to 10.                                                                                                   |
| `search_batch` | Pass `{"searches":[{"q":"example"}]}` for up to three searches, up to five hits each.                                                                                                  |
| `scrape`       | Pass `{"url":"https://example.com/"}` for cleaned markdown, inline up to 48,000 characters.                                                                                            |
| `scrape_batch` | Pass `{"urls":["https://example.com/"]}` for up to three pages, inline up to 20,000 characters per page.                                                                               |
| `browser`      | Pass `{"command":{"action":"navigate","url":"https://example.com/"}}` to open. Use `snapshot`, `click`, `fill`, `press`, `scroll`, `back`, `wait`, `screenshot` or `close` thereafter. |

Short scrapes return a `markdown` field. Long scrapes and browser text or
snapshots (over 12,000 characters for browser output) save the full cleaned
Markdown to a randomly named file in `/tmp/search-scrape-mcp/`. The result
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

For browser actions, use a ref from the latest snapshot, for example
`{"command":{"action":"click","ref":"s2-e7"}}`. CSS and Playwright
selectors still work via `selector`. Scroll takes signed `pixels`.
Wait takes `ms` (up to 10,000) and optionally a selector to wait for.
Screenshot returns a viewport JPEG as MCP image content. Navigation and back
wait for CAPTCHA clearance only when the page looks like a challenge. The wait
defaults to 40 seconds within the overall tool deadline. Scrapfly's
`solve_captcha` can still solve and bill for widgets on ordinary forms.
Use `close` when done to stop session charges. By default, the server closes
an idle browser after 2 minutes 30 seconds and Scrapfly caps a session at
30 minutes. After browser expiry, navigate again to open a fresh browser.

## Settings, cost and logs

The default settings file is `~/.config/search-scrape-mcp/config.json`.
Use `MCP_CONFIG` and `MCP_KEYS_FILE` for absolute path overrides. The settings
file requires the private bearer `token`. Omitted settings use the defaults
below. Omitting `SCRAPFLY_API_KEY` leaves search enabled.
Run `npm run config` to print the effective settings with the token omitted.
This command reads only the settings file. Run `npm run config:docs` after
changing the schema. The test command checks that the table matches.

<!-- settings:start -->

<!-- prettier-ignore -->
| Setting | Default | Description |
| --- | --- | --- |
| `port` | `8765` | Local MCP HTTP port. |
| `toolDeadlineSeconds` | `54` | Overall tool deadline in seconds. The relay allows three additional seconds. |
| `serperBackupDelayMs` | `4500` | Delay before hedging a slow Serper request. Transient failures can trigger an earlier backup. |
| `serperTimeoutMs` | `12000` | Shared Serper primary and backup budget in milliseconds, within the tool deadline. |
| `searchGl` | `"us"` | Default Serper country code. |
| `searchHl` | `"en"` | Default Serper language code. |
| `scrapflyDatacenterCost` | `5` | Datacenter request cost budget in credits. |
| `scrapflyUnblockerCost` | `20` | Unblocker request cost budget in credits. |
| `scrapflyRenderCost` | `40` | Rendering request cost budget in credits. |
| `scrapflyDatacenterPool` | `"public_datacenter_pool"` | Proxy pool sent on the datacenter rung. |
| `scrapflyUnblockerPool` | `"public_datacenter_pool"` | Initial proxy pool sent on the Unblocker rung. |
| `scrapflyRenderPool` | `"public_datacenter_pool"` | Initial proxy pool sent on the rendering rung. |
| `scrapflyRenderingWaitMs` | `1000` | Scrapfly rendering wait in milliseconds. |
| `captchaWaitMs` | `40000` | Maximum CAPTCHA challenge wait in milliseconds, within the tool deadline. |
| `browserSessionSeconds` | `1800` | Maximum remote browser session length in seconds. |
| `browserIdleMs` | `150000` | Close a browser after this many idle milliseconds. |
| `mcpSessionExpiryMs` | `7200000` | Expire idle MCP sessions after this many milliseconds. |
| `mcpSessionLimit` | `128` | Maximum number of MCP sessions. |
| `scrapeInlineChars` | `48000` | Inline character limit for a single scrape. |
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

Search defaults to US English. Both search tools accept a country code (`gl`),
language code (`hl`), geographic `location`, result `page` (1 through 10),
and a boolean `autocorrect`. Use either `recency` (`day`, `week`, `month`, or
`year`) or a Google time filter such as `tbs: "qdr:h"`. You can also specify
`site` and up to five `exclude_domains`. Hits include dates when Serper supplies
them. A query starts at most one hedge after a transient
failure or 4.5 seconds without an answer by default. Both requests may count
against quota.

Scrapfly starts with datacenter and escalates to the Unblocker when a page is
blocked or challenged. Empty pages and JavaScript shells can jump straight
to the render rung, which adds a one-second render wait by default. The default
request cost budgets are 5, 20, and 40 credits for datacenter, Unblocker, and
render. A request-budget rejection advances to the next rung if available.
This account's gateway rejected the newer `auto` and `unblocker` pool names
during testing. All three pools default to `public_datacenter_pool`, with
`unblocker=true` on the two stronger rungs. [Scrapfly proxy pool migration guide](https://scrapfly.io/new-pricing#legacy-spellings)

Results include a page check and the rungs tried. A warning preserves usable
content such as a paywall teaser or persistent menus. A failure gives a reason
and, when useful, a hint for an untried stronger rung. Set `start_rung` to
`datacenter`, `unblocker`, or `render` on a scrape or batch. The server
remembers what worked per hostname for four hours, up to 256 hostnames.
A failed remembered rung is cleared. Sites seen blocking datacenter can
skip it on later calls. Provider outages get at most one retry per scrape,
when the remaining tool time covers the backoff and a full attempt. The
scrape ladder reserves three seconds for completion or fallback, then splits
the rest into 22%, 32%, and 46% for datacenter, Unblocker, and render. The same
clipped per-request timeout goes to Scrapfly and the local HTTP request.
Key and account credit rejections stop immediately.

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
Credits are raw reported units or `null` when unavailable. The LaunchAgent
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
```

The offline suite uses fixtures and loopback only. The ordinary live smoke test
makes one search (plus a hedge if needed), one scrape and one short browser
session. The challenge smoke test separately uses one browser session against
a real Cloudflare WAF challenge and fails if the gated page cannot be read.
