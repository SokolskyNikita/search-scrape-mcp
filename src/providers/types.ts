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

export type BrowserAction =
  | { action: "navigate"; url: string }
  | { action: "snapshot" }
  | { action: "click"; selector: string }
  | { action: "fill"; selector: string; text: string }
  | { action: "press"; selector: string; key: string }
  | { action: "close" };

export interface BrowserSession {
  run(
    action: Exclude<BrowserAction, { action: "close" }>,
    fullPage?: boolean,
  ): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserProvider {
  open(): Promise<BrowserSession>;
}
