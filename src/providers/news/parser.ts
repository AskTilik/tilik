/**
 * Small, dependency-free RSS 2.0 / RSS 1.0 (RDF) / Atom parser.
 * Tolerant by design: a truncated or slightly malformed feed yields whatever
 * items can be read; a document that isn't a feed at all throws.
 * No DTDs or custom entities are processed (no XXE / entity-expansion risk).
 */

export interface ParsedItem {
  title: string;
  url: string;
  author?: string;
  publishedAt?: string;
  /** Plain text (HTML stripped). */
  description?: string;
  /** Plain text of full content (content:encoded / atom content), when present. */
  content?: string;
  categories: string[];
}

export interface ParsedFeed {
  kind: "rss" | "atom" | "rdf";
  title?: string;
  items: ParsedItem[];
  /** Items skipped (no title or no valid link). */
  skipped: number;
}

export class FeedParseError extends Error {}

export function parseFeed(input: string, opts: { baseUrl: string; maxItems?: number; now?: number }): ParsedFeed {
  const xml = input
    .replace(/^﻿/, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const kind = /<rss[\s>]/i.test(xml) ? "rss" : /<feed[\s>]/i.test(xml) ? "atom" : /<rdf:RDF[\s>]/i.test(xml) ? "rdf" : undefined;
  if (!kind) {
    throw new FeedParseError(/<html[\s>]/i.test(xml) ? "URL returned an HTML page, not a feed" : "Not an RSS or Atom feed");
  }

  const itemTag = kind === "atom" ? "entry" : "item";
  const firstItem = xml.search(new RegExp(`<${itemTag}[\\s>]`, "i"));
  const head = firstItem >= 0 ? xml.slice(0, firstItem) : xml;
  const title = text(tag(head, "title"));

  const items: ParsedItem[] = [];
  let skipped = 0;
  const max = opts.maxItems ?? 50;
  const now = opts.now ?? Date.now();
  for (const m of xml.matchAll(new RegExp(`<${itemTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${itemTag}>`, "gi"))) {
    if (items.length >= max) break;
    const block = m[1]!;
    const item = kind === "atom" ? atomItem(block, opts.baseUrl, now) : rssItem(block, opts.baseUrl, now);
    if (item) items.push(item);
    else skipped++;
  }
  return { kind, ...(title ? { title } : {}), items, skipped };
}

function rssItem(block: string, base: string, now: number): ParsedItem | undefined {
  const title = text(tag(block, "title"));
  const guid = tag(block, "guid");
  const guidIsLink = guid !== undefined && !/isPermaLink\s*=\s*["']false/i.test(/<guid\b[^>]*>/i.exec(block)?.[0] ?? "");
  const link = text(tag(block, "feedburner:origLink")) || text(tag(block, "link")) || (guidIsLink ? text(guid) : "") || attr(block, "link", "href");
  const url = resolve(link, base);
  if (!title || !url) return undefined;
  const author = cleanAuthor(text(tag(block, "dc:creator")) || text(tag(block, "author")));
  const date = parseDate(text(tag(block, "pubDate")) || text(tag(block, "dc:date")) || text(tag(block, "published")) || text(tag(block, "updated")), now);
  const description = html(tag(block, "description"));
  const content = html(tag(block, "content:encoded"));
  return {
    title,
    url,
    ...(author ? { author } : {}),
    ...(date ? { publishedAt: date } : {}),
    ...(description ? { description } : {}),
    ...(content && content !== description ? { content } : {}),
    categories: allTags(block, "category").map(text).filter(Boolean),
  };
}

function atomItem(block: string, base: string, now: number): ParsedItem | undefined {
  const title = html(tag(block, "title"));
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => ({
    href: attrOf(m[1]!, "href"),
    rel: attrOf(m[1]!, "rel") ?? "alternate",
    type: attrOf(m[1]!, "type"),
  }));
  const link = links.find((l) => l.rel === "alternate" && (!l.type || l.type.includes("html")))?.href ?? links.find((l) => l.rel === "alternate")?.href ?? links[0]?.href;
  const url = resolve(link ?? text(tag(block, "id")), base);
  if (!title || !url) return undefined;
  const author = text(tag(tag(block, "author") ?? "", "name"));
  const date = parseDate(text(tag(block, "published")) || text(tag(block, "updated")), now);
  const description = html(tag(block, "summary"));
  const content = html(tag(block, "content"));
  return {
    title,
    url,
    ...(author ? { author } : {}),
    ...(date ? { publishedAt: date } : {}),
    ...(description ? { description } : {}),
    ...(content && content !== description ? { content } : {}),
    categories: [...block.matchAll(/<category\b([^>]*)\/?>/gi)].map((m) => attrOf(m[1]!, "term") ?? "").filter(Boolean),
  };
}

// ── XML helpers ────────────────────────────────────────────────────────────

function esc(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Inner XML of the first <name>…</name> (namespace prefix included in name, e.g. "dc:creator"). */
function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${esc(name)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${esc(name)}>`, "i").exec(block);
  return m?.[1];
}

function allTags(block: string, name: string): string[] {
  return [...block.matchAll(new RegExp(`<${esc(name)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${esc(name)}>`, "gi"))].map((m) => m[1]!);
}

function attr(block: string, name: string, attribute: string): string | undefined {
  const m = new RegExp(`<${esc(name)}\\b([^>]*)\\/?>`, "i").exec(block);
  return m ? attrOf(m[1]!, attribute) : undefined;
}

function attrOf(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${esc(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return m ? decode(m[2] ?? m[3] ?? "") : undefined;
}

function uncdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)(\]\]>|$)/g, "$1");
}

/** Text content of an element that should contain plain text. */
function text(s: string | undefined): string {
  if (s === undefined) return "";
  return decode(uncdata(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Element content that may be (escaped) HTML → plain text. */
function html(s: string | undefined): string {
  if (s === undefined) return "";
  let h = uncdata(s);
  if (!/<[a-z!/]/i.test(h) && /&lt;/i.test(h)) h = decode(h); // entity-escaped HTML
  return decode(
    h
      .replace(/<(script|style|iframe|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/blockquote)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·",
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function resolve(link: string | undefined, base: string): string | undefined {
  if (!link) return undefined;
  try {
    const u = new URL(link.trim(), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** ISO-8601 or RFC-822. Unparseable or implausibly future dates → undefined (unknown age, never "fresh"). */
export function parseDate(raw: string, now = Date.now()): string | undefined {
  if (!raw) return undefined;
  let t = Date.parse(raw);
  if (Number.isNaN(t)) t = Date.parse(raw.replace(/^[A-Za-z]{3},?\s*/, "").replace(/\s+(UT|Z)$/i, " GMT"));
  if (Number.isNaN(t) || t > now + 3_600_000) return undefined;
  return new Date(t).toISOString();
}

function cleanAuthor(a: string): string {
  // "editor@site.com (Jane Doe)" → "Jane Doe"
  const m = /\(([^)]+)\)\s*$/.exec(a);
  return (m ? m[1]! : a).replace(/\S+@\S+/, "").trim();
}
