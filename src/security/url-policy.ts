import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export interface LookupAddress {
  address: string;
  family: 4 | 6;
}

export type Lookup = (hostname: string) => Promise<readonly LookupAddress[]>;

const blockedAddresses = new BlockList();

for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(address, prefix, "ipv4");
}

for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(address, prefix, "ipv6");
}

const forbiddenHostnames = /(^|\.)(localhost|local|internal|home|lan)$/i;
const riskyPath =
  /(?:^|[\/_\-.])(logout|signout|unsubscribe|delete|remove|destroy|checkout|purchase|payment|download|export|oauth|authorize|login|signin|signup|register|confirm)(?:$|[\/_\-.])/i;
const binaryPath = /\.(?:zip|dmg|pkg|exe|msi|deb|rpm|tar|gz|7z|iso)$/i;

function decodePath(pathname: string): string | null {
  let decoded = pathname;
  try {
    for (let pass = 0; pass < 5; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return next.normalize("NFKC");
      decoded = next;
    }
  } catch {
    return null;
  }
  return /%[0-9a-f]{2}/i.test(decoded) ? null : decoded.normalize("NFKC");
}

function normalizedIp(address: string): { address: string; family: "ipv4" | "ipv6" } | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return { address: mapped[1], family: "ipv4" };
  const family = isIP(address);
  if (family === 4) return { address, family: "ipv4" };
  if (family === 6) return { address, family: "ipv6" };
  return null;
}

function isBlockedAddress(address: string): boolean {
  const normalized = normalizedIp(address);
  return normalized === null || blockedAddresses.check(normalized.address, normalized.family);
}

function assertSyntacticallyPublicHostname(hostname: string): void {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (!normalized || forbiddenHostnames.test(normalized)) {
    throw new Error("URL must use a public hostname");
  }
  if (isIP(normalized) !== 0 && isBlockedAddress(normalized)) {
    throw new Error("URL must use a public hostname");
  }
}

export function validateStartUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URL is invalid");
  }
  if (url.protocol !== "https:") throw new Error("Only HTTPS URLs are allowed");
  if (url.username || url.password) throw new Error("Embedded URL credentials are not allowed");
  assertSyntacticallyPublicHostname(url.hostname);
  return url;
}

export function candidateUrl(base: URL, href: string, download: boolean): URL | null {
  if (download) return null;
  let candidate: URL;
  try {
    candidate = new URL(href, base);
  } catch {
    return null;
  }
  if (candidate.protocol !== "https:" || candidate.origin !== base.origin) return null;
  if (candidate.username || candidate.password || candidate.search) return null;
  const decodedPath = decodePath(candidate.pathname);
  if (!decodedPath || riskyPath.test(decodedPath) || binaryPath.test(decodedPath)) return null;
  try {
    assertSyntacticallyPublicHostname(candidate.hostname);
  } catch {
    return null;
  }
  candidate.hash = "";
  return candidate;
}

const defaultLookup: Lookup = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
};

export async function assertPublicHostname(hostname: string, lookup: Lookup = defaultLookup): Promise<void> {
  assertSyntacticallyPublicHostname(hostname);
  const addresses = await lookup(hostname);
  if (addresses.length === 0) throw new Error("Hostname did not resolve");
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(`Hostname resolved to a non-public address: ${address}`);
    }
  }
}
