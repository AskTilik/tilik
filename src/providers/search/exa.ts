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
  timeRangeStart,
  toSources,
  WebSearchInputSchema,
  WebSearchOutputSchema,
  type WebResult,
  type WebSearchInput,
  type WebSearchOutput,
} from "./common.js";

interface ExaResponse {
  results?: {
    url?: string;
    title?: string | null;
    publishedDate?: string | null;
    author?: string | null;
    text?: string;
    highlights?: string[];
  }[];
  costDollars?: { total?: number };
}

const SEMANTIC = /\b(explain|how does|why|compare|overview|research|analy[sz]e|companies|startups?|papers?|similar to|alternatives?|competitors?|deep dive|landscape)\b/i;

/**
 * Exa — embeddings-based ("semantic") search with page text extraction.
 * Strong for research, companies, and conceptual queries.
 * Docs: https://exa.ai/docs/reference/search
 * Cost control: highlights only by default; full page text only in research mode.
 */
export function createExaTool(env: Env): Tool<WebSearchInput, WebSearchOutput> {
  return {
    name: "exa",
    description: "Semantic web search with domain/date filters and page text extraction.",
    capabilities: ["web.search"],
    inputSchema: WebSearchInputSchema,
    outputSchema: WebSearchOutputSchema,
    auth: { envKeys: ["EXA_API_KEY"] },
    rateLimit: { requestsPerMinute: 60 },
    dailyLimit: env.EXA_DAILY_REQUEST_LIMIT,
    costTier: "low",
    priority: 20,
    cacheTtlSeconds: env.VEYRA_SEARCH_CACHE_TTL_SECONDS,
    timeoutMs: env.VEYRA_TOOL_TIMEOUT_MS,
    isConfigured: () => Boolean(env.EXA_API_KEY),
    // Preferred for research and conceptual/semantic questions; Tavily wins on breaking news.
    suitability: (ctx) => (ctx.mode === "research" || SEMANTIC.test(ctx.query) ? 0.8 : isTimeSensitive(ctx) ? 0.4 : 0.5),
    planInput: (ctx) => planWebSearch(ctx, env.VEYRA_SEARCH_MAX_RESULTS),

    async execute(input, { signal }) {
      const deep = input.depth === "deep";
      const start = timeRangeStart(input.timeRange);
      const data = await httpJson<ExaResponse>(`${env.EXA_BASE_URL}/search`, {
        source: "tool:exa",
        headers: { "x-api-key": env.EXA_API_KEY ?? "" },
        body: {
          query: input.query,
          type: "auto",
          numResults: input.maxResults,
          ...(input.topic === "news" ? { category: "news" } : {}),
          ...(start ? { startPublishedDate: start } : {}),
          ...(input.includeDomains ? { includeDomains: input.includeDomains } : {}),
          ...(input.excludeDomains ? { excludeDomains: input.excludeDomains } : {}),
          contents: {
            highlights: { maxCharacters: 600 },
            ...(deep ? { text: { maxCharacters: 4000 } } : {}),
          },
        },
        timeoutMs: env.VEYRA_TOOL_TIMEOUT_MS,
        signal,
      });

      const raw = (data.results ?? []).filter((r) => r.url && safeHost(r.url));
      const results: WebResult[] = raw.map((r, i) => {
        const highlight = (r.highlights ?? []).join(" … ");
        const text = r.text?.trim();
        const publishedAt = normalizeDate(r.publishedDate);
        return {
          title: r.title?.trim() || safeHost(r.url!),
          url: r.url!,
          domain: safeHost(r.url!),
          snippet: clip(highlight || text || "", 500),
          ...(text ? { content: text } : {}),
          ...(publishedAt ? { publishedAt } : {}),
          sourceType: sourceTypeFor(r.url!, input.topic),
          // Exa no longer returns a relevance score; use its ranking.
          relevance: relevanceFor(i, raw.length),
        };
      });
      return { data: { provider: "exa", query: input.query, results }, sources: toSources(results) };
    },
  };
}
