import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { AppError } from "../server/error.js";
import { checkPage } from "./page-check.js";
import { cleanPage } from "./page-content.js";

export async function mainContent(
  html: string,
  target: URL,
  final: URL,
  status: number,
  contentType?: string,
  success?: boolean,
) {
  const { document } = parseHTML(html);
  // Check the original title and body before Defuddle removes page elements.
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
  const title = document.querySelector("title")?.textContent?.trim();
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

  let markdown = "";
  try {
    if (document.documentElement) {
      const extracted = await Defuddle(document, final.href, {
        markdown: true,
        removeImages: true,
        includeReplies: "extractors",
        useAsync: false,
        fetch: async () => {
          throw new Error("Network access is disabled during extraction.");
        },
      });
      markdown = cleanPage(extracted.content);
    }
  } catch {
    markdown = "";
  }
  if (!/[\p{L}\p{N}]/u.test(markdown)) {
    if (original.code === "empty_page" && text.trim())
      return { markdown: "", check: original };
    throw new AppError(
      "extraction_failed",
      "Defuddle found no usable main content.",
    );
  }

  const check =
    original.code === "paywall"
      ? original
      : checkPage(markdown, target, final, status, contentType);
  return { markdown, check };
}
