import { z } from "zod";
import type { Evidence, SourceInput, SourceType } from "../../sources/types.js";
import type { ToolPlanningContext } from "../../tools/types.js";

/**
 * Shared input for every web-search tool, so the router can plan a search once
 * and any provider (Tavily, Exa, …) can execute it or act as fallback.
 */
export const WebSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(400),
  maxResults: z.number().int().min(1).max(20),
  topic: z.enum(["general", "news", "finance"]).default("general"),
  /** Only results published within this window. */
  timeRange: z.enum(["day", "week", "month", "year"]).optional(),
  includeDomains: z.array(z.string()).max(20).optional(),
  excludeDomains: z.array(z.string()).max(20).optional(),
  /** "deep" retrieves longer page text (research mode) at higher provider cost. */
  depth: z.enum(["standard", "deep"]).default("standard"),
});
export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

/** VEYRA's provider-independent web result. */
export const WebResultSchema = z.object({
  title: z.string(),
  url: z.url(),
  domain: z.string(),
  snippet: z.string(),
  content: z.string().optional(),
  publishedAt: z.string().optional(),
  sourceType: z.enum(["web", "documentation", "github", "news", "onchain", "market", "research"]),
  relevance: z.number().min(0).max(1),
});
export type WebResult = z.infer<typeof WebResultSchema>;

export const WebSearchOutputSchema = z.object({
  provider: z.string(),
  query: z.string(),
  results: z.array(WebResultSchema),
});
export type WebSearchOutput = z.infer<typeof WebSearchOutputSchema>;

const DAY = /\b(today|tonight|this morning|right now|breaking|past 24 hours|last 24 hours|just now)\b/i;
const WEEK = /\b(this week|past week|last week|last few days|past few days|yesterday)\b/i;
const MONTH = /\b(this month|past month|last month|last few weeks|past few weeks)\b/i;
const YEAR = /\b(this year|past year|last year|last 12 months)\b/i;
const FINANCE = /\b(stocks?|shares|earnings|revenue|ipo|market cap|valuation|nasdaq|nyse|s&p)\b/i;

/** Derives a search from the user's text: site: filters, recency window and topic. Zero cost, deterministic. */
export function planWebSearch(ctx: ToolPlanningContext, maxResults: number): WebSearchInput | null {
  const includeDomains: string[] = [];
  const excludeDomains: string[] = [];
  const query = ctx.query
    .replace(/(^|\s)(-?)site:([^\s]+)/gi, (_m, pre: string, neg: string, domain: string) => {
      (neg ? excludeDomains : includeDomains).push(domain.toLowerCase());
      return pre;
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  if (!query) return null;

  const news = ctx.intents.includes("news");
  const timeRange = DAY.test(query)
    ? "day"
    : WEEK.test(query)
      ? "week"
      : MONTH.test(query)
        ? "month"
        : YEAR.test(query)
          ? "year"
          : news && /\b(latest|recent|recently|new|news)\b/i.test(query)
            ? "week"
            : undefined;

  return {
    query,
    maxResults,
    topic: news ? "news" : ctx.intents.includes("market") || FINANCE.test(query) ? "finance" : "general",
    ...(timeRange ? { timeRange } : {}),
    ...(includeDomains.length ? { includeDomains } : {}),
    ...(excludeDomains.length ? { excludeDomains } : {}),
    depth: ctx.mode === "research" ? "deep" : "standard",
  };
}

export function isTimeSensitive(ctx: ToolPlanningContext): boolean {
  return ctx.intents.includes("news") || DAY.test(ctx.query) || WEEK.test(ctx.query);
}

export function timeRangeStart(range: WebSearchInput["timeRange"], now = new Date()): string | undefined {
  if (!range) return undefined;
  const days = { day: 1, week: 7, month: 31, year: 366 }[range];
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export function sourceTypeFor(url: string, topic: WebSearchInput["topic"]): SourceType {
  const host = safeHost(url);
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (/^(docs|developer|developers)\./.test(host) || /\/docs?\//.test(url)) return "documentation";
  if (host === "arxiv.org" || host.endsWith(".edu")) return "research";
  return topic === "news" ? "news" : "web";
}

/** Normalizes an ISO / RFC-2822 date to ISO-8601, or drops it when unparseable. */
export function normalizeDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Rank-based relevance in [0.5, 1], blended with a provider score when one is given. */
export function relevanceFor(rank: number, total: number, providerScore?: number): number {
  const byRank = 1 - (rank / Math.max(total, 1)) * 0.5;
  if (providerScore === undefined || !Number.isFinite(providerScore)) return round(byRank);
  return round(Math.min(1, Math.max(0, 0.5 * byRank + 0.5 * Math.min(1, Math.max(0, providerScore)))));
}

export function toSources(results: WebResult[]): SourceInput[] {
  return results.map((r) => {
    const evidence: Evidence = r.content ? "retrieved_content" : "search_result";
    return {
      title: r.title,
      url: r.url,
      type: r.sourceType,
      evidence,
      snippet: r.snippet,
      ...(r.content ? { content: r.content } : {}),
      ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
      relevance: r.relevance,
    };
  });
}

export function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
