import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AppError } from "../server/error.js";
import {
  SCRAPFLY_COST_OBSERVATIONS_REQUIRED,
  SCRAPFLY_STANDARD_COST,
} from "./safety-limits.js";

export const normalizeFileHost = (host: string) =>
  host.toLowerCase().replace(/\.$/, "");
export const fileHost = z
  .string()
  .trim()
  .regex(/^(?:[a-z0-9.-]{1,253}|\[[a-f0-9:]{2,39}\])$/i)
  .transform(normalizeFileHost);

export const fileHostsPath = () =>
  join(homedir(), ".local", "state", "search-scrape-mcp", "file-hosts.txt");

const costNotice = z.object({
  host: fileHost,
  file: z.boolean().optional(),
  expectedCredits: z.number().finite().nonnegative(),
  observed: z.literal(true).optional(),
});
type CostNotice = { expectedCredits: number; observations: number };

function withFile<T>(file: string, flags: number, run: (fd: number) => T) {
  const fd = openSync(
    file,
    flags | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid?.())
      throw new Error("File host state is not private.");
    return run(fd);
  } finally {
    closeSync(fd);
  }
}

export class FileHosts {
  constructor(
    private readonly seeds: readonly string[],
    private readonly file = fileHostsPath(),
  ) {}

  read() {
    const hosts = new Set<string>();
    const costs = new Map<string, CostNotice>();
    try {
      const recorded = withFile(this.file, constants.O_RDONLY, (fd) =>
        readFileSync(fd, "utf8"),
      );
      for (const line of recorded.split("\n").filter(Boolean)) {
        if (line.startsWith("{")) {
          const { host, file, expectedCredits, observed } = costNotice.parse(
            JSON.parse(line),
          );
          if (file) hosts.add(host);
          if (observed && expectedCredits >= SCRAPFLY_STANDARD_COST) {
            const prior = costs.get(host);
            costs.set(host, {
              expectedCredits: Math.max(
                expectedCredits,
                prior?.expectedCredits ?? 0,
              ),
              observations: (prior?.observations ?? 0) + 1,
            });
          }
        } else {
          hosts.add(fileHost.parse(line));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new AppError(
          "file_host_state",
          "Could not read private file host state.",
        );
    }
    return {
      hosts: new Set([...this.seeds, ...hosts]),
      costs: new Map(
        [...costs].filter(
          ([, cost]) =>
            cost.observations >= SCRAPFLY_COST_OBSERVATIONS_REQUIRED,
        ),
      ),
    };
  }

  list() {
    return this.read().hosts;
  }

  remember(host: string) {
    try {
      host = fileHost.parse(host);
      if (!this.list().has(host)) this.append(host);
    } catch {
      console.error("Could not persist Scrapfly host state.");
    }
  }

  observeCost(host: string, credits: number | null) {
    if (
      credits === null ||
      !Number.isFinite(credits) ||
      credits < SCRAPFLY_STANDARD_COST
    )
      return;
    try {
      host = fileHost.parse(host);
      // Once approval is required, the provider log tracks later charges.
      if (this.read().costs.has(host)) return;
      this.append(
        JSON.stringify({ host, expectedCredits: credits, observed: true }),
      );
    } catch {
      console.error("Could not persist Scrapfly host state.");
    }
  }

  private append(line: string) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    // A single append per event avoids lost increments across writers.
    withFile(
      this.file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
      (fd) => writeSync(fd, "\n" + line + "\n"),
    );
  }
}
