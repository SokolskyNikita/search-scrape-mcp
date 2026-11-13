// Kept for Claude Code registrations made before `search-scrape-mcp setup` existed, which call this file.
// Setup replaces them with `search-scrape-mcp headers`.
import { loadSettings } from "../dist/config/index.js";
import { safeError } from "../dist/server/error.js";

try {
  const { token } = loadSettings();
  process.stdout.write(JSON.stringify({ Authorization: `Bearer ${token}` }));
} catch (error) {
  console.error(safeError(error).message);
  process.exitCode = 1;
}
