import { allocate, collectSources } from "../sources/collector.js";
import type { Source } from "../sources/types.js";
import { familyOfCapability, type Family } from "../router/unified.js";
import type { ToolOutput } from "../tools/runner.js";

/**
 * The context layer between retrieval and reasoning. The model receives a
 * small, high-quality, citable context — never raw API dumps:
 *  1. sanitize + de-duplicate (collector),
 *  2. rank by relevance × authority × freshness,
 *  3. keep at least the best source of every kind of data present (diversity),
 *  4. fit the source-count and character budgets, preserving the head of each
 *     source (where facts and metadata live) and all source metadata.
 */

export type Authority = "direct" | "official" | "reputable" | "general";

const AUTHORITY_SCORE: Record<Authority, number> = { direct: 1, official: 0.9, reputable: 0.75, general: 0.55 };

/** Widely-cited publishers; extend with VEYRA_TRUSTED_DOMAINS. Not a guarantee of accuracy — a ranking signal. */
const REPUTABLE = [
  "reuters.com", "apnews.com", "bloomberg.com", "ft.com", "wsj.com", "nytimes.com", "bbc.co.uk", "bbc.com", "theguardian.com", "npr.org",
  "economist.com", "cnbc.com", "techcrunch.com", "theverge.com", "arstechnica.com", "wired.com", "coindesk.com", "theblock.co",
  "decrypt.co", "arxiv.org", "nature.com", "github.blog", "openai.com", "anthropic.com", "blog.google", "ethereum.org", "docs.robinhood.com",
];

export interface ContextOptions {
  maxSources: number;
  maxContextChars: number;
  blockedDomains: string[];
  /** News/market/chain questions: newer sources rank higher. */
  timeSensitive: boolean;
  trustedDomains?: string[];
  now?: number;
}

export interface BuiltContext {
  sources: (Source & { authority: Authority; family: Family })[];
  stats: {
    resultsFound: number;
    duplicatesRemoved: number;
    droppedByLimit: number;
    sourcesUsed: number;
    byFamily: Partial<Record<Family, number>>;
  };
}

export function buildContext(outputs: ToolOutput[], opts: ContextOptions): BuiltContext {
  const now = opts.now ?? Date.now();
  // 1. Sanitize + dedupe everything (no budget yet).
  const collected = collectSources(
    outputs.map((o) => ({ provider: o.tool, sources: o.sources })),
    { maxContextChars: Number.MAX_SAFE_INTEGER, blockedDomains: opts.blockedDomains },
  );

  const familyByTool = new Map(outputs.map((o) => [o.tool, familyOfCapability(o.capability)]));
  // A project's own site (a repository's declared homepage) counts as official. Only GitHub's `related`
  // means "official site" — other tools use `related` for "worth reading in full" (e.g. RSS stories).
  const officialHosts = new Set(
    outputs
      .filter((o) => o.capability === "github.repo")
      .flatMap((o) => o.related ?? [])
      .map((u) => {
        try {
          return new URL(u).hostname.replace(/^www\./, "");
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  );
  const reputable = [...REPUTABLE, ...(opts.trustedDomains ?? [])];

  // 2. Rank.
  const ranked = collected.sources.map((s) => {
    const family = familyByTool.get(s.provider) ?? "web";
    const authority = authorityOf(s, family, officialHosts, reputable);
    const age = s.publishedAt ? (now - Date.parse(s.publishedAt)) / 3_600_000 : undefined;
    const freshness = !opts.timeSensitive ? 1 : age === undefined ? 0.5 : 1 / (1 + Math.max(0, age) / 24);
    const score = 0.55 * (s.relevance ?? 0.5) + 0.3 * AUTHORITY_SCORE[authority] + 0.15 * freshness;
    return { s, family, authority, score };
  });
  ranked.sort((a, b) => b.score - a.score);

  // 3. Diversity first (best of each family), then fill by score.
  const chosen = new Set<(typeof ranked)[number]>();
  for (const fam of new Set(ranked.map((r) => r.family))) {
    const best = ranked.find((r) => r.family === fam);
    if (best && chosen.size < opts.maxSources) chosen.add(best);
  }
  for (const r of ranked) {
    if (chosen.size >= opts.maxSources) break;
    chosen.add(r);
  }
  const selected = ranked.filter((r) => chosen.has(r));

  // 4. Budget: short sources keep everything, long ones share the rest; renumber citations.
  const allowance = allocate(
    selected.map((r) => r.s.content?.length ?? 0),
    opts.maxContextChars,
  );
  const sources = selected.map((r, i) => {
    const max = Math.max(400, allowance[i] ?? 0);
    const content = r.s.content && r.s.content.length > max ? `${r.s.content.slice(0, max - 1)}…` : r.s.content;
    const { content: _c, ...meta } = r.s;
    return { ...meta, id: i + 1, authority: r.authority, family: r.family, ...(content ? { content } : {}) };
  });

  const byFamily: Partial<Record<Family, number>> = {};
  for (const s of sources) byFamily[s.family] = (byFamily[s.family] ?? 0) + 1;
  return {
    sources,
    stats: {
      resultsFound: collected.resultsFound,
      duplicatesRemoved: collected.duplicatesRemoved,
      droppedByLimit: collected.sources.length - sources.length,
      sourcesUsed: sources.length,
      byFamily,
    },
  };
}

function authorityOf(s: Source, family: Family, officialHosts: Set<string>, reputable: string[]): Authority {
  if (family === "onchain" || family === "market") return "direct";
  if (family === "github") return "official";
  const host = s.domain ?? "";
  if (s.type === "documentation" || officialHosts.has(host)) return "official";
  if (reputable.some((d) => host === d || host.endsWith(`.${d}`))) return "reputable";
  return "general";
}
