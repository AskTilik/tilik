/**
 * Decides whether a URL may be fetched (by an extraction provider) or shown as
 * a source. Blocks anything that is not a plain public web page:
 * non-http(s) schemes, embedded credentials, private/loopback/link-local/
 * metadata addresses, intranet hostnames, unusual ports, binary downloads,
 * and operator-blocked domains.
 *
 * Note: VEYRA never fetches pages itself — Jina/Firecrawl do — so this is
 * defence in depth against SSRF-style abuse of those services and against
 * leaking internal URLs, not a substitute for network egress controls.
 */
export type UrlCheck = { ok: true; url: string; host: string; flags: string[] } | { ok: false; reason: string };

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".corp", ".intranet"];
const BINARY_EXT = /\.(exe|msi|dmg|pkg|apk|bat|cmd|ps1|scr|jar|bin|iso|dll|so|deb|rpm)$/i;

export function checkUrl(raw: string, opts: { blockedDomains?: string[] } = {}): UrlCheck {
  if (raw.length > 2048) return { ok: false, reason: "URL too long" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: `scheme ${url.protocol} not allowed` };
  if (url.username || url.password) return { ok: false, reason: "URLs with embedded credentials are not allowed" };

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare.includes(":")) {
    // IPv6 literal: only global unicast (2000::/3) is public.
    if (!/^[23][0-9a-f]{0,3}:/.test(bare)) return { ok: false, reason: "private or reserved IPv6 address" };
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(bare)) {
    // WHATWG URL parsing already normalizes decimal/hex/octal IPv4 forms to dotted quads.
    if (isPrivateIPv4(bare)) return { ok: false, reason: "private, loopback or reserved IPv4 address" };
  } else {
    if (host === "localhost" || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, reason: "internal hostname" };
    if (!host.includes(".")) return { ok: false, reason: "single-label (intranet) hostname" };
  }
  if (!ALLOWED_PORTS.has(url.port)) return { ok: false, reason: `port ${url.port} not allowed` };

  const domain = host.replace(/^www\./, "");
  const blocked = (opts.blockedDomains ?? []).find((d) => domain === d || domain.endsWith(`.${d}`));
  if (blocked) return { ok: false, reason: `domain ${blocked} is blocked by configuration` };
  if (BINARY_EXT.test(url.pathname)) return { ok: false, reason: "binary/executable downloads are not fetched" };

  const flags: string[] = [];
  if (host.split(".").some((label) => label.startsWith("xn--"))) flags.push("punycode_domain");
  return { ok: true, url: url.toString(), host: domain, flags };
}

export function isPrivateIPv4(ip: string): boolean {
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata (169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast + reserved + broadcast
  );
}
