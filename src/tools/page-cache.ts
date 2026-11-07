import { randomUUID } from "node:crypto";
import { AppError } from "../server/error.js";

export class PageCache {
  private readonly pages = new Map<
    string,
    { markdown: string; expires: number }
  >();
  private chars = 0;

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxChars = 16_000_000,
    private readonly maxPages = 128,
  ) {}

  put(markdown: string): string {
    if (markdown.length > this.maxChars)
      throw new AppError("page_size", "Page exceeds the cache size limit.");
    for (const [id, page] of this.pages) {
      if (
        page.expires <= Date.now() ||
        this.pages.size >= this.maxPages ||
        this.chars + markdown.length > this.maxChars
      )
        this.remove(id, page);
      else break;
    }
    const id = randomUUID();
    this.pages.set(id, { markdown, expires: Date.now() + this.ttlMs });
    this.chars += markdown.length;
    return id;
  }

  get(id: string): string {
    const page = this.pages.get(id);
    if (page && page.expires > Date.now()) return page.markdown;
    if (page) this.remove(id, page);
    throw new AppError(
      "page_expired",
      "Cached page expired or was evicted. Scrape it again.",
    );
  }

  read(pageId: string, offset: number, limit: number) {
    const markdown = this.get(pageId);
    if (offset > markdown.length)
      throw new AppError("page_offset", "Offset is past the end of the page.");
    let end = Math.min(offset + limit, markdown.length);
    // Keep surrogate pairs together at chunk boundaries.
    if (end < markdown.length && /[\uDC00-\uDFFF]/.test(markdown.charAt(end)))
      end--;
    return {
      pageId,
      offset,
      nextOffset: end < markdown.length ? end : null,
      totalChars: markdown.length,
      markdown: markdown.slice(offset, end),
    };
  }

  private remove(id: string, page: { markdown: string }) {
    this.pages.delete(id);
    this.chars -= page.markdown.length;
  }
}
