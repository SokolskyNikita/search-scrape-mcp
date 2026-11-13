import { MAX_PRIVATE_CONFIG_BYTES } from "./safety-limits.js";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { AppError } from "../server/error.js";

import { tuningSchema } from "./tuning.js";

const key = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[!-~]+$/);
const token = z.string().regex(/^[a-zA-Z0-9_-]{32,256}$/);
export const settingsSchema = z
  .object({
    port: z.coerce
      .number()
      .int()
      .min(1024)
      .max(65535)
      .default(8765)
      .describe("Local MCP HTTP port."),
    token,
    ...tuningSchema.shape,

    searchProviders: z
      .array(z.literal("serper"))
      .min(1)
      .max(1)
      .default(["serper"])
      .describe("Search provider order."),
    scrapeProviders: z
      .array(z.enum(["scrapfly", "scrapfly-browser"]))
      .min(1)
      .max(2)
      .refine((values) => new Set(values).size === values.length)
      .default(["scrapfly"])
      .describe("Scrape provider order."),
    browserProviders: z
      .array(z.literal("scrapfly"))
      .min(1)
      .max(1)
      .default(["scrapfly"])
      .describe("Interactive browser provider order."),
  })
  .strict();

const keysSchema = z.object({
  SERPER_API_KEY: key,
  SCRAPFLY_API_KEY: key.optional(),
});
export type Config = z.infer<typeof settingsSchema> &
  ReturnType<typeof loadProviderKeys>;

const configDir = join(homedir(), ".config", "search-scrape-mcp");
export const settingsFile = () =>
  process.env.MCP_CONFIG ?? join(configDir, "config.json");
export const keysFile = () =>
  process.env.MCP_KEYS_FILE ?? join(configDir, "env");

function readPrivateFile(file: string, label: string): string {
  try {
    const fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.size > MAX_PRIVATE_CONFIG_BYTES ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.()
      )
        throw new AppError(
          "config",
          `${label} must be a private file owned by this user (chmod 600).`,
        );
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("config", `Cannot read ${label}.`);
  }
}

export function parseSettings(input: unknown) {
  const result = settingsSchema.safeParse(input);
  if (!result.success) {
    const invalid = new Set(
      result.error.issues.map(
        ({ path }) =>
          Object.keys(settingsSchema.shape).find((name) => name === path[0]) ??
          "config",
      ),
    );
    throw new AppError(
      "config",
      `Invalid configuration fields: ${[...invalid].join(", ")}.`,
    );
  }
  return result.data;
}

export function readSettings(file = settingsFile()) {
  const text = readPrivateFile(file, "MCP settings");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AppError("config", "Invalid MCP settings JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { settings: parseSettings(raw), legacyKeys: false };
  // Accept phase 1 settings during upgrade. Only the env file supplies provider keys.
  const { serperKey, scrapflyKey, ...settings } = raw as Record<
    string,
    unknown
  >;
  delete settings.scrapflyDatacenterCost;
  delete settings.scrapflyUnblockerCost;
  delete settings.scrapflyRenderCost;
  // The unblocker rung repeated the datacenter request and was removed.
  delete settings.scrapflyUnblockerPool;
  // MCP sessions were removed along with their limits.
  delete settings.mcpSessionExpiryMs;
  delete settings.mcpSessionLimit;
  delete settings.mcpSessionInFlightLimit;
  delete settings.mcpSessionBusyWaitMs;
  return {
    settings: parseSettings(settings),
    legacyKeys: serperKey !== undefined || scrapflyKey !== undefined,
  };
}

export function loadSettings() {
  return readSettings().settings;
}

export function loadProviderKeys(file = keysFile()) {
  const text = readPrivateFile(file, "provider env file");
  let env: ReturnType<typeof parseEnv>;
  try {
    env = parseEnv(text);
  } catch {
    throw new AppError("config", "Invalid provider env file.");
  }
  const parsed = keysSchema.safeParse(env);
  if (!parsed.success)
    throw new AppError(
      "config",
      "Invalid or missing SERPER_API_KEY or SCRAPFLY_API_KEY in provider env file.",
    );
  return {
    serperKey: parsed.data.SERPER_API_KEY,
    scrapflyKey: parsed.data.SCRAPFLY_API_KEY,
  };
}

export function loadConfig(): Config {
  return { ...loadSettings(), ...loadProviderKeys() };
}
