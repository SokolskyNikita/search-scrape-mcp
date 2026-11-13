import { readFileSync } from "node:fs";

/** The installed version, from package.json (scripts/release.sh sets it). */
export const version = (
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;
