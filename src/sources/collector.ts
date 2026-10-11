import { sanitizeTitle, sanitizeUntrusted } from "../security/untrusted.js";
import { checkUrl } from "../security/url-guard.js";
import type { Source, SourceInput } from "./types.js";

const TRACKING_PARAMS = /^(utm_[a-z]+|ref|ref_src|fbclid|gclid|mc_cid|mc_eid)$/i;

/** Canonical form used for de-duplication. Returns undefined for non-http(s) or malformed URLs. */
export function normalizeUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

export interface CollectOptions {
  maxContextChars: number;
  /** Keep at most this many sources (highest relevance first). */
  maxSources?: number;
  /** Domains whose URLs are never shown or cited. */
  blockedDomains?: string[];
  now?: Date;
}

export interface CollectResult {
  sources: Source[];
  /** Raw results received from all tools. */
  resultsFound: number;
  /** Removed as same-URL or near-identical content. */
  duplicatesRemoved: number;
  /** Dropped by the maxSources cap. */
  droppedByLimit: number;
}

type Candidate = Omit<Source, "id">;

/**
 * Merges tool outputs into a numbered, de-duplicated source list that fits
 * the context budget. This is the single choke point every tool's output
 * passes through, so it is also where untrusted content is sanitized:
 *  0. titles/snippets/content are cleaned; prompt-injection text is redacted and flagged;
 *     URLs failing the safety policy are dropped (never "fixed")
 *  1. same canonical URL → one source
 *  2. near-identical content or identical long titles (syndicated copies) → one source
 * The strongest copy is kept; other tools that found it are listed in `alsoFoundBy`.
 */
export function collectSources(outputs: { provider: string; sources: SourceInput[] }[], opts: CollectOptions): CollectResult {
  const now = (opts.now ?? new Date()).toISOString();
  const byKey = new Map<string, Candidate>();
  let resultsFound = 0;

  for (const { provider, sources } of outputs) {
    for (const input of sources) {
      resultsFound++;
      const check = input.url ? checkUrl(input.url, { blockedDomains: opts.blockedDomains ?? [] }) : undefined;
      const safeUrl = check?.ok ? input.url : undefined;
      if (check && !check.ok && /blocked by configuration/.test(check.reason)) continue; // operator-blocked: drop entirely
      const canonical = safeUrl ? normalizeUrl(safeUrl) : undefined;
      const domain = canonical ? new URL(canonical).hostname : undefined;

      const title = sanitizeTitle(input.title, domain ?? "Untitled source");
      const snippet = input.snippet !== undefined ? sanitizeUntrusted(input.snippet) : undefined;
      const content = input.content !== undefined ? sanitizeUntrusted(input.content, { mode: input.format ?? "text" }) : undefined;
      const flags = new Set([...title.flags, ...(snippet?.flags ?? []), ...(content?.flags ?? []), ...(check?.ok ? check.flags : [])]);

      const { url: _u, title: _t, snippet: _s, content: _c, ...rest } = input;
      const candidate: Candidate = {
        ...rest,
        title: title.text,
        ...(snippet?.text ? { snippet: snippet.text } : {}),
        ...(content?.text ? { content: content.text } : {}),
        ...(canonical && safeUrl ? { url: safeUrl, domain: domain! } : {}),
        ...(flags.size ? { securityFlags: [...flags].sort() } : {}),
        provider,
        retrievedAt: now,
      };
      const key = canonical ?? `title:${input.type}:${input.title.trim().toLowerCase()}`;
      const existing = byKey.get(key);
      byKey.set(key, existing ? merge(existing, candidate) : candidate);
    }
  }

  // Near-duplicate pass (O(n²), n is small: tens of results at most).
  const kept: { source: Candidate; shingles: Set<string> }[] = [];
  for (const source of [...byKey.values()].sort((a, b) => score(b) - score(a))) {
    const shingles = shingleSet(source.content ?? source.snippet ?? "");
    const dup = kept.find((k) => sameTitle(k.source, source) || jaccard(k.shingles, shingles) >= 0.6);
    if (dup) dup.source = merge(dup.source, source);
    else kept.push({ source, shingles });
  }
  const duplicatesRemoved = resultsFound - kept.length;

  const ranked = kept.map((k) => k.source).sort((a, b) => (b.relevance ?? 0.5) - (a.relevance ?? 0.5));
  const limited = opts.maxSources ? ranked.slice(0, opts.maxSources) : ranked;
  const allowance = allocate(
    limited.map((s) => s.content?.length ?? Math.min(s.snippet?.length ?? 0, 500)),
    opts.maxContextChars,
  );
  const sources = limited.map((s, i) => {
    const content = s.content ? truncate(s.content, Math.max(400, allowance[i] ?? 0), s.format === "code") : undefined;
    const { content: _full, snippet, ...meta } = s;
    return {
      id: i + 1,
      ...meta,
      ...(snippet ? { snippet: truncate(snippet, 500) } : {}),
      ...(content ? { content } : {}),
    };
  });

  return { sources, resultsFound, duplicatesRemoved, droppedByLimit: ranked.length - limited.length };
}

/** Keeps the stronger copy and remembers which other tools found it. */
function merge(a: Candidate, b: Candidate): Candidate {
  const [winner, loser] = score(b) > score(a) ? [b, a] : [a, b];
  const others = new Set([...(winner.alsoFoundBy ?? []), ...(loser.alsoFoundBy ?? []), loser.provider]);
  others.delete(winner.provider);
  const flags = new Set([...(winner.securityFlags ?? []), ...(loser.securityFlags ?? [])]);
  // A full article that replaces its RSS story entry keeps the story's coverage list (all outlets' URLs).
  const keepListing =
    loser.type === "news" && loser.content && winner.evidence === "retrieved_content" && !winner.content?.includes(loser.content.slice(0, 120));
  return {
    ...winner,
    ...(keepListing ? { content: `${winner.content ?? ""}\n\n[News feed listing for this story]\n${loser.content}` } : {}),
    ...(flags.size ? { securityFlags: [...flags].sort() } : {}),
    // Keep the earliest-known publication date if the winner lacks one.
    ...(winner.publishedAt || !loser.publishedAt ? {} : { publishedAt: loser.publishedAt }),
    ...(others.size ? { alsoFoundBy: [...others].sort() } : {}),
  };
}

function score(s: Candidate): number {
  const text = s.content?.length ?? s.snippet?.length ?? 0;
  const retrieved = s.evidence === "retrieved_content" ? 1 : 0;
  return (s.relevance ?? 0.5) * 10 + Math.min(text, 5000) / 1000 + retrieved;
}

function sameTitle(a: Candidate, b: Candidate): boolean {
  const ta = a.title.trim().toLowerCase();
  return ta.length >= 25 && ta === b.title.trim().toLowerCase();
}

function shingleSet(text: string, size = 4): Set<string> {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 300);
  const set = new Set<string>();
  if (words.length < 12) return set; // too short to judge similarity
  for (let i = 0; i + size <= words.length; i++) set.add(words.slice(i, i + size).join(" "));
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Water-filling budget split: short sources keep all their text, and what
 * they don't use is shared among longer ones (a 500-char metadata block no
 * longer wastes the same share as a 20k-char README).
 */
export function allocate(lengths: number[], budget: number): number[] {
  const out = new Array<number>(lengths.length).fill(0);
  let remaining = budget;
  let open = lengths.map((len, i) => ({ len, i })).sort((a, b) => a.len - b.len);
  while (open.length && remaining > 0) {
    const share = Math.floor(remaining / open.length);
    const first = open[0]!;
    if (first.len <= share) {
      out[first.i] = first.len;
      remaining -= first.len;
      open = open.slice(1);
    } else {
      for (const o of open) out[o.i] = share;
      break;
    }
  }
  return out;
}

function truncate(text: string, max: number, code = false): string {
  const clean = code ? text : text.replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}
