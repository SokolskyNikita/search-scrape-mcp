import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { AppError } from "../server/error.js";
import { checkPage } from "./page-check.js";
import { cleanPage, markdownLink } from "./page-content.js";

const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function urlKey(href: string, base: URL) {
  const url = URL.parse(href, base);
  if (!url || !/^https?:$/.test(url.protocol) || href.startsWith("#"))
    return undefined;
  url.hash = "";
  return url.href;
}

function withTitle(markdown: string, title: string, h1: string) {
  const heading = markdown.match(/^#{1,6}\s+([^\n]+)(?:\n|$)/);
  const first = oneLine(heading?.[1]?.replace(markdownLink, "$1") ?? "");
  // Prefer the visible H1 when it matches the extracted lead or the metadata
  // title (which can carry a site name suffix).
  const name = h1 && (h1 === first || title.startsWith(h1)) ? h1 : title;
  if (!name) return markdown;
  if (heading && first === name)
    return "# " + markdown.replace(/^#{1,6}\s+/, "");
  return `# ${name}\n\n${markdown}`;
}

export type ExtractionCause =
  "links_lost" | "unusable_output" | "extractor_exception";

function redditFeed(document: Document, final: URL) {
  if (
    !/(^|\.)reddit\.com$/.test(final.hostname) ||
    final.pathname.includes("/comments/") ||
    !document.querySelector("shreddit-feed shreddit-post")
  )
    return undefined;

  // Defuddle's Reddit extractor treats the first post in a feed as a thread.
  const copy = document.cloneNode(true) as Document;
  const feed = copy.createDocumentFragment();
  for (const post of copy.querySelectorAll("shreddit-feed shreddit-post")) {
    if (post.closest("shreddit-ad-post")) continue;
    const title = oneLine(post.getAttribute("post-title") ?? "");
    const permalink = post.getAttribute("permalink");
    const href = permalink && urlKey(permalink, final);
    if (!title || !href) continue;
    const article = copy.createElement("article");
    const heading = copy.createElement("h2");
    const link = copy.createElement("a");
    link.setAttribute("href", href);
    link.textContent = title;
    heading.append(link);
    article.append(heading);
    const body = post.querySelector('[slot="text-body"]');
    if (body) article.append(...Array.from(body.childNodes));
    feed.append(article);
  }
  if (!feed.firstChild) return undefined;
  copy.body.replaceChildren(feed);
  return copy;
}

export async function mainContent(
  html: string,
  target: URL,
  final: URL,
  status: number,
  contentType?: string,
  success?: boolean,
) {
  const { document } = parseHTML(html);
  const body = (
    document.querySelector("body") ?? document.documentElement
  )?.cloneNode(true) as Element | undefined;
  for (const node of body?.querySelectorAll("script, style, template, head") ??
    [])
    node.remove();
  for (const node of body?.querySelectorAll("h1, h2, p, div, li, br") ?? []) {
    node.before("\n");
    node.after("\n");
  }
  const text = body?.textContent ?? "";
  const title = oneLine(document.querySelector("title")?.textContent ?? "");
  const h1 = oneLine(body?.querySelector("h1")?.textContent ?? "");
  const original = checkPage(
    cleanPage(title ? `# ${title}\n\n${text}` : text),
    target,
    final,
    status,
    contentType,
  );
  if (
    original.code !== "ok" &&
    original.code !== "empty_page" &&
    original.code !== "menus_only" &&
    !original.warning
  )
    return { markdown: "", check: original };

  if (success === false)
    throw new AppError(
      "provider_response",
      "Scrapfly reported an unsuccessful scrape.",
    );

  if (
    original.code === "empty_page" &&
    (status === 204 || (title && !text.trim()))
  )
    return { markdown: "", check: original };

  // Prefer the semantic main area. On pages without one, count linked
  // headings outside the site's navigation, which often mark listing items.
  const main = body?.querySelector('main, [role="main"]');
  const links = new Set<string>();
  for (const anchor of (main ?? body)?.querySelectorAll(
    main ? "a[href]" : ":is(h2,h3,h4,h5,h6) a[href]",
  ) ?? []) {
    if (anchor.closest('nav, header, footer, aside, [role="navigation"]'))
      continue;
    const href = urlKey(anchor.getAttribute("href")!, final);
    if (href) links.add(href);
  }
  function lostLinks(markdown: string) {
    if (links.size < 8) return false;
    const kept = new Set<string>();
    for (const match of markdown.matchAll(markdownLink)) {
      const href = urlKey(match[2] ?? match[3] ?? "", final);
      if (href && links.has(href)) kept.add(href);
    }
    return kept.size <= 2 && kept.size * 5 < links.size;
  }
  // Repeated author microdata marks pages with multiple contributions.
  // Defuddle's partial selector filtering can remove all of those bylines.
  const hasMultipleBylines =
    (body?.querySelectorAll('[itemprop~="author"]').length ?? 0) > 1;
  const extract = (
    standardize: boolean,
    broad = false,
    copy = document.cloneNode(true) as Document,
  ) => {
    for (const picture of copy.querySelectorAll("picture")) picture.remove();
    if (broad) {
      for (const node of copy.querySelectorAll("script, style, template"))
        node.remove();
    }
    return Defuddle(copy, final.href, {
      markdown: true,
      removeImages: true,
      includeReplies: "extractors",
      standardize,
      removePartialSelectors: !broad && !hasMultipleBylines,
      ...(broad && {
        contentSelector: "body",
        removeExactSelectors: false,
        removeLowScoring: false,
        removeContentPatterns: false,
      }),
      useAsync: false,
      fetch: async () => {
        throw new Error("Network access is disabled during extraction.");
      },
    });
  };
  const feed = redditFeed(document, final);
  if (feed) {
    try {
      const extracted = await extract(false, true, feed);
      const markdown = cleanPage(extracted.content);
      if (markdown)
        return {
          markdown: withTitle(markdown, h1 || title, h1),
          check: original.warning
            ? original
            : { code: "ok", reason: "Readable page content." },
        };
    } catch {
      // Use the normal extraction path if the feed cannot be converted.
    }
  }

  let markdown = "";
  let extractedTitle = "";
  let missingLinks = false;
  let listingRecovered = false;
  let extractorException = false;
  try {
    if (document.documentElement) {
      const extracted = await extract(true);
      extractedTitle = oneLine(extracted.title || title);
      markdown = cleanPage(extracted.content);
      missingLinks = lostLinks(markdown);
      if (missingLinks) {
        // Standardization can strip anchors nested inside listing headings.
        const retry = cleanPage((await extract(false)).content);
        if (!lostLinks(retry)) {
          markdown = retry;
          missingLinks = false;
          listingRecovered = true;
        }
      }
    }
  } catch {
    extractorException = true;
  }
  function unusable(content: string) {
    const prose = content.replace(markdownLink, "");
    const proseWords = words(prose);
    return (
      !words(content) ||
      (proseWords === 0 && content !== prose) ||
      (proseWords <= 5 && proseWords * 3 < words(text))
    );
  }
  const extractedPageCheck = (content: string) =>
    checkPage(content, target, final, status, contentType);
  let extractedCheck = extractedPageCheck(markdown);
  if (
    (original.code === "ok" || original.code === "empty_page") &&
    text.trim() &&
    (missingLinks ||
      unusable(markdown) ||
      extractedCheck.code === "empty_page" ||
      extractedCheck.code === "menus_only")
  ) {
    try {
      const extracted = await extract(true, true);
      const retry = cleanPage(extracted.content);
      const retryCheck = extractedPageCheck(retry);
      if (retryCheck.code === "ok" && !unusable(retry) && !lostLinks(retry)) {
        markdown = retry;
        missingLinks = false;
        extractedTitle = oneLine(extracted.title || title);
        extractedCheck = retryCheck;
      }
    } catch {
      extractorException = true;
    }
  }
  const extractionCause: ExtractionCause | undefined = missingLinks
    ? "links_lost"
    : unusable(markdown) ||
        (original.code === "ok" && extractedCheck.code !== "ok")
      ? extractorException
        ? "extractor_exception"
        : "unusable_output"
      : undefined;

  // Access and interstitial decisions come only from the original page.
  const check =
    extractionCause || (original.warning && original.code !== "menus_only")
      ? original
      : ["empty_page", "menus_only"].includes(extractedCheck.code)
        ? extractedCheck
        : { code: "ok", reason: "Readable page content." };
  return {
    extractionCause,
    markdown: markdown
      ? withTitle(markdown, listingRecovered && h1 ? h1 : extractedTitle, h1)
      : "",
    check,
  };
}
