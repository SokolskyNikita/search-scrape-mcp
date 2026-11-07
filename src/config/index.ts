import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
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
      .default(["scrapfly"]),
    browserProviders: z
      .array(z.literal("scrapfly"))
      .min(1)
      .max(1)
      .default(["scrapfly"]),
  })
  .strict();

export type Config = z.infer<typeof schema>;

function readPrivateConfig(file: string): unknown {
  const fd = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 16_384 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    ) {
      throw new AppError(
        "config",
        "MCP_CONFIG must be a private file owned by this user (chmod 600).",
      );
    }
    return JSON.parse(readFileSync(fd, "utf8")) as unknown;
  } finally {
    closeSync(fd);
  }
}

export function loadConfig(env = process.env): Config {
  let input: unknown;
  try {
    input = env.MCP_CONFIG
      ? readPrivateConfig(env.MCP_CONFIG)
      : {
          port: env.MCP_PORT,
          token: env.MCP_TOKEN,
          serperKey: env.SERPER_API_KEY,
          scrapflyKey: env.SCRAPFLY_API_KEY,
          searchProviders: env.SEARCH_PROVIDERS?.split(","),
          scrapeProviders: env.SCRAPE_PROVIDERS?.split(","),
          browserProviders: env.BROWSER_PROVIDERS?.split(","),
        };
  } catch (error) {
    if (error instanceof AppError) throw error;
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
