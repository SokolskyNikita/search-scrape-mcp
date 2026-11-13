import type { ScrapeRung } from "../providers/types.js";

type SiteSettings = {
  domains: readonly string[];
  /** Where the ladder starts when the caller doesn't pass start_rung. */
  startRung: ScrapeRung;
  /** Sent on every rung instead of the rung's own pool. */
  proxyPool?: string;
  /** Leave a retry on a stronger rung to the caller instead of making it automatically. */
  extractionRetry?: "manual";
};

const siteSettings: readonly SiteSettings[] = [
  {
    // Threads load their comments only when rendered (live probe, November 2026).
    domains: ["reddit.com", "redd.it"],
    startRung: "render",
    proxyPool: "public_residential_pool",
    extractionRetry: "manual",
  },
  {
    // Profile and company pages hit challenges when rendered, and load without
    // rendering in about half the time (live probes, November 2026).
    domains: ["linkedin.com"],
    startRung: "datacenter",
  },
];

export function siteScrapeSettings(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return siteSettings.find(({ domains }) =>
    domains.some((domain) => host === domain || host.endsWith(`.${domain}`)),
  );
}
