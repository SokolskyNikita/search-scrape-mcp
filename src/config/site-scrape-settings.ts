const siteSettings = [
  {
    domains: ["reddit.com", "redd.it"],
    startRung: "unblocker",
    proxyPool: "public_residential_pool",
    extractionRetry: "manual",
  },
] as const;

export function siteScrapeSettings(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return siteSettings.find(({ domains }) =>
    domains.some((domain) => host === domain || host.endsWith(`.${domain}`)),
  );
}
