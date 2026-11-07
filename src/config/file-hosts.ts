import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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
  expectedCredits: z.number().finite().nonnegative(),
  reason: z.string().min(1),
});
type CostNotice = Omit<z.infer<typeof costNotice>, "host">;

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
    const hosts = new Set(this.seeds);
    const costs = new Map<string, CostNotice>();
    try {
      const recorded = withFile(this.file, constants.O_RDONLY, (fd) =>
        readFileSync(fd, "utf8"),
      );
      for (const line of recorded.split("\n").filter(Boolean)) {
        if (line.startsWith("{")) {
          const { host, ...notice } = costNotice.parse(JSON.parse(line));
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
    return { hosts, costs };
  }

  list() {
    return this.read().hosts;
  }

  remember(host: string, notice?: CostNotice) {
    try {
      host = fileHost.parse(host);
      const { hosts, costs } = this.read();
      const previous = costs.get(host);
      if (
        notice
          ? previous &&
            (previous.expectedCredits > notice.expectedCredits ||
              (previous.expectedCredits === notice.expectedCredits &&
                previous.reason === notice.reason))
          : hosts.has(host)
      )
        return;
      const line = notice ? JSON.stringify({ host, ...notice }) : host;
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      withFile(
        this.file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
        (fd) => writeFileSync(fd, line + "\n", { flush: true }),
      );
    } catch {
      console.error("Could not persist Scrapfly host state.");
    }
  }
}
