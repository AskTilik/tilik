import type { Env } from "../../config/env.js";
import { VeyraError } from "../../core/errors.js";
import { httpJson } from "../../core/http.js";
import type { Tool } from "../../tools/types.js";
import {
  ExtractedPageSchema,
  ExtractInputSchema,
  finalizePage,
  firstString,
  planExtraction,
  type ExtractedPage,
  type ExtractInput,
} from "./common.js";

interface FirecrawlResponse {
  success?: boolean;
  error?: string;
  data?: {
    markdown?: string;
    metadata?: Record<string, unknown> & { statusCode?: number; error?: string | null };
  };
}

/**
 * Firecrawl — robust scraping (JS rendering, anti-bot handling) returning main-content markdown.
 * Cost: 1 credit per page. Docs: https://docs.firecrawl.dev/api-reference/endpoint/scrape
 */
export function createFirecrawlTool(env: Env): Tool<ExtractInput, ExtractedPage> {
  return {
    name: "firecrawl",
    description: "Scrapes a web page (including JavaScript-heavy sites) and returns its main content as markdown.",
    capabilities: ["web.extract"],
    inputSchema: ExtractInputSchema,
    outputSchema: ExtractedPageSchema,
    auth: { envKeys: ["FIRECRAWL_API_KEY"] },
    rateLimit: { requestsPerMinute: 10 },
    dailyLimit: env.FIRECRAWL_DAILY_REQUEST_LIMIT,
    costTier: "low",
    priority: 20,
    cacheTtlSeconds: env.VEYRA_EXTRACT_CACHE_TTL_SECONDS,
    timeoutMs: env.VEYRA_TOOL_TIMEOUT_MS,
    isConfigured: () => Boolean(env.FIRECRAWL_API_KEY),
    suitability: () => (env.VEYRA_EXTRACT_PRIMARY === "firecrawl" ? 0.7 : 0.4),
    planInput: (ctx) => planExtraction(ctx, env.VEYRA_EXTRACT_MAX_CHARS),

    async execute(input, { signal }) {
      const res = await httpJson<FirecrawlResponse>(`${env.FIRECRAWL_BASE_URL}/v2/scrape`, {
        source: "tool:firecrawl",
        headers: { Authorization: `Bearer ${env.FIRECRAWL_API_KEY ?? ""}` },
        body: {
          url: input.url,
          formats: ["markdown"],
          onlyMainContent: true,
          blockAds: true,
          removeBase64Images: true,
          // Accept Firecrawl's cached copy up to a day old: faster and cheaper.
          maxAge: 86_400_000,
          timeout: Math.max(1000, env.VEYRA_TOOL_TIMEOUT_MS - 1000),
        },
        timeoutMs: env.VEYRA_TOOL_TIMEOUT_MS,
        signal,
      });
      if (res.success === false) throw new VeyraError("upstream", "tool:firecrawl", res.error ?? "Firecrawl scrape failed");
      const meta = res.data?.metadata ?? {};
      if (typeof meta.statusCode === "number" && meta.statusCode >= 400) {
        throw new VeyraError(meta.statusCode === 404 ? "not_found" : "upstream", "tool:firecrawl", `Target page returned HTTP ${meta.statusCode}`);
      }
      return finalizePage("firecrawl", input, {
        url: firstString(meta.url) ?? firstString(meta.sourceURL),
        title: firstString(meta.title) ?? firstString(meta.ogTitle),
        description: firstString(meta.description),
        publishedAt:
          firstString(meta.publishedTime) ?? firstString(meta["article:published_time"]) ?? firstString(meta.publishedDate),
        content: res.data?.markdown ?? "",
      });
    },
  };
}
