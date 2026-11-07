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
| `scrape`       | Pass `{"url":"https://example.com/"}` for cleaned markdown, up to 48,000 characters per chunk.                                                                                         |
| `scrape_batch` | Pass `{"urls":["https://example.com/"]}` for up to three pages, up to 20,000 characters per initial chunk.                                                                             |
| `scrape_more`  | Pass the `pageId` and `nextOffset` from the previous chunk as `{"pageId":"…","offset":48000}` to read more.                                                                            |
| `browser`      | Pass `{"command":{"action":"navigate","url":"https://example.com/"}}` to open. Use `snapshot`, `click`, `fill`, `press`, `scroll`, `back`, `wait`, `screenshot` or `close` thereafter. |

Scrapes return `markdown`, `pageId`, `offset`, `nextOffset` and `totalChars`.
A null `nextOffset` marks the end. The shared memory cache stores full cleaned
pages for up to 10 minutes, subject to eviction at 128 pages or 16 million
UTF-16 code units. IDs are unguessable and usable by any authenticated client
that has the ID. A continuation spends no provider credits.

Batches run two items concurrently and preserve result order. Item failures
include their original indices. Calls have a 54-second overall deadline.
A deadline can interrupt a batch before all items have results.

For browser actions, use a ref from the latest snapshot, for example
`{"command":{"action":"click","ref":"s2-e7"}}`. CSS and Playwright
selectors still work via `selector`. Scroll takes signed `pixels`.
Wait takes `ms` (up to 10,000) and optionally a selector to wait for.
Screenshot returns a viewport JPEG as MCP image content. Navigation and back
wait for provider CAPTCHA events or a clearing challenge page, bounded by
40 seconds and the overall tool deadline. Browser lifetime is up to 30 minutes.
After browser expiry, send a new navigate command to open a fresh browser.

## Settings, cost and logs

The default settings file is `~/.config/search-scrape-mcp/config.json`.
Use `MCP_CONFIG` and `MCP_KEYS_FILE` for absolute path overrides. The settings
file accepts `port` (default 8765), `token`, and ordered arrays
`searchProviders` (default `["serper"]`), `scrapeProviders` (default
`["scrapfly"]`), and `browserProviders` (default `["scrapfly"]`).
Omitting `SCRAPFLY_API_KEY` leaves search enabled.

The Scrape API uses a datacenter proxy pool and a 30-credit cost budget.
The browser can cost extra. To opt in to browser-backed scraping, set
`"scrapeProviders": ["scrapfly", "scrapfly-browser"]` in settings.
Serper starts at most one hedge per query, after a transient failure or
900 ms without an answer. Both requests may count against your quota.

Each tool log line contains its timestamp, name, provider, duration, outcome,
error code and attempt count. The LaunchAgent writes `tools.jsonl` and rotates
at 2 MiB, retaining one previous file. Arguments and fetched content are
excluded. Launch startup and diagnostic messages go to separate stdout and
stderr files.

## Security and sessions

- The server binds only to IPv4 loopback, checks the exact Host, rejects every
  Origin, and requires the bearer token on every request. Other processes that
  can read your private settings or client environment can obtain the token.
  [MCP transport security guidance](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- The server supports 128 MCP sessions and expires them after two hours idle.
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
