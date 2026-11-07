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

  list() {
    const hosts = new Set(this.seeds);
    try {
      const recorded = withFile(this.file, constants.O_RDONLY, (fd) =>
        readFileSync(fd, "utf8"),
      );
      for (const line of recorded.split("\n").filter(Boolean))
        hosts.add(fileHost.parse(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new AppError(
          "file_host_state",
          "Could not read private file host state.",
        );
    }
    return hosts;
  }

  remember(host: string) {
    try {
      if (this.list().has(host)) return;
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      withFile(
        this.file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
        (fd) => writeFileSync(fd, fileHost.parse(host) + "\n", { flush: true }),
      );
    } catch {
      console.error("Could not persist a host that returned a file.");
    }
  }
}
