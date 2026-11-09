export type HostAccess = "scrape" | "browser";

type HostRule = {
  domains: readonly string[];
  denied: readonly HostAccess[];
  accessError: string;
  searchHint: string;
};

const hostRules: readonly HostRule[] = [
  {
    domains: [
      "github.com",
      "githubusercontent.com",
      "githubassets.com",
      "github.io",
      "github.dev",
      "githubapp.com",
      "githubcopilot.com",
      "ghcr.io",
    ],
    denied: ["scrape", "browser"],
    accessError: "Open this GitHub URL with gh.",
    searchHint:
      "search-scrape-mcp doesn't support opening GitHub links. Use gh instead.",
  },
  {
    domains: ["reddit.com", "redd.it"],
    denied: ["browser"],
    accessError: "Use scrape or scrape_batch to open Reddit links.",
    searchHint: "Use scrape or scrape_batch for Reddit links.",
  },
];

export function hostRule(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return hostRules.find(({ domains }) =>
    domains.some((domain) => host === domain || host.endsWith(`.${domain}`)),
  );
}
