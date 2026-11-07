import { AppError } from "../server/error.js";

import { looksBlocked, looksChallenged } from "./page-check.js";

// Inline links emitted by Defuddle and Scrapfly, including balanced URL
// parentheses and optional double-quoted titles.
const linkPattern =
  /\[((?:\\.|[^\]\\\n])*)\]\((?:<([^>\n]*)>|((?:\\.|[^\s()\\]|\([^()\n]*\))+))(?:[ \t]+"((?:\\.|[^"\\\n])*)")?\)/;
export const markdownLink = new RegExp(linkPattern.source, "g");
const inlineMarkup = new RegExp("`+.*?`+|!?" + linkPattern.source, "g");

function nextNonBlank(lines: string[], index: number) {
  while (index < lines.length && !lines[index]?.trim()) index++;
  return lines[index];
}

export function cleanPage(text: string): string {
  let fence: string | undefined;
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n")
    .map((line, index, lines) => {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (marker?.[1]?.startsWith(fence) && !marker[2]?.trim())
          fence = undefined;
        return line;
      }
      if (marker) {
        fence = marker[1];
        return line;
      }
      if (/^\s*\d[\d,]* likes?\s*$/i.test(line)) return "";
      if (
        /^ {0,3}\[\^[^\]]+\]:[ \t]*$/.test(line) &&
        !/^(?: {4}|\t)\S/.test(nextNonBlank(lines, index + 1) ?? "")
      )
        return "";
      return line.replace(inlineMarkup, (match, label, angled, url, title) => {
        if (match.startsWith("!")) return "";
        if (title === undefined || label !== title) return match;
        return `[${label}](${angled === undefined ? url : `<${angled}>`})`;
      });
    })
    .join("\n")
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
