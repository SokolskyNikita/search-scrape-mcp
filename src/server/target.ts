import { MAX_URL_CHARS } from "../config/safety-limits.js";
import { Resolver } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { AppError } from "./error.js";

const dns = new Resolver({ timeout: 1500, tries: 2 });
const globalV6 = ipaddr.parseCIDR("2000::/3");
const specialV4 = ["192.0.0.0/24", "192.88.99.0/24"].map((cidr) =>
  ipaddr.IPv4.parseCIDR(cidr),
);

function publicIp(value: string): boolean {
  const ip = ipaddr.parse(value);
  if (ip.range() !== "unicast") return false;
  if (ip instanceof ipaddr.IPv4)
    return !specialV4.some((cidr) => ip.match(cidr));
  return ip.match(globalV6);
}

const forbidden = (message: string) => new AppError("unsafe_url", message);

export async function validatePublicUrl(value: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw forbidden("The URL is invalid.");
  }
  if (
    value.length > MAX_URL_CHARS ||
    /[\u0000-\u0020\u007f\\]/.test(value) ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw forbidden("Use a valid public HTTP or HTTPS URL.");
  if (url.username || url.password)
    throw forbidden("URL credentials are not allowed.");
  if (url.port) throw forbidden("Use the standard port for the URL scheme.");

  const host = url.hostname.replace(/^\[|\]$|\.$/g, "");
  if (ipaddr.isValid(host)) {
    if (!publicIp(host))
      throw forbidden("The URL points to a private or reserved IP address.");
    return url;
  }
  if (
    !host.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal|home\.arpa|test|invalid|example|onion)$/.test(
      host,
    )
  ) {
    throw forbidden("The URL hostname is local or reserved.");
  }
  const answers = await Promise.allSettled([
    dns.resolve4(`${host}.`),
    dns.resolve6(`${host}.`),
  ]);
  const addresses = [];
  for (const answer of answers) {
    if (answer.status === "fulfilled") addresses.push(...answer.value);
    else {
      const code = (answer.reason as NodeJS.ErrnoException).code;
      if (code !== "ENODATA" && code !== "ENOTFOUND") {
        throw new AppError("dns", "Could not verify target DNS.");
      }
    }
  }
  if (!addresses.length)
    throw new AppError("dns", "Target hostname did not resolve.");
  if (addresses.some((address) => !publicIp(address)))
    throw forbidden(
      "The URL hostname resolves to a private or reserved IP address.",
    );
  return url;
}
