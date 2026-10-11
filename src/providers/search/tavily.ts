import type { Env } from "../../config/env.js";
import { httpJson } from "../../core/http.js";
import type { Tool } from "../../tools/types.js";
import {
  clip,
  isTimeSensitive,
  normalizeDate,
  planWebSearch,
  relevanceFor,
  safeHost,
  sourceTypeFor,
  toSources,
  WebSearchInputSchema,
  WebSearchOutputSchema,
  type WebResult,
  type WebSearchInput,
  type WebSearchOutput,
} from "./common.js";

interface TavilyResponse {
  query?: string;
  results?: {
    title?: string;
    url?: string;
    content?: string;
    score?: number;
    published_date?: string;
  }[];
}

/**
 * Tavily — search built for agents. Strong on fresh/news results and returns
 * query-relevant snippets. Docs: https://docs.tavily.com/documentation/api-reference/endpoint/search
 * Cost: basic = 1 credit, advanced = 2 credits (used only in research mode).
 */
export function createTavilyTool(env: Env): Tool<WebSearchInput, WebSearchOutput> {
  return {
    name: "tavily",
    description: "Real-time web and news search with relevant snippets and publication dates.",
    capabilities: ["web.search"],
    inputSchema: WebSearchInputSchema,
    outputSchema: WebSearchOutputSchema,
    auth: { envKeys: ["TAVILY_API_KEY"] },
    rateLimit: { requestsPerMinute: 60 },
    dailyLimit: env.TAVILY_DAILY_REQUEST_LIMIT,
    costTier: "low",
    priority: 10,
    cacheTtlSeconds: env.VEYRA_SEARCH_CACHE_TTL_SECONDS,
    timeoutMs: env.VEYRA_TOOL_TIMEOUT_MS,
    isConfigured: () => Boolean(env.TAVILY_API_KEY),
    // Preferred for time-sensitive and news questions.
    suitability: (ctx) => (isTimeSensitive(ctx) ? 0.8 : 0.5),
    planInput: (ctx) => planWebSearch(ctx, env.VEYRA_SEARCH_MAX_RESULTS),

    async execute(input, { signal }) {
      const deep = input.depth === "deep";
      const data = await httpJson<TavilyResponse>(`${env.TAVILY_BASE_URL}/search`, {
        source: "tool:tavily",
        headers: { Authorization: `Bearer ${env.TAVILY_API_KEY ?? ""}` },
        body: {
          query: input.query,
          topic: input.topic,
          search_depth: deep ? "advanced" : "basic",
          max_results: input.maxResults,
          chunks_per_source: deep ? 3 : 2,
          include_published_date: true,
          include_answer: false, // VEYRA does its own synthesis — don't pay for Tavily's
          include_raw_content: false,
          ...(input.timeRange ? { time_range: input.timeRange } : {}),
          ...(input.includeDomains ? { include_domains: input.includeDomains } : {}),
          ...(input.excludeDomains ? { exclude_domains: input.excludeDomains } : {}),
        },
        timeoutMs: env.VEYRA_TOOL_TIMEOUT_MS,
        signal,
      });

      const raw = (data.results ?? []).filter((r) => r.url && safeHost(r.url));
      const results: WebResult[] = raw.map((r, i) => {
        const text = r.content ?? "";
        const publishedAt = normalizeDate(r.published_date);
        return {
          title: r.title?.trim() || safeHost(r.url!),
          url: r.url!,
          domain: safeHost(r.url!),
          snippet: clip(text, 500),
          // Advanced depth returns several relevant chunks per page — worth passing to the model.
          ...(deep && text.length > 500 ? { content: text } : {}),
          ...(publishedAt ? { publishedAt } : {}),
          sourceType: sourceTypeFor(r.url!, input.topic),
          relevance: relevanceFor(i, raw.length, r.score),
        };
      });
      return { data: { provider: "tavily", query: input.query, results }, sources: toSources(results) };
    },
  };
}
