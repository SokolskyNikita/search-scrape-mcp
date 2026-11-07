#!/bin/bash
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
repo="$PWD"
node_bin="$(command -v node)"
config="${MCP_CONFIG:-$HOME/.config/search-scrape-mcp/config.json}"
key_file="${MCP_KEYS_FILE:-$HOME/.config/search-scrape-mcp/env}"
if [[ "$config" != /* || "$key_file" != /* ]]; then
  printf 'MCP_CONFIG and MCP_KEYS_FILE must be absolute file paths.\n' >&2
  exit 1
fi

label=local.search-scrape-mcp
domain="gui/$(id -u)"
agent_dir="$HOME/Library/LaunchAgents"
logs="$HOME/Library/Logs/search-scrape-mcp"
plist="$agent_dir/$label.plist"

"$node_bin" --input-type=module - <<'JS'
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('Node 22 or newer is required.');
  process.exitCode = 1;
}
JS
npm ci
npm run build
MCP_CONFIG="$config" MCP_KEYS_FILE="$key_file" ./scripts/configure.sh

mkdir -p "$agent_dir" "$logs"
temp_plist="$(mktemp "$agent_dir/.$label.XXXXXX")"
trap 'rm -f "$temp_plist"' EXIT
"$node_bin" --input-type=module - "$label" "$node_bin" "$repo" "$config" "$logs" "$key_file" > "$temp_plist" <<'JS'
const [label, node, repo, config, logs, keys] = process.argv.slice(2);
const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
console.log(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(node)}</string><string>${xml(repo)}/dist/server/main.js</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(repo)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>MCP_CONFIG</key><string>${xml(config)}</string>
    <key>MCP_KEYS_FILE</key><string>${xml(keys)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logs)}/stdout.log</string>
  <key>StandardErrorPath</key><string>${xml(logs)}/stderr.log</string>
</dict></plist>`);
JS
plutil -lint "$temp_plist"
if launchctl print "$domain/$label" >/dev/null 2>&1; then
  launchctl bootout "$domain/$label"
fi
mv -f "$temp_plist" "$plist"
launchctl bootstrap "$domain" "$plist"
printf 'Loaded %s. Logs: %s\n' "$label" "$logs"
