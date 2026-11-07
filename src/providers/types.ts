export interface SearchInput {
  query: string;
  limit: number;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
}

export interface SearchProvider {
  search(input: SearchInput): Promise<SearchHit[]>;
}

export interface ScrapeProvider {
  scrape(url: string): Promise<string>;
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
    fullPage?: boolean,
  ): Promise<string | BrowserImage>;
  close(): Promise<void>;
}

export interface BrowserProvider {
  open(): Promise<BrowserSession>;
}
