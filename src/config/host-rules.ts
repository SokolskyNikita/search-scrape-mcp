export type HostAccess = "scrape" | "browser";

type HostRule = {
  domains: readonly string[];
  denied: readonly HostAccess[];
  accessError: string;
  searchHint: string;
};

const youtubeRule: HostRule = {
  domains: ["youtube.com", "youtu.be"],
  denied: ["scrape", "browser"],
  accessError: "Use the youtube tool to open YouTube video links.",
  searchHint: "Use the youtube tool for YouTube video metadata and captions.",
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
  youtubeRule,
  {
    // Every scrape failed on its anti-bot shield, on all rungs (November 2026).
    domains: ["businesswire.com"],
    denied: ["scrape", "browser"],
    accessError:
      "Business Wire blocks scraping. Search the release title instead: the same release is usually on the company’s site or another newswire.",
    searchHint:
      "Business Wire blocks scraping. To read a release, search its title and open a copy on the company’s site or another newswire.",
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

export function youtubeVideoId(url: URL) {
  if (
    hostRule(url.hostname) !== youtubeRule ||
    !["http:", "https:"].includes(url.protocol) ||
    url.port ||
    url.username ||
    url.password
  )
    return undefined;

  const host = url.hostname.replace(/\.$/, "");
  const id =
    host === "youtu.be"
      ? /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1]
      : url.pathname === "/watch"
        ? url.searchParams.get("v")
        : /^\/(?:shorts|live|embed)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
  return id && /^[\w-]{11}$/.test(id) ? id : undefined;
}

export function urlRule(url: URL) {
  const rule = hostRule(url.hostname);
  if (rule === youtubeRule && !youtubeVideoId(url)) {
    const message =
      "Use the youtube tool with an individual YouTube video link.";
    return { ...rule, accessError: message, searchHint: message };
  }
  return rule;
}
