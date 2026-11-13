#!/bin/bash
# Install or upgrade from a git checkout (Homebrew users: `brew install search-scrape-mcp`, see USAGE.md).
# Builds the project, then runs `search-scrape-mcp setup`, which saves your keys, starts the background
# agent and connects Claude Code, Claude Desktop and Codex.
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
node --input-type=module - <<'JS'
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('Node 22 or newer is required.');
  process.exit(1);
}
JS
npm ci
npm run build
exec node dist/cli/main.js setup
