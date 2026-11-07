import { AppError } from "../server/error.js";

export function pageContent(
  text: string,
  {
    status,
    title = "",
    limit = 12_000,
  }: { status?: number; title?: string; limit?: number } = {},
): string {
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const beginning = clean.slice(0, 2200);
  const titleOrLead = `${title}\n${beginning.split("\n").find((line) => line.trim()) ?? ""}`;
  if (
    /(?:^|\n)\s*(?:#+\s*)?(?:just a moment|attention required|verify (?:that )?you are (?:a )?human|checking your browser|robot check|security check|pardon our interruption)[.!…]*[ \t]*$/im.test(
      titleOrLead,
    ) ||
    /(?:enable javascript and cookies to continue|complete the security check|verify (?:that )?you are (?:a )?human to continue|cf-chl-|challenges\.cloudflare\.com\/turnstile)/i.test(
      beginning,
    )
  )
    throw new AppError(
      "challenge",
      "Anti-bot challenge remains. Try the site’s API, CLI or local browser.",
    );
  if (
    status === 401 ||
    status === 403 ||
    status === 429 ||
    /(?:^|\n)\s*(?:#+\s*)?(?:access denied|request blocked|forbidden|too many requests)[.!…]*[ \t]*$/im.test(
      titleOrLead,
    )
  )
    throw new AppError(
      "blocked",
      "Target blocked access. Try the site’s API, CLI or local browser.",
    );
  if (status !== undefined && (status < 200 || status >= 300)) {
    throw new AppError("target_http", `Target returned HTTP ${status}.`);
  }
  if (!/[\p{L}\p{N}]/u.test(clean))
    throw new AppError("empty_page", "Target returned no readable content.");
  return clean.length <= limit
    ? clean
    : clean.slice(0, Math.max(0, limit - 15)).trimEnd() + "\n\n[truncated]";
}
