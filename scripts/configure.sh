#!/bin/bash
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
config="${MCP_CONFIG:-$HOME/.config/search-scrape-mcp/config.json}"
if [[ -e "$config" || -L "$config" ]]; then
  printf 'Config already exists at %s\n' "$config" >&2
  exit 1
fi
mkdir -p "$(dirname "$config")"

key_file="${MCP_KEYS_FILE:-$HOME/.config/search-scrape-mcp/env}"
set --
if [[ -f "$key_file" ]]; then
  set -- "--env-file=$key_file"
else
  if [[ -z "${SERPER_API_KEY:-}" ]]; then
    read -r -s -p 'Serper API key: ' SERPER_API_KEY
    printf '\n'
  fi
  if [[ -z "${SCRAPFLY_API_KEY:-}" ]]; then
    read -r -s -p 'Scrapfly API key: ' SCRAPFLY_API_KEY
    printf '\n'
  fi
  export SERPER_API_KEY SCRAPFLY_API_KEY
fi
node "$@" --input-type=module - "$config" <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadConfig } from './dist/config/index.js';
import { AppError, safeError } from './dist/server/error.js';

try {
  const config = loadConfig({
    ...process.env,
    MCP_CONFIG: undefined,
    MCP_TOKEN: randomBytes(32).toString('base64url'),
  });
  if (!config.scrapflyKey) throw new AppError('config', 'SCRAPFLY_API_KEY is required.');
  writeFileSync(process.argv[2], JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Wrote a private config file.');
} catch (error) {
  console.error(safeError(error).message);
  process.exitCode = 1;
}
JS
