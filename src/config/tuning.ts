import { isAbsolute } from "node:path";
import { z } from "zod";
import { fileHost } from "./file-hosts.js";
import { SCRAPFLY_STANDARD_COST } from "./safety-limits.js";

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
    60,
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
    20,
    "Maximum accumulated Scrapfly scrape request tokens.",
  ),
  youtubeJobGapMs: integer(
    1,
    60_000,
    5_000,
    "Rest after a yt-dlp job exits. At most one job runs at a time.",
  ),
  youtubeLimitWaitMs: integer(
    0,
    550_000,
    240_000,
    "Maximum wait for a yt-dlp job permit, within the tool deadline.",
  ),
  youtubeRequestGapMs: integer(
    0,
    60_000,
    3_000,
    "Delay between yt-dlp extraction requests and before the caption fetch.",
  ),
  youtubeCooldownMs: integer(
    1_000,
    3_600_000,
    120_000,
    "Server-wide yt-dlp cooldown after an HTTP 429.",
  ),
  providerConcurrency: integer(
    1,
    32,
    5,
    "Maximum in-flight HTTP attempts per provider across all sessions.",
  ),
  providerGapMs: integer(
    1,
    60_000,
    500,
    "Minimum time between HTTP attempt starts for each provider.",
  ),
  localLimitWaitMs: integer(
    0,
    550_000,
    210_000,
    "Maximum wait for a provider or hostname permit, within the call deadline.",
  ),
  siteConcurrency: integer(
    1,
    32,
    5,
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
    5,
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
    "Successful tool result cache lifetime in milliseconds. Zero disables caching.",
  ),
  cacheMaxEntries: integer(
    1,
    10_000,
    128,
    "Maximum entries in each result cache.",
  ),
  cacheMaxBytes: integer(
    1,
    100_000_000,
    16_000_000,
    "Maximum serialized bytes in each result cache.",
  ),

  toolDeadlineSeconds: integer(
    35,
    600,
    270,
    "Overall tool deadline in seconds (35–600). Calls through the stdio relay use relayDeadlineSeconds instead.",
  ),
  relayDeadlineSeconds: integer(
    20,
    600,
    55,
    "Deadline in seconds for calls that arrive through the stdio relay. Apps that launch it, such as the Claude desktop app, stop waiting after 60 seconds and then drop every call in flight, so the relay must answer first.",
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
  scrapflyExpensiveCost: integer(
    SCRAPFLY_STANDARD_COST + 1,
    10_000,
    200,
    "Scrapfly requested cost budget in credits with allow_higher_cost enabled.",
  ),
  scrapflyDailyCredits: integer(
    0,
    10_000_000,
    0,
    "Stop new Scrapfly scrapes once this many credits are recorded for the day (UTC). Zero means no cap.",
  ),
  scrapflyDatacenterPool: pool
    .default("public_datacenter_pool")
    .describe("Proxy pool sent on the datacenter rung."),
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
  mcpConcurrentToolCalls: integer(
    1,
    4_096,
    256,
    "Maximum simultaneous tool calls across all clients. Further calls wait for a free slot.",
  ),
  mcpBusyWaitMs: integer(
    0,
    550_000,
    60_000,
    "Wait up to this many milliseconds for a free tool-call slot before rejecting a call.",
  ),
  mcpMaxConnections: integer(
    1,
    65_536,
    1_024,
    "Maximum simultaneous HTTP connections to the MCP server. Each call in flight uses one.",
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
  providerDownMemoryMs: integer(
    0,
    3_600_000,
    300_000,
    "After a scrape fails with provider_down, fail the same URL fast for this many milliseconds unless fresh is set. Zero disables it.",
  ),
  failureMemoryMs: integer(
    0,
    3_600_000,
    600_000,
    "After a scrape finds a missing page or a sign-in wall, repeat that answer for the same URL for this many milliseconds unless fresh is set. Zero disables it.",
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
    10_485_760,
    "Rotate the JSONL stats file at this size in bytes.",
  ),
  statsLogFiles: integer(
    1,
    100,
    5,
    "Rotated JSONL stats files to keep, including the current one.",
  ),
});

export type Tuning = z.infer<typeof tuningSchema>;
export const defaults = tuningSchema.parse({});
