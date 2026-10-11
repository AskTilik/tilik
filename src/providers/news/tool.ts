import { z } from "zod";
import type { Env } from "../../config/env.js";
import { loadFeeds, type Feed } from "../../config/feeds.js";
import { VeyraError } from "../../core/errors.js";
import type { SourceInput } from "../../sources/types.js";
import type { Tool, ToolResult } from "../../tools/types.js";
import { planNewsQuery, searchNews, selectFeeds, type NewsQuery, type Story } from "./search.js";
import { NewsStore, type FeedReport } from "./store.js";

export const NewsInputSchema = z.object({
  mode: z.enum(["digest", "coverage", "lookup"]),
  terms: z.array(z.string().max(60)).max(30),
  phrases: z.array(z.string().max(80)).max(10),
  categories: z.array(z.string().max(40)).max(10),
  maxAgeHours: z.number().int().positive().max(24 * 90),
  maxStories: z.number().int().positive().max(50),
});

const StorySourceSchema = z.object({ title: z.string(), url: z.string(), source: z.string(), publishedAt: z.string().optional(), author: z.string().optional() });
export const NewsDataSchema = z.object({
  mode: z.enum(["digest", "coverage", "lookup"]),
  window: z.object({ maxAgeHours: z.number(), since: z.string() }),
  stories: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      summary: z.string(),
      publishedAt: z.string().optional(),
      updatedAt: z.string().optional(),
      ageHours: z.number().optional(),
      category: z.string(),
      relevance: z.number(),
      sources: z.array(StorySourceSchema),
    }),
  ),
  stats: z.object({
    articlesConsidered: z.number(),
    inWindow: z.number(),
    matched: z.number(),
    excludedOld: z.number(),
    excludedUndated: z.number(),
    duplicatesMerged: z.number(),
  }),
  feeds: z.array(z.object({ feed: z.string(), url: z.string(), status: z.string(), articles: z.number(), error: z.string().optional() })),
});
export type NewsData = z.infer<typeof NewsDataSchema>;

/**
 * RSS / news intelligence: the low-cost freshness layer. Searches a cached
 * corpus of configured feeds (see config/feeds.ts), returns de-duplicated,
 * clustered stories, and tells the engine when web search should complement it.
 */
export function createRssTool(env: Env, opts: { feeds?: Feed[]; store?: NewsStore } = {}): Tool<NewsQuery, NewsData> {
  const feeds = opts.feeds ?? loadFeeds(env).feeds;
  const store = opts.store ?? new NewsStore(env);

  return {
    name: "rss",
    description: "Searches recent articles from configured RSS/Atom news feeds; groups coverage of the same story.",
    capabilities: ["news.feed"],
    inputSchema: NewsInputSchema,
    outputSchema: NewsDataSchema,
    auth: { envKeys: ["RSS_FEEDS_FILE", "RSS_FEEDS", "RSS_FEEDS_JSON"] },
    rateLimit: { requestsPerMinute: 120 },
    costTier: "free",
    priority: 1,
    // The corpus itself refreshes per RSS_REFRESH_MINUTES; identical questions within a minute reuse the result.
    cacheTtlSeconds: 60,
    timeoutMs: env.RSS_TIMEOUT_MS + 4000,
    isConfigured: () => env.RSS_ENABLED && feeds.some((f) => f.enabled),
    planInput: (ctx) =>
      ctx.intents.includes("news") ? planNewsQuery(ctx.query, { maxAgeHours: env.NEWS_MAX_AGE_HOURS, maxStories: env.NEWS_MAX_STORIES }) : null,

    async execute(q, { signal }): Promise<ToolResult<NewsData>> {
      const now = Date.now();
      const selected = selectFeeds(feeds, q.categories, env.RSS_MAX_FEEDS_PER_REQUEST);
      const { articles, reports } = await store.collect(selected, signal, now);

      const usable = reports.filter((r) => r.status !== "failed");
      if (usable.length === 0) {
        // Every feed failed: let the router fall back to web search.
        throw new VeyraError("upstream", "tool:rss", `All ${reports.length} RSS feeds failed (${summarizeFailures(reports)})`);
      }

      const result = searchNews(articles, q, now);
      const since = new Date(now - q.maxAgeHours * 3_600_000).toISOString();
      const notices: string[] = [];
      const failed = reports.filter((r) => r.status === "failed");
      const stale = reports.filter((r) => r.status === "stale");
      if (failed.length) notices.push(`${failed.length} of ${reports.length} RSS feeds failed and were skipped: ${summarizeFailures(failed)}.`);
      if (stale.length) notices.push(`Using the last good copy of ${stale.map((r) => r.feed).join(", ")} (refresh failed).`);
      if (result.stories.length === 0) {
        notices.push(
          `No RSS stories matched within the last ${q.maxAgeHours}h${result.excludedOld ? ` (${result.excludedOld} older articles were excluded as not fresh)` : ""}.`,
        );
      }

      const sources = result.stories.map((s) => storySource(s, now));
      const citableUrls = result.stories.flatMap((s) => s.sources.map((x) => x.url));
      // Stories whose feed only carried a short blurb are worth reading in full (engine decides if/how many).
      const thin = result.stories.filter((s) => (s.content?.length ?? 0) < 800).map((s) => s.sources[0]!.url);
      const enough = result.stories.length >= env.NEWS_MIN_RSS_STORIES;

      return {
        data: {
          mode: q.mode,
          window: { maxAgeHours: q.maxAgeHours, since },
          stories: result.stories.map(({ content: _c, ...s }) => s),
          stats: {
            articlesConsidered: result.considered,
            inWindow: result.inWindow,
            matched: result.matched,
            excludedOld: result.excludedOld,
            excludedUndated: result.excludedUndated,
            duplicatesMerged: result.duplicatesMerged,
          },
          feeds: reports,
        },
        sources,
        notices,
        citableUrls,
        ...(q.mode !== "digest" && thin.length ? { related: thin } : {}),
        // Digests are answered from RSS; subject questions add web coverage when RSS is thin
        // ("what's happening with X" always benefits from a second, independent source).
        ...(q.mode === "coverage" || (q.mode === "lookup" && !enough) || (q.mode === "digest" && result.stories.length === 0)
          ? { suggestWebSearch: true }
          : {}),
        // Feeds failing → don't cache this answer for long.
        ...(failed.length || stale.length ? { cacheTtlSeconds: 15 } : {}),
      };
    },
  };
}

function storySource(s: Story, now: number): SourceInput {
  const coverage = s.sources
    .map((x) => `- ${x.source}: "${x.title}" — ${x.publishedAt ?? "date unknown"}${x.publishedAt ? ` (${age(x.publishedAt, now)})` : ""} (${x.url})`)
    .join("\n");
  const body = (s.content ?? s.summary).slice(0, 2500);
  return {
    title: s.title,
    url: s.sources[0]!.url,
    type: "news",
    evidence: (s.content?.length ?? 0) >= 800 ? "retrieved_content" : "search_result",
    ...(s.publishedAt ? { publishedAt: s.publishedAt } : {}),
    snippet: s.summary.slice(0, 400),
    content: [
      `Story first published ${s.publishedAt ?? "?"}${s.publishedAt ? ` (${age(s.publishedAt, now)})` : ""} · ${s.sources.length} article(s) from ${new Set(s.sources.map((x) => x.source)).size} outlet(s) · category: ${s.category}`,
      body ? `Summary from the feed: ${body}` : "",
      `Coverage:\n${coverage}`,
    ]
      .filter(Boolean)
      .join("\n"),
    relevance: s.relevance,
  };
}

function age(iso: string, now: number): string {
  const h = (now - Date.parse(iso)) / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)} days ago`;
}

function summarizeFailures(reports: FeedReport[]): string {
  return reports
    .filter((r) => r.error)
    .slice(0, 5)
    .map((r) => `${r.feed} (${r.error})`)
    .join(", ");
}
