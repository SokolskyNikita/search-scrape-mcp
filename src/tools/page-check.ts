import { messages } from "../config/messages.js";
export type PageCheck = {
  code: string;
  reason: string;
  next?: "stronger" | "render";
  warning?: true;
};

// Text lengths refer to visible characters after stripping Markdown links.
const TITLE_SCAN_CHARS = 3_000;
export const CHALLENGE_TEXT_CHARS = 3_000;
const NOT_FOUND_TEXT_CHARS = 600;
const SIGN_IN_TEXT_CHARS = 1_500;
const EMPTY_TEXT_CHARS = 75;
const SHELL_TEXT_CHARS = 3_000;
const PAYWALL_TEXT_CHARS = 5_000;
// Navigation and prose heuristics for classifying thin pages.
const LINK_MAJORITY = 0.5;
const PROSE_MIN_WORDS = 8;
const PROSE_PARAGRAPH_CHARS = 100;
const SHORT_MEANINGFUL_MIN_WORDS = 4;
const LONG_NAV_LEAD_CHARS = 1_200;
const LONG_NAV_MAX_PROSE_CHARS = 650;
const NAV_DOMINANCE_MIN_CHARS = 80;
const NAV_DOMINANCE_RATIO = 0.65;
const THIN_PAGE_CHARS = 200;
const SHORT_MENU_MIN_LINKS = 4;

const link = /!?\[([^\]\n]*)\]\((?:<[^>\n]*>|(?:[^()\n]|\([^()\n]*\))*)\)/g;
const challengeTitle =
  /^(?:just a moment|attention required(?:: cloudflare)?|security check|robot check|pardon our interruption|verify (?:that )?you are (?:a )?human|checking your browser)[.!…]*$/i;
const challengeBody =
  /verify (?:that )?you are (?:a )?human|enable javascript and cookies to continue|complete the security check|checking your browser|unusual traffic from your|captcha verification|cf-chl-/i;
const loginPath =
  /(?:^|\/)(?:login|log-in|signin|sign-in|sign_in|authenticate|auth\/login)(?:\/|$)/i;
const botPath =
  /(?:^|\/)(?:captcha|challenge|verify-human|bot-check|cdn-cgi\/challenge-platform)(?:\/|$)/i;

export const isChallengeUrl = (url: URL) => botPath.test(url.pathname);

function visible(line: string) {
  return line
    .replace(link, "$1")
    .replace(/https?:\/\/[^\s>]+/g, "")
    .replace(/^[\s#>*|_-]+/, "")
    .trim();
}

function title(markdown: string) {
  const lead = markdown.slice(0, TITLE_SCAN_CHARS);
  return visible(
    lead.match(/^#\s+(.+)$/m)?.[1] ?? lead.trimStart().split("\n", 1)[0] ?? "",
  );
}

export function looksChallenged(markdown: string, heading = title(markdown)) {
  if (challengeTitle.test(heading.trim())) return true;
  const text = markdown.split("\n").map(visible).join("\n").trim();
  return text.length < CHALLENGE_TEXT_CHARS && challengeBody.test(text);
}

export function looksBlocked(
  markdown: string,
  status?: number,
  heading = title(markdown),
) {
  return (
    status === 403 ||
    status === 429 ||
    /^(?:access denied|request blocked|forbidden|too many requests)[.!]*$/i.test(
      heading.trim(),
    )
  );
}

export function checkPage(
  markdown: string,
  requested: URL,
  final: URL,
  status: number,
  contentType?: string,
): PageCheck {
  const lines = markdown
    .split("\n")
    .map((line) => {
      const text = visible(line);
      const linked = [...line.matchAll(link)].reduce(
        (sum, match) => sum + (match[1]?.length ?? 0),
        0,
      );
      const menu =
        /^(?:home|menu|search|navigation|products|about(?: us)?|contact(?: us)?|support|sign in|log in|privacy policy|terms of service|skip to content)$/i.test(
          text,
        );
      return {
        text,
        nav: menu || (linked > 0 && linked >= text.length * LINK_MAJORITY),
        linked: linked > 0,
        prose:
          !menu &&
          linked < text.length * LINK_MAJORITY &&
          text.split(/\s+/).length >= PROSE_MIN_WORDS,
      };
    })
    .filter(({ text }) => text.length);
  const text = lines.map(({ text }) => text).join("\n");
  const heading = title(markdown);
  const opening = lines[0]?.text ?? "";
  const missingTitle =
    /^(?:404(?: error)?(?:[: –-]+(?:page )?not found)?|(?:page )?not found|page (?:does not|doesn't) exist|página não encontrada|no fue posible encontrar página|ページが見つかりません|ไม่พบหน้านี้)(?:[.!]*|\s*[|–—-]\s*[^|]+)$/i;

  if (
    [404, 410].includes(status) ||
    missingTitle.test(heading) ||
    missingTitle.test(opening) ||
    (text.length < NOT_FOUND_TEXT_CHARS &&
      /(?:the )?(?:page you (?:are|were) looking for|requested (?:page|url)) (?:could not be found|was not found|does not exist)/i.test(
        text,
      ))
  )
    return {
      code: "not_found",
      reason: messages.page.not_found,
    };
  if (
    (isChallengeUrl(final) && !isChallengeUrl(requested)) ||
    looksChallenged(markdown, heading)
  )
    return {
      code: "challenge",
      reason: messages.page.challenge,
      next: "stronger",
    };
  if (
    status === 401 ||
    (loginPath.test(final.pathname) &&
      final.pathname !== requested.pathname &&
      !loginPath.test(requested.pathname)) ||
    (text.length < SIGN_IN_TEXT_CHARS &&
      (/^(?:sign in|log in|login|sign in to continue|log in to continue)[.!]*$/i.test(
        heading,
      ) ||
        (loginPath.test(final.pathname) &&
          /^(?:sign in|log in) to\b/i.test(heading)) ||
        /\b(?:please |you must )?(?:sign in|log in) to (?:continue|access|view|read)\b/i.test(
          text,
        )))
  )
    return { code: "sign_in", reason: messages.page.sign_in };
  if (looksBlocked(markdown, status, heading))
    return {
      code: "blocked",
      reason: messages.page.blocked,
      next: "stronger",
    };
  if (status < 200 || status >= 300)
    return {
      code: "target_http",
      reason: messages.page.targetHttp(status),
    };
  if (
    final.hostname.replace(/^www\.|\.$/g, "") ===
      requested.hostname.replace(/^www\.|\.$/g, "") &&
    /^\/$/.test(final.pathname) &&
    !/^\/(?:index(?:\.[a-z]+)?|home)?\/?$/i.test(requested.pathname)
  )
    return {
      code: "content_moved",
      reason: messages.page.content_moved,
    };
  const shell =
    /enable javascript to (?:run this app|continue|view this (?:page|site))|this (?:app|site) requires javascript/i;
  const hasProse = lines.some(
    (line) =>
      line.prose &&
      line.text.replace(shell, "").trim().length >= PROSE_PARAGRAPH_CHARS,
  );
  const titleOnly =
    lines.length === 1 &&
    (((!contentType || /^text\/html\b/i.test(contentType)) &&
      /^#{1,6}\s/.test(markdown.trimStart())) ||
      (/^text\/html\b/i.test(contentType ?? "") &&
        opening.length < EMPTY_TEXT_CHARS &&
        !lines[0]?.linked &&
        !/[.!?…]$/.test(opening)));
  if (
    status === 204 ||
    titleOnly ||
    !/[\p{L}\p{N}]/u.test(text) ||
    (text.length < EMPTY_TEXT_CHARS &&
      !lines.some(
        ({ text, nav }) =>
          !nav &&
          (/[.!?]$|@|\d/.test(text) ||
            text.split(/\s+/).length >= SHORT_MEANINGFUL_MIN_WORDS),
      )) ||
    (text.length < SHELL_TEXT_CHARS && !hasProse && shell.test(text)) ||
    /^(?:loading|please wait|loading content)[ .…!]*$/i.test(text)
  )
    return {
      code: "empty_page",
      reason: shell.test(text)
        ? messages.page.render
        : messages.page.empty_page,
      next: "render",
    };
  if (
    /^member[- ]only story[.!]?$/im.test(text.slice(0, TITLE_SCAN_CHARS)) ||
    (text.length < PAYWALL_TEXT_CHARS &&
      (/\bsubscribe to (?:continue reading|read the full (?:story|article))\b/i.test(
        text,
      ) ||
        /^.{0,45}\b(?:subscribe|subscription|subscribers only|purchase access)\b.{0,80}(?:continue reading|read (?:the|this|full)|full (?:story|article)|access this article)|^this (?:article|story) is (?:for|available to) subscribers/im.test(
          text,
        )))
  )
    return {
      code: "paywall",
      reason: messages.page.paywall,
      warning: true,
    };

  const prose = lines.filter((line) => line.prose && !line.nav);
  const proseLength = prose.reduce((n, line) => n + line.text.length, 0);
  const firstProse = lines.findIndex(
    (line) =>
      line.prose && !line.nav && line.text.length >= PROSE_PARAGRAPH_CHARS,
  );
  const lead = firstProse < 0 ? lines : lines.slice(0, firstProse);
  const leadLength = lead.reduce((n, line) => n + line.text.length, 0);
  const leadNav = lead.reduce(
    (n, line) => n + (line.nav ? line.text.length : 0),
    0,
  );
  const navLength = lines.reduce(
    (n, line) => n + (line.nav ? line.text.length : 0),
    0,
  );
  const index = (url: URL) =>
    url.pathname === "/" ||
    /(?:^|\/)(?:index|sitemap|categor(?:y|ies)|tags?)(?:[/.]|$)/i.test(
      url.pathname,
    );
  if (
    !index(requested) &&
    !index(final) &&
    ((leadLength >= LONG_NAV_LEAD_CHARS &&
      leadNav >= leadLength * LINK_MAJORITY &&
      proseLength < LONG_NAV_MAX_PROSE_CHARS) ||
      (text.length >= NAV_DOMINANCE_MIN_CHARS &&
        navLength >= text.length * NAV_DOMINANCE_RATIO &&
        proseLength < THIN_PAGE_CHARS) ||
      (text.length < THIN_PAGE_CHARS &&
        proseLength === 0 &&
        lines.filter((line) => line.linked).length >= SHORT_MENU_MIN_LINKS))
  )
    return {
      code: "menus_only",
      reason: messages.page.menus_only,
      next: "stronger",
      warning: true,
    };
  return { code: "ok", reason: "Readable page content." };
}
