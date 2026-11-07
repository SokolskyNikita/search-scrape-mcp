import { isAbsolute } from "node:path";
import { z } from "zod";
import { fileHost } from "./file-hosts.js";

const integer = (
  min: number,
  max: number,
  value: number,
  description: string,
) => z.number().int().min(min).max(max).default(value).describe(description);
const pool = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);

export const tuningSchema = z.object({
  scrapflyFileHosts: z
    .array(fileHost)
    .default([])
    .describe("Seed hostnames that always get a Scrapfly HEAD check."),
  serperRequestsPerMinute: integer(
    1,
    6_000,
    60,
    "Server-wide Serper request rate, including hedges.",
  ),
  scrapflyRequestsPerMinute: integer(
    1,
    6_000,
    30,
    "Server-wide Scrapfly scrape request rate, including retries and escalation.",
  ),
  serperBurstCapacity: integer(
    1,
    1_000,
    20,
    "Maximum accumulated Serper request tokens.",
  ),
  scrapflyBurstCapacity: integer(
    1,
    1_000,
    10,
    "Maximum accumulated Scrapfly scrape request tokens.",
  ),
  localLimitWaitMs: integer(
    0,
    55_000,
    10_000,
    "Maximum wait for a provider or hostname permit, within the call deadline.",
  ),
  siteConcurrency: integer(
    1,
    32,
    4,
    "Maximum simultaneous requests per target hostname.",
  ),
  siteGapMs: integer(
    0,
    60_000,
    1_000,
    "Minimum time between request starts for the same target hostname.",
  ),
  browserConcurrency: integer(
    1,
    32,
    4,
    "Maximum simultaneous Cloud Browser sessions, including scrape fallback.",
  ),
  browserDailyMinutes: integer(
    1,
    10_000,
    120,
    "Daily Cloud Browser session-minutes across all sessions. Resets at midnight UTC.",
  ),
  cacheTtlMs: integer(
    0,
    3_600_000,
    600_000,
    "Successful search and scrape cache lifetime in milliseconds. Zero disables caching.",
  ),
  cacheMaxEntries: integer(
    1,
    10_000,
    128,
    "Maximum entries in each of the search and scrape caches.",
  ),
  cacheMaxBytes: integer(
    1,
    100_000_000,
    16_000_000,
    "Maximum serialized bytes in each of the search and scrape caches.",
  ),

  toolDeadlineSeconds: integer(
    35,
    55,
    54,
    "Overall tool deadline in seconds (35–55). The relay allows three additional seconds.",
  ),
  serperBackupDelayMs: integer(
    1_000,
    15_000,
    4_500,
    "Delay before hedging a slow Serper request. Transient failures can trigger an earlier backup.",
  ),
  serperTimeoutMs: integer(
    2_000,
    30_000,
    12_000,
    "Shared Serper primary and backup budget in milliseconds, within the tool deadline.",
  ),
  searchGl: z
    .string()
    .regex(/^[a-z]{2}$/)
    .default("us")
    .describe("Default Serper country code."),
  searchHl: z
    .string()
    .regex(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i)
    .max(35)
    .default("en")
    .describe("Default Serper language code."),
  scrapflyCountry: z
    .string()
    .regex(/^[a-z]{2}$/)
    .nullable()
    .default("us")
    .describe("Scrapfly proxy country. Set null to let Scrapfly choose."),
  scrapflyDatacenterCost: integer(
    1,
    10_000,
    5,
    "Datacenter request cost budget in credits.",
  ),
  scrapflyUnblockerCost: integer(
    1,
    10_000,
    85,
    "Unblocker request cost budget in credits.",
  ),
  scrapflyRenderCost: integer(
    1,
    10_000,
    40,
    "Rendering request cost budget in credits.",
  ),
  scrapflyDatacenterPool: pool
    .default("public_datacenter_pool")
    .describe("Proxy pool sent on the datacenter rung."),
  scrapflyUnblockerPool: pool
    .default("public_datacenter_pool")
    .describe("Initial proxy pool sent on the Unblocker rung."),
  scrapflyRenderPool: pool
    .default("public_datacenter_pool")
    .describe("Initial proxy pool sent on the rendering rung."),
  scrapflyRenderingWaitMs: integer(
    0,
    5_000,
    1_000,
    "Scrapfly rendering wait in milliseconds.",
  ),
  captchaWaitMs: integer(
    0,
    50_000,
    40_000,
    "Maximum CAPTCHA challenge wait in milliseconds, within the tool deadline.",
  ),
  browserSessionSeconds: integer(
    30,
    1_800,
    1_800,
    "Maximum remote browser session length in seconds.",
  ),
  browserIdleMs: integer(
    1_000,
    3_600_000,
    150_000,
    "Close a browser after this many idle milliseconds.",
  ),
  mcpSessionExpiryMs: integer(
    1_000,
    86_400_000,
    7_200_000,
    "Expire idle MCP sessions after this many milliseconds.",
  ),
  mcpSessionLimit: integer(1, 1_024, 128, "Maximum number of MCP sessions."),
  mcpSessionInFlightLimit: integer(
    1,
    1_024,
    8,
    "Maximum simultaneous MCP requests per session.",
  ),
  mcpConcurrentToolCalls: integer(
    1,
    1_024,
    16,
    "Maximum simultaneous tool calls across all MCP sessions.",
  ),
  scrapeInlineChars: integer(
    0,
    200_000,
    16_000,
    "Inline character limit for a single scrape.",
  ),
  scrapeBatchInlineChars: integer(
    0,
    200_000,
    20_000,
    "Inline character limit per batch scrape.",
  ),
  browserInlineChars: integer(
    0,
    200_000,
    12_000,
    "Inline character limit for browser text output.",
  ),
  outputPreviewChars: integer(
    0,
    5_000,
    600,
    "Preview character limit for saved outputs.",
  ),
  outputDirectory: z
    .string()
    .max(1_024)
    .refine((value) => isAbsolute(value) && !value.includes("\0"))
    .default("/tmp/search-scrape-mcp")
    .describe(
      "Absolute local spill directory. It must be private and owned by the server user.",
    ),
  outputMaxAgeMs: integer(
    1_000,
    604_800_000,
    14_400_000,
    "Saved output retention in milliseconds.",
  ),
  outputMaxBytes: integer(
    1,
    1_073_741_824,
    67_108_864,
    "Total saved output size cap in bytes.",
  ),
  siteMemoryMs: integer(
    0,
    604_800_000,
    14_400_000,
    "How long a hostname's successful rung or protection is remembered in milliseconds.",
  ),
  siteMemorySize: integer(
    0,
    65_536,
    256,
    "Maximum remembered hostnames. Zero disables memory.",
  ),
  statsLogMaxBytes: integer(
    1_024,
    1_073_741_824,
    2_097_152,
    "Rotate the JSONL stats file at this size in bytes.",
  ),
});

export type Tuning = z.infer<typeof tuningSchema>;
export const defaults = tuningSchema.parse({});
