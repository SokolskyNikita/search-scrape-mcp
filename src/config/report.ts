import { FileHosts } from "./file-hosts.js";
import { todayUsage } from "../server/usage.js";
import {
  relayTimeoutMs,
  scrapeBudgetMs,
  scrapeReserveMs,
  scrapflyTimeoutMs,
  toolTimeoutMs,
} from "./deadline.js";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { AppError } from "../server/error.js";
import { loadSettings, settingsFile, settingsSchema } from "./index.js";

const publicSchema = settingsSchema.omit({ token: true }).strip();

try {
  if (
    process.argv[2] === "--write-docs" ||
    process.argv[2] === "--check-docs"
  ) {
    const rows = Object.entries(publicSchema.shape).map(
      ([name, schema]) =>
        `| \`${name}\` | \`${JSON.stringify(schema.parse(undefined))}\` | ${schema.description} |`,
    );
    const file = new URL("../../USAGE.md", import.meta.url);
    const usage = readFileSync(file, "utf8");
    const section = /<!-- settings:start -->[\s\S]*?<!-- settings:end -->/;
    if (!section.test(usage))
      throw new AppError("config", "usage guide settings markers are missing.");
    const updated = usage.replace(
      section,
      [
        "<!-- settings:start -->",
        "",
        "<!-- prettier-ignore -->",
        "| Setting | Default | Description |",
        "| --- | --- | --- |",
        ...rows,
        "",
        "<!-- settings:end -->",
      ].join("\n"),
    );
    if (process.argv[2] === "--write-docs") writeFileSync(file, updated);
    else if (usage !== updated)
      throw new AppError(
        "config",
        "Run npm run config:docs to refresh the usage guide settings.",
      );
  } else {
    const missing = !lstatSync(settingsFile(), { throwIfNoEntry: false });
    if (missing) console.error("config.json is missing. Showing defaults.");
    const settings = publicSchema.parse(missing ? {} : loadSettings());
    const { hosts, costs } = new FileHosts(settings.scrapflyFileHosts).read();
    console.log(
      JSON.stringify(
        {
          ...settings,
          scrapflyEffectiveFileHosts: [...hosts].sort(),
          scrapflyHigherCostHosts: Object.fromEntries(costs),
          today: {
            ...todayUsage(),
            browserDailyMinutes: settings.browserDailyMinutes,
          },
          derived: {
            toolTimeoutMs: toolTimeoutMs(settings),
            relayTimeoutMs: relayTimeoutMs(settings),
            scrapeReserveMs,
            scrapeBudgetMs: scrapeBudgetMs(settings),
            scrapflyRungs: Object.fromEntries(
              Object.entries(scrapflyTimeoutMs).map(([rung, ms]) => [
                rung,
                { requestTimeoutMs: ms, scrapflyTimeoutMs: ms },
              ]),
            ),
          },
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(
    error instanceof AppError
      ? error.message
      : "Could not report configuration.",
  );
  process.exitCode = 1;
}
