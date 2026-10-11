import { createHash } from "node:crypto";
import type { Env } from "../../config/env.js";
import type { Feed } from "../../config/feeds.js";
import { TtlCache } from "../../cache/ttl-cache.js";
import { toVeyraError } from "../../core/errors.js";
import { Cooldowns } from "../../core/guards.js";
import { httpRequest } from "../../core/http.js";
import { checkUrl } from "../../security/url-guard.js";
import { normalizeUrl } from "../../sources/collector.js";
import { FeedParseError, parseFeed } from "./parser.js";

export interface Article {
  id: string;
  title: string;
  url: string;
  /** Publisher for citations (feed.source ?? feed.name). */
  source: string;
  feed: string;
  category: string;
  author?: string;
  publishedAt?: string;
  /** When VEYRA fetched the feed this came from. */
  retrievedAt: string;
  description?: string;
  content?: string;
  tags: string[];
}

export interface FeedReport {
  feed: string;
  url: string;
  status: "fresh" | "cached" | "stale" | "failed";
  articles: number;
  error?: string;
}

interface FeedState {
  articles: Article[];
  fetchedAt: number;
  etag?: string;
  lastModified?: string;
}

/**
 * The RSS corpus. Each feed is fetched at most once per RSS_REFRESH_MINUTES
 * (conditional requests: ETag / Last-Modified → 304), parsed once, and kept in
 * the shared TTL cache. A failing feed is skipped, keeps serving its last good
 * copy (marked stale), and is not retried until a backoff expires — one broken
 * feed never breaks a request.
 */
export class NewsStore {
  private readonly inflight = new Map<string, Promise<FeedState>>();
  private readonly backoff = new Cooldowns();
  private readonly lastError = new Map<string, string>();

  constructor(
    private readonly env: Env,
    // Last good copy is kept for a day so it can be served stale while a feed is down.
    private readonly cache = new TtlCache<FeedState>(1000),
  ) {}

  async collect(feeds: Feed[], signal: AbortSignal, now = Date.now()): Promise<{ articles: Article[]; reports: FeedReport[] }> {
    const refreshMs = this.env.RSS_REFRESH_MINUTES * 60_000;
    const results = await mapLimit(feeds, 6, async (feed): Promise<{ articles: Article[]; report: FeedReport }> => {
      const state = this.cache.get(feed.url);
      const base = { feed: feed.name, url: feed.url };
      if (state && now - state.fetchedAt < refreshMs) {
        return { articles: state.articles, report: { ...base, status: "cached", articles: state.articles.length } };
      }
      if (this.backoff.isCooling(feed.url)) {
        const error = `backing off after failure: ${this.lastError.get(feed.url) ?? "error"}`;
        return state
          ? { articles: state.articles, report: { ...base, status: "stale", articles: state.articles.length, error } }
          : { articles: [], report: { ...base, status: "failed", articles: 0, error } };
      }
      try {
        const fresh = await this.refresh(feed, state, signal);
        return { articles: fresh.articles, report: { ...base, status: "fresh", articles: fresh.articles.length } };
      } catch (err) {
        const e = toVeyraError(err, `rss:${feed.name}`);
        if (e.kind === "aborted") throw e;
        const message = err instanceof FeedParseError ? err.message : `${e.kind}: ${e.message}`.slice(0, 200);
        this.lastError.set(feed.url, message);
        this.backoff.mark(feed.url, this.env.RSS_FAILURE_BACKOFF_MINUTES * 60_000);
        return state
          ? { articles: state.articles, report: { ...base, status: "stale", articles: state.articles.length, error: message } }
          : { articles: [], report: { ...base, status: "failed", articles: 0, error: message } };
      }
    });
    return { articles: results.flatMap((r) => r.articles), reports: results.map((r) => r.report) };
  }

  private refresh(feed: Feed, previous: FeedState | undefined, signal: AbortSignal): Promise<FeedState> {
    let p = this.inflight.get(feed.url);
    if (!p) {
      p = this.fetchFeed(feed, previous, signal).finally(() => this.inflight.delete(feed.url));
      this.inflight.set(feed.url, p);
    }
    return p;
  }

  private async fetchFeed(feed: Feed, previous: FeedState | undefined, signal: AbortSignal): Promise<FeedState> {
    const res = await httpRequest(feed.url, {
      source: `rss:${feed.name}`,
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
        "User-Agent": "TILIK-news-reader/0.1 (+RSS aggregator)",
        ...(previous?.etag ? { "If-None-Match": previous.etag } : {}),
        ...(previous?.lastModified ? { "If-Modified-Since": previous.lastModified } : {}),
      },
      timeoutMs: this.env.RSS_TIMEOUT_MS,
      signal,
      acceptStatus: [304],
    });
    const fetchedAt = Date.now();
    const etag = res.headers.get("etag") ?? previous?.etag;
    const lastModified = res.headers.get("last-modified") ?? previous?.lastModified;
    if (res.status === 304 && previous) {
      const state = { ...previous, fetchedAt };
      this.cache.set(feed.url, state, 24 * 3_600_000);
      return state;
    }

    const body = await readCapped(res, this.env.RSS_MAX_FEED_BYTES);
    const parsed = parseFeed(body, { baseUrl: feed.url, maxItems: this.env.RSS_MAX_ITEMS_PER_FEED });
    const retrievedAt = new Date(fetchedAt).toISOString();
    const articles: Article[] = [];
    for (const item of parsed.items) {
      if (!checkUrl(item.url).ok) continue; // never cite internal/odd URLs from a feed
      articles.push({
        id: createHash("sha1").update(normalizeUrl(item.url) ?? item.url).digest("hex").slice(0, 16),
        title: item.title.slice(0, 300),
        url: item.url,
        source: feed.source ?? feed.name,
        feed: feed.name,
        category: feed.category,
        ...(item.author ? { author: item.author.slice(0, 120) } : {}),
        ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
        retrievedAt,
        ...(item.description ? { description: item.description.slice(0, 1500) } : {}),
        ...(item.content ? { content: item.content.slice(0, 6000) } : {}),
        tags: item.categories.slice(0, 10),
      });
    }
    const state: FeedState = { articles, fetchedAt, ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) };
    this.cache.set(feed.url, state, 24 * 3_600_000);
    return state;
  }
}

/** Reads at most maxBytes (a huge or endless feed can't exhaust memory), honouring the declared charset. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body) {
    const reader = res.body.getReader();
    try {
      while (size < maxBytes) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  const bytes = new Uint8Array(Math.min(size, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, bytes.length - offset);
    bytes.set(c.subarray(0, take), offset);
    offset += take;
    if (offset >= bytes.length) break;
  }
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const charset =
    /charset=([\w-]+)/i.exec(res.headers.get("content-type") ?? "")?.[1] ?? /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}
