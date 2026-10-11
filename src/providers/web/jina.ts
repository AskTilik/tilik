import type { Env } from "../../config/env.js";
import { VeyraError } from "../../core/errors.js";
import { httpJson } from "../../core/http.js";
import type { Tool } from "../../tools/types.js";
import { ExtractedPageSchema, ExtractInputSchema, finalizePage, planExtraction, type ExtractedPage, type ExtractInput } from "./common.js";

interface JinaResponse {
  code?: number;
  status?: number;
  data?: {
    title?: string;
    url?: string;
    description?: string;
    content?: string;
    publishedTime?: string;
  };
  message?: string;
}

/**
 * Jina Reader — converts any URL to clean, LLM-ready markdown.
 * Free: works without a key (20 req/min); a free key gives 500 req/min and 10M tokens.
 * Docs: https://jina.ai/reader/
 */
export function createJinaTool(env: Env): Tool<ExtractInput, ExtractedPage> {
  const keyed = Boolean(env.JINA_API_KEY);
  return {
    name: "jina",
    description: "Reads a web page and returns its main content as markdown (Jina Reader).",
    capabilities: ["web.extract"],
    inputSchema: ExtractInputSchema,
    outputSchema: ExtractedPageSchema,
    auth: { envKeys: ["JINA_API_KEY"] },
    // Stay under Jina's limits: 20/min keyless, 500/min with a key.
    rateLimit: { requestsPerMinute: keyed ? 200 : 15 },
    dailyLimit: env.JINA_DAILY_REQUEST_LIMIT,
    costTier: "free",
    priority: 10,
    cacheTtlSeconds: env.VEYRA_EXTRACT_CACHE_TTL_SECONDS,
    timeoutMs: env.VEYRA_TOOL_TIMEOUT_MS,
    isConfigured: () => keyed || env.JINA_ALLOW_KEYLESS,
    suitability: () => (env.VEYRA_EXTRACT_PRIMARY === "jina" ? 0.7 : 0.4),
    planInput: (ctx) => planExtraction(ctx, env.VEYRA_EXTRACT_MAX_CHARS),

    async execute(input, { signal }) {
      const res = await httpJson<JinaResponse>(`${env.JINA_BASE_URL}/`, {
        source: "tool:jina",
        headers: {
          Accept: "application/json",
          "X-Return-Format": "markdown",
          "X-Retain-Images": "none",
          "X-Remove-Selector": "nav, footer, header, aside, form, script, style, noscript, iframe",
          "X-Timeout": String(Math.max(5, Math.floor(env.VEYRA_TOOL_TIMEOUT_MS / 1000) - 2)),
          ...(env.JINA_API_KEY ? { Authorization: `Bearer ${env.JINA_API_KEY}` } : {}),
        },
        body: { url: input.url },
        timeoutMs: env.VEYRA_TOOL_TIMEOUT_MS,
        signal,
        // 403 usually means the *target site* refused the reader, not that our key is bad. Treating it as an
        // auth failure would pause Jina for every other page (and keyless Jina has no key to be wrong).
        mapError: (status, body) =>
          status === 403 && !(env.JINA_API_KEY && /api[_ -]?key|token|unauthori[sz]ed|invalid.*(key|auth)/i.test(body))
            ? new VeyraError("bad_request", "tool:jina", "The page could not be read (the site refused the reader)", { status })
            : undefined,
      });
      if (res.code !== undefined && res.code !== 200) {
        throw new VeyraError("upstream", "tool:jina", `Jina Reader returned code ${res.code}: ${res.message ?? res.status ?? ""}`);
      }
      const d = res.data ?? {};
      return finalizePage("jina", input, {
        url: d.url,
        title: d.title,
        description: d.description,
        publishedAt: d.publishedTime,
        content: d.content ?? "",
      });
    },
  };
}
