import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

const local = new URL("./.local/", import.meta.url);
const gt = new URL("wcxb/test/ground-truth/", local);
const output = new URL("live/", local);
const budget = 1000;
const limit = 5;
const key =
  process.env.SCRAPFLY_API_KEY ??
  parseEnv(
    await readFile(
      process.env.MCP_KEYS_FILE ??
        join(homedir(), ".config/search-scrape-mcp/env"),
      "utf8",
    ),
  ).SCRAPFLY_API_KEY;
if (!key) throw new Error("Missing Scrapfly key");
await mkdir(output, { recursive: true, mode: 0o700 });

const groups = new Map();
for (const name of (await readdir(gt)).sort()) {
  if (!name.endsWith(".json")) continue;
  const record = JSON.parse(await readFile(new URL(name, gt)));
  const id = name.slice(0, -5);
  const type = record._internal.page_type.primary;
  const rank = createHash("sha256")
    .update("wcxb-live-v1:" + id)
    .digest("hex");
  if (!groups.has(type)) groups.set(type, []);
  groups.get(type).push({ id, type, url: record.url, rank });
}
for (const rows of groups.values())
  rows.sort((a, b) => a.rank.localeCompare(b.rank));
const sample = Array.from({ length: 18 }, (_, i) =>
  [...groups.values()].flatMap((rows) => (rows[i] ? [rows[i]] : [])),
).flat();
await writeFile(new URL("sample.json", local), JSON.stringify(sample, null, 2));

const formats = {
  raw: "raw",
  only: "markdown:no_images,only_content",
  whole: "markdown:no_images",
};
const canonical = (url) => {
  const u = new URL(url);
  return (
    u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "") + u.search
  );
};
const ledger = new Map();
let priorSpent = 0;
for (const directory of (await readdir(local)).filter((name) =>
  name.startsWith("live-rejected"),
)) {
  const previous = new URL(directory + "/", local);
  for (const name of await readdir(previous)) {
    if (!name.endsWith(".json")) continue;
    const row = JSON.parse(await readFile(new URL(name, previous)));
    if (row.http === 429) priorSpent += row.credits ?? limit;
  }
}
for (const name of await readdir(output)) {
  if (!name.endsWith(".json")) continue;
  const entry = JSON.parse(await readFile(new URL(name, output)));
  ledger.set(name.slice(0, -5), entry);
}

let spent =
  priorSpent +
  [...ledger.values()].reduce((sum, row) => sum + (row.credits ?? limit), 0);
async function scrape(page, mode) {
  const label = page.id + "-" + mode;
  if (ledger.has(label)) return ledger.get(label);
  if (spent + limit >= budget) return { outcome: "budget-stop" };
  const file = new URL(label + ".json", output);
  const row = { id: page.id, mode };
  // Reserve the attempt on disk before submission so interruption cannot cause a retry.
  await writeFile(file, JSON.stringify({ ...row, outcome: "interrupted" }), {
    flag: "wx",
  });
  const start = performance.now();
  try {
    const endpoint = new URL("https://api.scrapfly.io/scrape");
    endpoint.search = new URLSearchParams({
      key,
      url: page.url,
      format: formats[mode],
      proxy_pool: "public_datacenter_pool",
      country: "us",
      cost_budget: String(limit),
      timeout: "18000",
      retry: "false",
    });
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(26000),
      redirect: "error",
    });
    row.http = response.status;
    if (row.http === 429) row.retryAfter = response.headers.get("retry-after");
    if (row.http === 429)
      row.rateLimitHeaders = [...response.headers].filter(([name]) =>
        /rate.?limit/i.test(name),
      );
    const costHeader = response.headers.get("x-scrapfly-api-cost");
    if (costHeader !== null && /^\d+$/.test(costHeader))
      row.credits = Number(costHeader);
    const body = await response.json();
    const result = body.result;
    const cost = body.context?.cost?.total ?? body.context?.cost;
    if (Number.isFinite(cost) && cost >= 0) row.credits = cost;
    row.status = result?.status_code;
    row.code =
      response.headers.get("x-scrapfly-reject-code") ??
      result?.error?.code ??
      body.code;
    row.finalUrl = result?.url;
    let content = result?.content;
    if (row.credits > limit || row.code?.includes("COST_BUDGET_LIMIT"))
      row.outcome = "over-cost";
    else if (row.status === 404 || row.status === 410) row.outcome = "gone";
    else if (row.finalUrl && canonical(row.finalUrl) !== canonical(page.url))
      row.outcome = "redirect";
    else if (!response.ok || row.status >= 400 || result?.success === false)
      row.outcome = "provider";
    else {
      if (result?.format === "clob") {
        const clob = new URL(content);
        if (clob.origin !== endpoint.origin || clob.username || clob.password)
          throw new Error("Invalid clob URL");
        clob.searchParams.set("key", key);
        const download = await fetch(clob, {
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        });
        if (!download.ok) throw new Error("Clob download failed");
        content = await download.text();
      }
      row.outcome =
        typeof content === "string" && content.trim() ? "ok" : "empty";
    }
    row.ms = performance.now() - start;
    if (row.outcome === "ok")
      await writeFile(new URL(label + ".txt", output), content);
  } catch (error) {
    row.ms = performance.now() - start;
    row.outcome = error.name === "TimeoutError" ? "timeout" : "transport";
  }
  spent += row.credits ?? limit;
  ledger.set(label, row);
  await writeFile(file, JSON.stringify(row));
  return row;
}

let cursor = 0;
for (const page of sample) {
  if (spent + 3 * limit >= budget) break;
  cursor++;
  const raw = await scrape(page, "raw");
  const results = [raw];
  if (raw.outcome === "ok") {
    const only = await scrape(page, "only");
    results.push(only);
    if (only.outcome !== "over-cost" && only.http !== 429)
      results.push(await scrape(page, "whole"));
  }
  const throttled = results.find((row) => row.http === 429);
  if (throttled) {
    console.log(
      "Stopped after HTTP 429:",
      page.id,
      throttled.mode,
      "Retry-After:",
      throttled.retryAfter ?? "missing",
    );
    break;
  }
  console.log(
    page.id,
    page.type,
    ...results.map((row) => row.outcome),
    "accounted",
    spent,
  );
}
console.log(
  "Finished",
  cursor,
  "of",
  sample.length,
  "accounted credits",
  spent,
);
