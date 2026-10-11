import { z } from "zod";
import { explorerLinks, robinhoodChain } from "../../config/chains.js";
import type { Env } from "../../config/env.js";
import type { SourceInput } from "../../sources/types.js";
import type { Tool, ToolResult } from "../../tools/types.js";
import { marketForAddress, marketForSymbol, marketOverview, planMarketQuery, Validator, type MarketContext, type MarketQuery, type MarketSection } from "./analysis.js";
import { GeckoTerminalClient } from "./geckoterminal.js";

export const MarketInputSchema = z.object({
  kind: z.enum(["address", "symbol", "overview"]),
  addresses: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).max(10),
  symbol: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/).optional(),
  wants: z.object({ history: z.boolean(), trades: z.boolean() }),
  timeframe: z.enum(["day", "hour"]),
  invalid: z.array(z.object({ value: z.string().max(200), reason: z.string().max(300) })).max(10),
});

export const MarketDataSchema = z.object({
  provider: z.literal("geckoterminal"),
  network: z.string(),
  kind: z.enum(["address", "symbol", "overview"]),
  status: z.enum(["ok", "unavailable", "stale"]),
  fetchedAt: z.string().optional(),
  tokens: z.array(z.record(z.string(), z.unknown())),
  pools: z.array(z.record(z.string(), z.unknown())),
  candles: z.number(),
  trades: z.number(),
  droppedFields: z.number(),
  requests: z.number(),
});
export type MarketData = z.infer<typeof MarketDataSchema>;

/**
 * GeckoTerminal market intelligence: DEX prices, liquidity, volume, price
 * change, pools, OHLCV and trades for the configured network (default
 * "robinhood"). Every number is validated before it can become a statement.
 */
export function createGeckoTerminalTool(env: Env, deps: { client?: GeckoTerminalClient } = {}): Tool<MarketQuery, MarketData> {
  const client =
    deps.client ??
    new GeckoTerminalClient({
      baseUrl: env.GECKOTERMINAL_API_URL.replace(/\/+$/, ""),
      timeoutMs: env.GECKOTERMINAL_TIMEOUT_MS,
      retries: env.GECKOTERMINAL_RETRIES,
      ratePerMinute: env.GECKOTERMINAL_RATE_LIMIT_PER_MINUTE,
      ttlSeconds: { live: env.MARKET_CACHE_TTL, pools: env.POOL_CACHE_TTL, meta: env.TOKEN_METADATA_CACHE_TTL },
      staleMaxSeconds: env.MARKET_STALE_MAX_SECONDS,
    });
  const links = explorerLinks(robinhoodChain(env));

  return {
    name: "geckoterminal",
    description: `DEX market data from GeckoTerminal (network "${env.GECKOTERMINAL_NETWORK}"): price, liquidity, volume, pools, OHLCV, trades.`,
    capabilities: ["market.data"],
    inputSchema: MarketInputSchema,
    outputSchema: MarketDataSchema,
    auth: { envKeys: [] },
    rateLimit: { requestsPerMinute: env.GECKOTERMINAL_RATE_LIMIT_PER_MINUTE },
    dailyLimit: env.MARKET_DAILY_REQUEST_LIMIT,
    costTier: "free",
    priority: 1,
    // Whole answers are live market data: reuse only briefly.
    cacheTtlSeconds: env.MARKET_CACHE_TTL,
    timeoutMs: env.GECKOTERMINAL_TIMEOUT_MS * 3,
    isConfigured: () => env.MARKET_ENABLED,
    planInput: (ctx) => (ctx.intents.includes("market") ? planMarketQuery(ctx.query, ctx.entities, 3) : null),

    async execute(q, { signal }): Promise<ToolResult<MarketData>> {
      const ctx: MarketContext = {
        client,
        network: env.GECKOTERMINAL_NETWORK,
        budget: { signal, calls: 0, maxCalls: Math.max(1, env.MARKET_MAX_REQUESTS_PER_QUESTION) },
        limits: { maxPools: env.MARKET_MAX_POOLS, maxTrades: env.MARKET_MAX_TRADES, ohlcvDays: env.MARKET_OHLCV_DAYS },
        v: new Validator(),
        notices: new Set(),
        txLink: (h) => links.tx(h),
        citable: new Set(),
        freshness: {},
        results: { tokens: [], pools: [], candles: 0, trades: 0 },
      };

      const sections: MarketSection[] = [];
      if (q.invalid.length) {
        sections.push({ title: "Input validation (market)", content: q.invalid.map((i) => `- ${i.reason}. It was not queried.`).join("\n"), relevance: 1 });
      }
      if (q.kind === "address") for (const a of q.addresses) sections.push(...(await marketForAddress(a, q, ctx)));
      else if (q.kind === "symbol" && q.symbol) sections.push(...(await marketForSymbol(q.symbol, ctx)));
      else if (!q.invalid.length) sections.push(...(await marketOverview(ctx)));

      if (ctx.v.dropped) ctx.notices.add(`${ctx.v.dropped} malformed market value(s) from GeckoTerminal were discarded and are reported as unavailable.`);
      if (ctx.freshness.stale) ctx.notices.add(`GeckoTerminal is unavailable (${ctx.freshness.stale}); some market figures are last-known values and are marked STALE.`);
      const unavailable = sections.length > 0 && sections.every((s) => /^Market data unavailable|^Input validation/.test(s.title));
      if (unavailable) ctx.notices.add("Market data unavailable from GeckoTerminal for this request — no prices or volumes are reported.");

      const usedUrls = new Set<string>();
      const sources: SourceInput[] = sections.map((s) => ({
        title: s.title,
        ...(s.url && !usedUrls.has(s.url) && usedUrls.add(s.url) ? { url: s.url } : {}),
        type: "market",
        evidence: "live_data",
        content: s.content,
        snippet: s.content.split("\n").slice(0, 2).join(" · ").slice(0, 300),
        relevance: s.relevance,
      }));

      return {
        data: {
          provider: "geckoterminal",
          network: env.GECKOTERMINAL_NETWORK,
          kind: q.kind,
          status: unavailable ? "unavailable" : ctx.freshness.stale ? "stale" : "ok",
          ...(ctx.freshness.oldest ? { fetchedAt: new Date(ctx.freshness.oldest).toISOString() } : {}),
          tokens: ctx.results.tokens as unknown as Record<string, unknown>[],
          pools: ctx.results.pools as unknown as Record<string, unknown>[],
          candles: ctx.results.candles,
          trades: ctx.results.trades,
          droppedFields: ctx.v.dropped,
          requests: ctx.budget.calls,
        },
        sources,
        notices: [...ctx.notices],
        citableUrls: [...ctx.citable],
        // Stale data must not be served from the answer cache once GeckoTerminal recovers.
        ...(ctx.freshness.stale ? { cacheTtlSeconds: 0 } : {}),
      };
    },
  };
}
