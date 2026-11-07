import { readFileSync } from "node:fs";
import { z } from "zod";
import { AppError } from "../server/error.js";

const key = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[!-~]+$/);
const token = z.string().regex(/^[a-zA-Z0-9_-]{32,256}$/);
const schema = z
  .object({
    port: z.coerce.number().int().min(1024).max(65535).default(8765),
    token,
    serperKey: key,
    scrapflyKey: key.optional(),
    searchProviders: z
      .array(z.literal("serper"))
      .min(1)
      .max(1)
      .default(["serper"]),
    scrapeProviders: z
      .array(z.enum(["scrapfly", "scrapfly-browser"]))
      .min(1)
      .max(2)
      .refine((values) => new Set(values).size === values.length)
      .default(["scrapfly", "scrapfly-browser"]),
    browserProviders: z
      .array(z.literal("scrapfly"))
      .min(1)
      .max(1)
      .default(["scrapfly"]),
  })
  .strict();

export type Config = z.infer<typeof schema>;

export function loadConfig(env = process.env): Config {
  let input: unknown;
  try {
    input = env.MCP_CONFIG
      ? JSON.parse(readFileSync(env.MCP_CONFIG, "utf8"))
      : {
          port: env.MCP_PORT,
          token: env.MCP_TOKEN,
          serperKey: env.SERPER_API_KEY,
          scrapflyKey: env.SCRAPFLY_API_KEY,
          searchProviders: env.SEARCH_PROVIDERS?.split(","),
          scrapeProviders: env.SCRAPE_PROVIDERS?.split(","),
          browserProviders: env.BROWSER_PROVIDERS?.split(","),
        };
  } catch {
    throw new AppError("config", "Cannot read or parse MCP_CONFIG.");
  }
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = Object.keys(schema.shape);
    const invalid = new Set(
      result.error.issues.map(
        ({ path }) => fields.find((name) => name === path[0]) ?? "config",
      ),
    );
    throw new AppError(
      "config",
      `Invalid configuration fields: ${[...invalid].join(", ")}.`,
    );
  }
  return result.data;
}
