# Search Scrape MCP

One Node process serves all clients over Streamable HTTP at
`http://127.0.0.1:8765/mcp`. Each MCP session has its own lazily opened
Scrapfly Cloud Browser, with a fresh remote context and a single controlled tab.

## Setup on macOS

Use Node 22 or newer. Get API keys from [Serper](https://serper.dev/) and
[Scrapfly](https://scrapfly.io/). The installer can read the existing
`~/.config/search-scrape-mcp/env` file or prompt for the keys with input hidden.
The env file uses Node's dotenv syntax and should be private.

```dotenv
SERPER_API_KEY=your-serper-key
SCRAPFLY_API_KEY=your-scrapfly-key
```

From a logged-in macOS session:

```sh
cd ~/projects2/search-scrape-mcp
./scripts/install.sh
```

The installer runs `npm ci` and builds the project. On first install it creates
`~/.config/search-scrape-mcp/config.json` with mode 600, copies in the provider
keys and generates a random local bearer token. launchd loads
`local.search-scrape-mcp` in your GUI session. Re-run the installer after a
code update. It preserves existing configuration.

```sh
launchctl print "gui/$(id -u)/local.search-scrape-mcp"
tail -n 30 ~/Library/Logs/search-scrape-mcp/stderr.log
launchctl kickstart -k "gui/$(id -u)/local.search-scrape-mcp"
```

To remove the LaunchAgent, run:

```sh
launchctl bootout "gui/$(id -u)/local.search-scrape-mcp"
rm ~/Library/LaunchAgents/local.search-scrape-mcp.plist
```

## Register clients

For Claude Code and the Codex CLI, load only the local bearer token in the shell
that starts the client. Re-run the `export` in new shells. The provider keys
stay in the server config.

```sh
export SEARCH_SCRAPE_TOKEN="$(node -p 'require(process.argv[1]).token' "$HOME/.config/search-scrape-mcp/config.json")"

claude mcp add --scope user --transport http search-scrape http://127.0.0.1:8765/mcp \
  --header 'Authorization: Bearer ${SEARCH_SCRAPE_TOKEN}'

codex mcp add search-scrape --url http://127.0.0.1:8765/mcp \
  --bearer-token-env-var SEARCH_SCRAPE_TOKEN
```

Restart any open client session. For slow scrape batches in Codex, set
`tool_timeout_sec = 240` in the `[mcp_servers.search-scrape]` section of
`~/.codex/config.toml`. For a GUI-launched Codex instance without the shell
environment, replace the `bearer_token_env_var` line in that section with
`http_headers = { Authorization = "Bearer YOUR_LOCAL_TOKEN" }` in your private
user config. Keep that file private. [Claude Code MCP docs](https://code.claude.com/docs/en/mcp) · [Official OpenAI documentation for Codex MCP](https://developers.openai.com/codex/mcp)

Claude Desktop's local configuration uses stdio. Add this entry under
`mcpServers` in `~/Library/Application Support/Claude/claude_desktop_config.json`,
then fully quit and reopen Claude Desktop. Use the absolute Node path from
`command -v node`. The relay is a small Node process for each Desktop
connection. Provider work and browser state stay in the shared HTTP server.
[Claude Desktop MCP docs](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers)

```json
{
  "mcpServers": {
    "search-scrape": {
      "command": "/opt/homebrew/bin/node",
      "args": [
        "/Users/YOU/projects2/search-scrape-mcp/dist/server/desktop-relay.js"
      ],
      "env": {
        "MCP_CONFIG": "/Users/YOU/.config/search-scrape-mcp/config.json"
      }
    }
  }
}
```

## Tools

| Tool           | Use                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`       | Find public sources by `query` or `q`. Returns organic links and snippets, up to 10.                                                                                                                    |
| `search_batch` | Pass `{"searches":[{"q":"example"}]}` for up to three searches, up to five hits each.                                                                                                                   |
| `scrape`       | Pass `{"url":"https://example.com/"}` for cleaned markdown, capped at 12,000 characters.                                                                                                                |
| `scrape_batch` | Pass `{"urls":["https://example.com/"]}` for up to three pages, capped at 4,000 characters each.                                                                                                        |
| `browser`      | Pass `{"command":{"action":"navigate","url":"https://example.com/"}}` to open. Then use `snapshot`, `click`, `fill`, `press`, or `close`. Actions take a CSS or Playwright `selector` where applicable. |

Batches preserve input order and report errors per item. Browser snapshots
show accessible roles and names for choosing selectors. Truncated page output
has a marker. For omitted text, use the site's source or API. When a page
remains blocked, try its official API or CLI, or ask the user to open it in
their local browser.

## Configuration and cost

`MCP_CONFIG` points to one private JSON config file. In file mode the file
takes precedence. Environment mode uses the variables below instead.
For a foreground run with the installed config:

```sh
MCP_CONFIG="$HOME/.config/search-scrape-mcp/config.json" npm start
```

| JSON               | Environment         | Default                                               |
| ------------------ | ------------------- | ----------------------------------------------------- |
| `port`             | `MCP_PORT`          | `8765`                                                |
| `token`            | `MCP_TOKEN`         | Required. Use at least 32 random URL-safe characters. |
| `serperKey`        | `SERPER_API_KEY`    | Required                                              |
| `scrapflyKey`      | `SCRAPFLY_API_KEY`  | Required for scrape and browser tools                 |
| `searchProviders`  | `SEARCH_PROVIDERS`  | `["serper"]`                                          |
| `scrapeProviders`  | `SCRAPE_PROVIDERS`  | `["scrapfly"]`                                        |
| `browserProviders` | `BROWSER_PROVIDERS` | `["scrapfly"]`                                        |

Provider lists are ordered arrays in JSON and comma-separated in the
environment. To opt in to a paid browser fallback, set `"scrapeProviders":
["scrapfly", "scrapfly-browser"]`. Browser-backed scraping opens and closes
a separate session per page. Unsafe URLs, DNS verification errors and known
credential or quota errors stop fallback. Browser actions are serialized per
session and are never replayed on another browser. A remote session is capped
at five minutes and also closes on MCP session deletion or explicit `close`.

The default scrape path uses Scrapfly's Unblocker (`asp=true`) and article
markdown conversion. Cloud Browser requests `solve_captcha=true`. Scrapfly
handles anti-bot checks and CAPTCHA solving, and unresolved challenges are
returned as errors when detected. Search sends one request per query. Browser
time, traffic, and CAPTCHA solves can incur extra charges. See the provider
docs for [Scrapfly scrape options](https://scrapfly.io/docs/scrape-api/getting-started)
and [Cloud Browser CAPTCHA solving](https://scrapfly.io/docs/cloud-browser-api/captcha-solver).

## Security trade-offs

- The HTTP server binds only to IPv4 loopback. It requires the exact
  `127.0.0.1:<port>` Host, rejects every Origin, and checks the bearer token
  on every request. The static token is intended for one local user. Processes
  that can read your private files or client environment can obtain it. The
  server uses neither CORS nor remote authentication. Keep it on loopback.
  [MCP transport security guidance](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- Session IDs isolate browser state. The shared token authorizes all clients,
  so session IDs are not separate user credentials. The server caps request
  bodies, active tool calls and session count. MCP sessions expire after 30
  minutes idle. Reconnect the client after expiry.
- Only HTTP(S) on standard ports is allowed. The server rejects credentials,
  nonpublic address ranges and local hostnames, and checks both A and AAAA
  answers. Only fixed provider hosts receive local connections. Scrapfly
  controls DNS and follows redirects for its scrape API. The server checks
  the reported redirects and final URL before returning content. These checks
  happen after the remote fetch.
- The browser guard checks intercepted requests, including redirect hops,
  before allowing them to continue. Browser WebSockets are
  blocked, downloads are canceled where possible, and the controlled page bypasses service workers. Local DNS checks
  cannot pin the IP used by the cloud provider or cover every browser
  networking channel. Provider egress isolation remains a trust boundary.
  [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- Search queries go to Serper. Target URLs and browser input go to Scrapfly or
  the target site as applicable. Fetched text is untrusted and may contain
  prompt injection or information submitted to a website. There is no raw
  JavaScript, file, cookie or CDP tool. Each tool logs its name,
  duration, outcome and provider attempt count. Logs omit request arguments,
  provider bodies and raw connection errors. Keep provider protocol debug
  logging disabled.

## Tests

```sh
npm ci
npm test
npm run lint
npm run format:check
```

Fixtures use no keys or upstream network. The HTTP integration test uses
loopback. A separate live smoke test reads the same env file and makes one
Serper search, one Scrapfly scrape and one short browser session against
`example.com`. It checks ordinary pages and session operations. It does
not deliberately trigger a billable CAPTCHA solve.

```sh
npm run smoke
```
