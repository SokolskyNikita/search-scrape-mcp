#!/bin/bash
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
node --input-type=module - <<'JS'
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadProviderKeys, parseSettings, readSettings, settingsFile } from './dist/config/index.js';
import { safeError } from './dist/server/error.js';

try {
  loadProviderKeys();
  const file = settingsFile();
  const directory = dirname(file);
  const render = (settings) => JSON.stringify(settings, null, 2) + '\n';
  if (!existsSync(file)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const settings = parseSettings({ token: randomBytes(32).toString('base64url') });
    writeFileSync(file, render(settings), { flag: 'wx', mode: 0o600 });
    console.log('Wrote private MCP settings.');
  } else {
    const { settings, legacyKeys } = readSettings(file);
    if (legacyKeys) {
      const temp = mkdtempSync(join(directory, '.migrate-'));
      try {
        const replacement = join(temp, 'config.json');
        writeFileSync(replacement, render(settings), { flag: 'wx', mode: 0o600 });
        renameSync(replacement, file);
      } finally {
        rmSync(temp, { recursive: true });
      }
      console.log('Moved to settings-only config. Provider keys are read from the env file.');
    }
  }
} catch (error) {
  console.error(safeError(error).message);
  process.exitCode = 1;
}
JS
