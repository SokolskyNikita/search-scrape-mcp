import { AppError } from "../server/error.js";

import { looksBlocked, looksChallenged } from "./page-check.js";

export function cleanPage(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function pageContent(
  text: string,
  { status, title = "" }: { status?: number; title?: string } = {},
): string {
  const clean = cleanPage(text);
  if (looksChallenged(clean) || (title && looksChallenged(clean, title)))
    throw new AppError(
      "challenge",
      "Anti-bot challenge remains. Try the site’s API, CLI or local browser.",
    );
  if (
    status === 401 ||
    looksBlocked(clean, status) ||
    (title && looksBlocked(clean, status, title))
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
  return clean;
}
