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
    process.argv[2] === "--write-readme" ||
    process.argv[2] === "--check-readme"
  ) {
    const rows = Object.entries(publicSchema.shape).map(
      ([name, schema]) =>
        `| \`${name}\` | \`${JSON.stringify(schema.parse(undefined))}\` | ${schema.description} |`,
    );
    const file = new URL("../../README.md", import.meta.url);
    const readme = readFileSync(file, "utf8");
    const section = /<!-- settings:start -->[\s\S]*?<!-- settings:end -->/;
    if (!section.test(readme))
      throw new AppError("config", "README settings markers are missing.");
    const updated = readme.replace(
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
    if (process.argv[2] === "--write-readme") writeFileSync(file, updated);
    else if (readme !== updated)
      throw new AppError(
        "config",
        "Run npm run config:docs to refresh the README settings.",
      );
  } else {
    const missing = !lstatSync(settingsFile(), { throwIfNoEntry: false });
    if (missing) console.error("config.json is missing. Showing defaults.");
    const settings = publicSchema.parse(missing ? {} : loadSettings());
    console.log(
      JSON.stringify(
        {
          ...settings,
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
