import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AppError } from "../server/error.js";

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
  reason: z.string().min(1),
});
type CostNotice = Omit<z.infer<typeof costNotice>, "host" | "file">;

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

  read(includeSeeds = true) {
    const hosts = new Set<string>();
    const costs = new Map<string, CostNotice>();
    try {
      const recorded = withFile(this.file, constants.O_RDONLY, (fd) =>
        readFileSync(fd, "utf8"),
      );
      for (const line of recorded.split("\n").filter(Boolean)) {
        if (line.startsWith("{")) {
          const { host, file, ...notice } = costNotice.parse(JSON.parse(line));
          if (file) hosts.add(host);
          if (notice.expectedCredits >= (costs.get(host)?.expectedCredits ?? 0))
            costs.set(host, notice);
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
      hosts: includeSeeds ? new Set([...this.seeds, ...hosts]) : hosts,
      costs,
    };
  }

  list() {
    return this.read().hosts;
  }

  remember(host: string, notice?: CostNotice) {
    try {
      host = fileHost.parse(host);
      const { hosts, costs } = this.read(false);
      const previous = costs.get(host);
      if (notice) {
        if (previous && previous.expectedCredits > notice.expectedCredits)
          return;
        if (
          previous?.expectedCredits === notice.expectedCredits &&
          previous.reason === notice.reason
        )
          return;
        costs.set(host, notice);
      } else {
        if (hosts.has(host) || this.seeds.includes(host)) return;
        hosts.add(host);
      }
      const lines = [...new Set([...hosts, ...costs.keys()])].map((name) => {
        const cost = costs.get(name);
        return cost
          ? JSON.stringify({
              host: name,
              ...(hosts.has(name) ? { file: true } : {}),
              ...cost,
            })
          : name;
      });
      const dir = dirname(this.file);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temporary = mkdtempSync(join(dir, ".file-hosts-"));
      try {
        const next = join(temporary, "state");
        withFile(
          next,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          (fd) => writeFileSync(fd, lines.join("\n") + "\n", { flush: true }),
        );
        renameSync(next, this.file);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    } catch {
      console.error("Could not persist Scrapfly host state.");
    }
  }
}
