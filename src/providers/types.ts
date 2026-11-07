import type { PageCheck } from "../tools/page-check.js";

export interface SearchInput {
  query: string;
  limit: number;
  recency?: "day" | "week" | "month" | "year";
  location?: string;
  gl?: string;
  hl?: string;
  page?: number;
  autocorrect?: boolean;
  tbs?: string;
  site?: string;
  exclude_domains?: string[];
}

export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
  date?: string;
}

export interface SearchProvider {
  readonly name?: string;
  search(
    input: SearchInput,
    signal?: AbortSignal,
    retry?: () => void,
  ): Promise<SearchHit[]>;
}

export const scrapeRungs = ["datacenter", "unblocker", "render"] as const;
export type ScrapeRung = (typeof scrapeRungs)[number];
export type ScrapeResult = {
  markdown: string;
  check: PageCheck;
  hint?: string;
};
export type ScrapeOptions = { start?: ScrapeRung; tried: string[] };

export interface ScrapeProvider {
  readonly name?: string;
  scrape(
    url: string,
    signal?: AbortSignal,
    options?: ScrapeOptions,
  ): Promise<ScrapeResult>;
}

export type BrowserTarget = { selector?: string; ref?: string };
export type BrowserImage = {
  type: "image";
  mimeType: "image/jpeg";
  data: string;
};

export type BrowserAction =
  | { action: "navigate"; url: string }
  | { action: "snapshot" }
  | ({ action: "click" } & BrowserTarget)
  | ({ action: "fill"; text: string } & BrowserTarget)
  | ({ action: "press"; key: string } & BrowserTarget)
  | { action: "scroll"; pixels: number }
  | { action: "back" }
  | { action: "wait"; ms: number; selector?: string }
  | { action: "screenshot" }
  | { action: "close" };

export interface BrowserSession {
  run(
    action: Exclude<BrowserAction, { action: "close" }>,
    signal?: AbortSignal,
  ): Promise<string | BrowserImage>;
  close(): Promise<void>;
}

export interface BrowserProvider {
  readonly name?: string;
  open(signal?: AbortSignal, target?: URL): Promise<BrowserSession>;
}
