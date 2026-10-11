import type { Feed } from "../../config/feeds.js";
import { normalizeUrl } from "../../sources/collector.js";
import type { Article } from "./store.js";

/**
 * News search over the RSS corpus: deterministic interpretation of the
 * question (no LLM), freshness filtering, relevance scoring, duplicate removal
 * and lightweight story clustering (token overlap — no vectors).
 */

export type NewsMode =
  /** "biggest stories today", "headlines", "what happened in the last 6 hours" — rank by recency × coverage. */
  | "digest"
  /** "what's happening with X" — RSS plus a web search for coverage. */
  | "coverage"
  /** "latest news about X" — RSS first, web search only if RSS finds too little. */
  | "lookup";

export interface NewsQuery {
  mode: NewsMode;
  /** Subject words that must match (title/description). Empty for digests. */
  terms: string[];
  /** Multi-word subjects matched as phrases ("robinhood chain"). */
  phrases: string[];
  categories: string[];
  maxAgeHours: number;
  maxStories: number;
}

export interface StorySource {
  title: string;
  url: string;
  source: string;
  publishedAt?: string;
  author?: string;
}

export interface Story {
  id: string;
  title: string;
  summary: string;
  /** Earliest publication among the story's articles. */
  publishedAt?: string;
  /** Latest publication among the story's articles. */
  updatedAt?: string;
  ageHours?: number;
  category: string;
  /** 0..1 */
  relevance: number;
  sources: StorySource[];
  /** Longest article text available (for the model), when the feed carried full content. */
  content?: string;
}

export interface SearchResult {
  stories: Story[];
  considered: number;
  inWindow: number;
  matched: number;
  excludedOld: number;
  excludedUndated: number;
  duplicatesMerged: number;
}

// ── Question interpretation ─────────────────────────────────────────────────

export const CATEGORY_KEYWORDS: Record<string, RegExp> = {
  ai: /\b(ai|a\.i\.|artificial intelligence|machine learning|llms?|openai|anthropic|chatgpt|claude|gemini|deepmind|mistral|gpt-?\d*|generative)\b/i,
  crypto: /\b(crypto\w*|bitcoin|btc|ethereum|eth|blockchain|on-?chain|defi|web3|stablecoins?|tokeni[sz]\w*|robinhood chain|solana|nfts?|layer[- ]?2|l2s?|rollups?)\b/i,
  finance: /\b(stocks?|equit(y|ies)|markets?|finance|financial|economy|economic|fed|inflation|earnings|nasdaq|s&p|ipos?|banks?|banking|robinhood|interest rates?)\b/i,
  technology: /\b(tech|technology|apple|google|microsoft|meta|amazon|startups?|gadgets?|smartphones?|chips?|semiconductors?|silicon valley)\b/i,
  developer: /\b(developers?|programming|open[- ]source|github|javascript|typescript|python|rust|golang|devops|frameworks?|kubernetes|software engineering)\b/i,
  general: /\b(world|politics|global|international|government|elections?)\b/i,
};

/** Words that name a category itself (as opposed to a specific subject within it). */
const CATEGORY_NAMES: Record<string, string[]> = {
  ai: ["ai", "a.i", "artificial", "intelligence", "genai", "generative"],
  crypto: ["crypto", "cryptocurrency", "blockchain", "web3", "defi"],
  finance: ["finance", "financial", "markets", "market", "economy", "business"],
  technology: ["tech", "technology"],
  developer: ["developer", "developers", "programming", "dev", "software"],
  general: ["world", "politics", "global", "international"],
};

const NEWS_WORDS = new Set(
  "news latest recent recently today todays tonight yesterday week weeks month months hour hours day days past last biggest big top major main important stories story headlines headline breaking happened happening going on update updates developments development what whats is are was were the a an in on of for about with to and or any me show find tell give get there have has been this that these those right now just currently current new newest around regarding from at by it its do does did how why who which can could would please summary summarize so far".split(
    " ",
  ),
);

const DIGEST = /\b(biggest|top|major|main|important|key)\s+(\w+\s+)?(stories|news|headlines|developments)\b|\bheadlines\b|\b(today'?s|this morning'?s|tonight'?s)\s+(\w+\s+)?(news|stories)\b|\bwhat happened (in|over) the (last|past)\b|^(find|show|give|list)( me)?\b.{0,40}\bnews\b|\bnews (digest|roundup|summary)\b/i;
const COVERAGE = /\bwhat('?s| is| has been)? (happening|happened|going on)\b|\bwhat'?s new (with|in)\b/i;

export function planNewsQuery(question: string, defaults: { maxAgeHours: number; maxStories: number }): NewsQuery {
  const q = question.replace(/https?:\/\/\S+/g, " ");
  const categories = Object.entries(CATEGORY_KEYWORDS)
    .filter(([, re]) => re.test(q))
    .map(([c]) => c);

  const phrases = [...q.matchAll(/\b(robinhood chain|tokeni[sz]ed (assets|stocks|equities)|artificial intelligence|open source|interest rates?|layer 2)\b/gi)].map((m) =>
    m[0].toLowerCase(),
  );
  const terms = [
    ...new Set(
      q
        .toLowerCase()
        .replace(/[’']s\b/g, "")
        .split(/[^a-z0-9.&+-]+/)
        .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
        .filter((w) => w.length >= 2 && !NEWS_WORDS.has(w) && !/^\d+$/.test(w)),
    ),
  ];

  // Digest = asks for "the news" generally; subject words limited to category names.
  const categoryOnly = terms.every((t) => Object.values(CATEGORY_NAMES).some((names) => names.includes(t)));
  const mode: NewsMode = DIGEST.test(q) && categoryOnly ? "digest" : COVERAGE.test(q) ? "coverage" : terms.length === 0 ? "digest" : "lookup";

  return {
    mode,
    terms: mode === "digest" ? [] : terms,
    phrases,
    categories,
    maxAgeHours: freshnessWindow(q, defaults.maxAgeHours),
    maxStories: defaults.maxStories,
  };
}

/** "last 6 hours" → 6, "today" → 24, "this week" → 168, "breaking" → 6. Default from NEWS_MAX_AGE_HOURS. */
export function freshnessWindow(q: string, fallback: number): number {
  const n = /\b(?:last|past)\s+(\d{1,3})\s*(hours?|hrs?|h|days?|d|weeks?)\b/i.exec(q);
  if (n) {
    const v = Number(n[1]);
    const unit = n[2]!.toLowerCase();
    return Math.max(1, unit.startsWith("h") ? v : unit.startsWith("w") ? v * 168 : v * 24);
  }
  if (/\b(breaking|right now|just now|this hour)\b/i.test(q)) return 6;
  if (/\b(this morning|tonight)\b/i.test(q)) return 12;
  if (/\b(today|todays|today'?s)\b/i.test(q)) return 24;
  if (/\byesterday\b/i.test(q)) return 48;
  if (/\b(this|past|last) week\b/i.test(q)) return 168;
  if (/\b(this|past|last) month\b/i.test(q)) return 720;
  return fallback;
}

/** Feeds for the question's categories (all enabled feeds when none detected), capped. */
export function selectFeeds(feeds: Feed[], categories: string[], max: number): Feed[] {
  const enabled = feeds.filter((f) => f.enabled);
  const wanted = categories.length ? enabled.filter((f) => categories.includes(f.category)) : enabled;
  return (wanted.length ? wanted : enabled).slice(0, max);
}

// ── Search, dedupe, clustering ──────────────────────────────────────────────

export function searchNews(articles: Article[], q: NewsQuery, now = Date.now()): SearchResult {
  const cutoff = now - q.maxAgeHours * 3_600_000;
  let excludedOld = 0;
  let excludedUndated = 0;

  // 1. Freshness: undated articles are never presented as recent.
  const inWindow = articles.filter((a) => {
    if (!a.publishedAt) {
      excludedUndated++;
      return false;
    }
    if (Date.parse(a.publishedAt) < cutoff) {
      excludedOld++;
      return false;
    }
    return true;
  });

  // 2. Exact duplicates (same canonical URL from several feeds) → one article.
  const byUrl = new Map<string, Article>();
  for (const a of inWindow) {
    const key = normalizeUrl(a.url) ?? a.url;
    const prev = byUrl.get(key);
    if (!prev || (a.content?.length ?? 0) > (prev.content?.length ?? 0)) byUrl.set(key, a);
  }
  const unique = [...byUrl.values()];

  // 3. Relevance.
  const scored = unique
    .map((a) => ({ a, score: scoreArticle(a, q, now) }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score);

  // 4. Story clustering: same normalized title, or similar title tokens.
  const clusters: { articles: { a: Article; score: number }[]; tokens: Set<string> }[] = [];
  for (const item of scored) {
    const tokens = titleTokens(item.a.title);
    const match = clusters.find((c) => sameStory(c.tokens, tokens, c.articles[0]!.a.title, item.a.title));
    if (match) {
      match.articles.push(item);
      for (const t of tokens) match.tokens.add(t);
    } else clusters.push({ articles: [item], tokens: new Set(tokens) });
  }

  const maxScore = scored[0]?.score ?? 1;
  const stories = clusters
    .map((c) => toStory(c.articles, maxScore, now, q.mode))
    // Digest: stories covered by more outlets rank higher.
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, q.maxStories);

  return {
    stories,
    considered: articles.length,
    inWindow: inWindow.length,
    matched: scored.length,
    excludedOld,
    excludedUndated,
    duplicatesMerged: inWindow.length - unique.length + (scored.length - clusters.length),
  };
}

function scoreArticle(a: Article, q: NewsQuery, now: number): number {
  const title = a.title.toLowerCase();
  const body = `${a.description ?? ""} ${a.tags.join(" ")}`.toLowerCase();
  let match = 0;
  for (const p of q.phrases) {
    if (title.includes(p)) match += 6;
    else if (body.includes(p)) match += 2;
  }
  for (const t of q.terms) {
    const re = new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
    if (re.test(title)) match += 3;
    else if (re.test(body)) match += 1;
    else {
      // A category *name* ("AI", "crypto", "tech") matches articles from that category's feeds
      // or mentioning its keywords ("OpenAI", "Claude", "GPT-6" for AI). Specific subjects
      // ("OpenAI") must match literally — "LLM" in a title isn't news about OpenAI.
      const cats = Object.entries(CATEGORY_NAMES).filter(([, names]) => names.includes(t)).map(([c]) => c);
      if (cats.some((c) => CATEGORY_KEYWORDS[c]!.test(title))) match += 2;
      else if (cats.includes(a.category)) match += 1;
    }
  }
  if (q.mode !== "digest" && match === 0) return 0;
  // Category fit; for digests every article in the selected feeds qualifies.
  const categoryFit = q.categories.length === 0 || q.categories.includes(a.category) ? 1 : q.mode === "digest" ? 0 : 0.5;
  if (q.mode === "digest" && categoryFit === 0) return 0;
  const ageH = (now - Date.parse(a.publishedAt!)) / 3_600_000;
  const recency = 1 / (1 + ageH / 12);
  return (match + 1) * (0.5 + categoryFit) * (0.4 + recency);
}

const SYNONYMS: Record<string, string> = {
  stocks: "equity", stock: "equity", equities: "equity", shares: "equity",
  tokenised: "tokeniz", tokenized: "tokeniz", tokenization: "tokeniz", tokenisation: "tokeniz", tokenizes: "tokeniz", tokenize: "tokeniz",
  onchain: "onchain", "on-chain": "onchain", cryptocurrency: "crypto", cryptocurrencies: "crypto",
  launches: "launch", launched: "launch", launching: "launch", unveils: "launch", unveiled: "launch", debuts: "launch",
  acquires: "acquire", acquired: "acquire", acquisition: "acquire", buys: "acquire",
  raises: "raise", raised: "raise", funding: "raise",
};
const TITLE_STOP = new Set(
  "a an the and or of to in on for with at by from as is are was were be its it this that new says say said after over into amid how why what will could may can just more".split(" "),
);

export function titleTokens(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .replace(/[’']s\b/g, "")
        .split(/[^a-z0-9-]+/)
        .map((w) => w.replace(/^-+|-+$/g, ""))
        .filter((w) => w.length >= 2 && !TITLE_STOP.has(w))
        .map((w) => SYNONYMS[w] ?? w.replace(/(ing|ed|es|s)$/, (s, _m, i: number) => (i >= 4 ? "" : s))),
    ),
  ];
}

function sameStory(cluster: Set<string>, tokens: string[], titleA: string, titleB: string): boolean {
  if (normalizeTitle(titleA) === normalizeTitle(titleB)) return true;
  if (tokens.length === 0) return false;
  let shared = 0;
  for (const t of tokens) if (cluster.has(t)) shared++;
  const jaccard = shared / (cluster.size + tokens.length - shared);
  return jaccard >= 0.5 || (shared >= 3 && jaccard >= 0.3);
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function toStory(items: { a: Article; score: number }[], maxScore: number, now: number, mode: NewsMode): Story {
  const lead = items[0]!.a; // highest-scoring article names the story
  const dated = items.map((i) => i.a.publishedAt!).sort();
  const outlets = new Set(items.map((i) => i.a.source)).size;
  const best = Math.max(...items.map((i) => i.score));
  // "Biggest stories": how many outlets cover it matters as much as recency.
  const coverage = mode === "digest" ? 0.5 * Math.min(1, (outlets - 1) / 2) : Math.min(0.2, (outlets - 1) * 0.07);
  const relevance = Math.min(1, (best / maxScore) * (mode === "digest" ? 0.5 : 0.8) + coverage);
  const richest = items.map((i) => i.a).sort((x, y) => (y.content?.length ?? 0) - (x.content?.length ?? 0))[0]!;
  return {
    id: lead.id,
    title: lead.title,
    summary: (lead.description ?? richest.description ?? "").slice(0, 600),
    ...(dated[0] ? { publishedAt: dated[0], ageHours: Math.round(((now - Date.parse(dated[0])) / 3_600_000) * 10) / 10 } : {}),
    ...(dated.at(-1) ? { updatedAt: dated.at(-1) } : {}),
    category: lead.category,
    relevance: Math.round(relevance * 1000) / 1000,
    sources: items.map(({ a }) => ({
      title: a.title,
      url: a.url,
      source: a.source,
      ...(a.publishedAt ? { publishedAt: a.publishedAt } : {}),
      ...(a.author ? { author: a.author } : {}),
    })),
    ...(richest.content ? { content: richest.content } : {}),
  };
}
