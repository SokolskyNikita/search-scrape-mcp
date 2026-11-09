import type { ExtractionCause } from "../tools/main-content.js";
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
  dateIso?: string;
}

export interface SearchProvider {
  readonly name?: string;
  search(
    input: SearchInput,
    signal?: AbortSignal,
    retry?: () => void,
    deadline?: number,
  ): Promise<SearchHit[]>;
}

export const scrapeRungs = [
  "datacenter",
  "unblocker",
  "render",
  "residential_render",
] as const;
export type ScrapeRung = (typeof scrapeRungs)[number];
export const scrapeContentModes = ["main", "full"] as const;
export type ScrapeContentMode = (typeof scrapeContentModes)[number];
export type ScrapeResult = {
  markdown: string;
  finalUrl?: string;
  check: PageCheck;
  hint?: string;
  retryRung?: ScrapeRung;
  retryHigherCost?: true;
  binary?: { bytes: Buffer; mimeType: string; extension?: string };
  extraction?: { cause: ExtractionCause; html: string; fallbackText?: string };
  credits?: number;
  costWarning?: string;
};
export type ScrapeOptions = {
  contentMode?: ScrapeContentMode;
  start?: ScrapeRung;
  allowHigherCost?: boolean;
  tried: string[];
  deadline?: number;
};

export interface ScrapeProvider {
  readonly name?: string;
  scrape(
    url: string,
    signal?: AbortSignal,
    options?: ScrapeOptions,
  ): Promise<ScrapeResult>;
}

export type BrowserNavigation = {
  url: URL;
  status: number;
  title: string;
  text: string;
};
export type BrowserSnapshot = { text: string; note?: string };
export type BrowserTarget = { selector?: string; ref?: string };
export type BrowserImage = {
  type: "image";
  mimeType: "image/jpeg";
  data: string;
};

export type BrowserAction =
  | { action: "navigate"; url: string }
  | {
      action: "snapshot";
      scope?: "viewport" | "page" | "full";
      target?: string;
    }
  | { action: "find"; query: string }
  | ({ action: "click" } & BrowserTarget)
  | ({ action: "fill"; text: string } & BrowserTarget)
  | ({ action: "press"; key: string } & BrowserTarget)
  | { action: "scroll"; pixels: number }
  | { action: "back" }
  | { action: "wait"; ms: number; selector?: string }
  | { action: "screenshot" }
  | { action: "close" };

export interface BrowserSession {
  currentUrl?(): string;
  run(
    action: Exclude<BrowserAction, { action: "close" }>,
    signal?: AbortSignal,
  ): Promise<string | BrowserImage | BrowserNavigation | BrowserSnapshot>;
  close(): Promise<void>;
}

export interface BrowserProvider {
  readonly name?: string;
  open(signal?: AbortSignal, target?: URL): Promise<BrowserSession>;
}
