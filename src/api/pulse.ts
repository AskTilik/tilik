import { Hono } from "hono";
import { explorerLinks, robinhoodChain } from "../config/chains.js";
import type { Env } from "../config/env.js";
import { loadFeeds } from "../config/feeds.js";
import type { Logger } from "../core/logger.js";
import { EvmRpcProvider, JsonRpcClient } from "../providers/blockchain/rpc.js";
import { GeckoTerminalClient } from "../providers/market/geckoterminal.js";
import { NewsStore } from "../providers/news/store.js";
import { checkUrl } from "../security/url-guard.js";

/**
 * GET /api/pulse — a small, read-only snapshot for the landing page: the latest Robinhood Chain block,
 * the network's top pools (GeckoTerminal) and the freshest headlines (RSS). No model is called.
 *
 * Cost/abuse: the whole snapshot is cached for PULSE_TTL_MS and concurrent requests share one refresh,
 * so upstream services see at most one round of calls per minute however many people visit. Each part
 * has its own deadline and fails on its own ("unavailable") without hiding the others.
 * Never returned: RPC URLs (they can embed provider keys), error details, raw upstream payloads.
 */
const PULSE_TTL_MS = 60_000;
const PART_TIMEOUT_MS = 12_000;
/**
 * A landing page must not promote junk: thin pools with huge "volume" and ±99% moves are typical of scam or
 * wash-traded tokens. Only pools with at least this much liquidity are shown, ranked by liquidity.
 */
export const PULSE_MIN_LIQUIDITY_USD = 100_000;
const PULSE_NEWS_CATEGORIES = new Set(["crypto", "ai", "technology"]);

export interface PulseChain {
  ok: boolean;
  name?: string;
  chainId?: number;
  blockNumber?: number;
  blockTime?: string;
  txCount?: number;
  gasUsedPct?: number;
  explorerUrl?: string;
}
export interface PulsePool {
  name: string;
  address: string;
  priceUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  change24hPct?: number;
  url: string;
}
export interface PulseHeadline {
  title: string;
  url: string;
  source: string;
  publishedAt?: string;
}
export interface Pulse {
  generatedAt: string;
  chain: PulseChain;
  market: { ok: boolean; network?: string; pools: PulsePool[] };
  news: { ok: boolean; headlines: PulseHeadline[] };
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
/** Control, zero-width and line/paragraph-separator characters (built from escapes: literal U+2028 breaks some parsers). */
const INVISIBLE = new RegExp("[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\ufeff]", "g");
/** Text from third parties: plain, single-line, bounded. (Rendered with textContent in the UI.) */
const clean = (s: unknown, max = 160): string =>
  String(s ?? "")
    .replace(INVISIBLE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

export function createPulse(env: Env, logger: Logger, deps: { now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  const chain = robinhoodChain(env);
  const links = explorerLinks(chain);
  const rpcOpts = { timeoutMs: env.ONCHAIN_RPC_TIMEOUT_MS, retries: 1, stableTtlMs: 60_000, liveTtlMs: 10_000 };
  const rpc = new EvmRpcProvider(chain, new JsonRpcClient(chain.rpcUrls, rpcOpts), rpcOpts);
  const gecko = new GeckoTerminalClient({
    baseUrl: env.GECKOTERMINAL_API_URL.replace(/\/+$/, ""),
    timeoutMs: env.GECKOTERMINAL_TIMEOUT_MS,
    retries: 0,
    ratePerMinute: 6,
    ttlSeconds: { live: 60, pools: 60, meta: 3600 },
    staleMaxSeconds: env.MARKET_STALE_MAX_SECONDS,
  });
  const news = new NewsStore(env);
  // Landing headlines stay on VEYRA's topics (and fetch fewer feeds); general news remains available in chat.
  const feeds = loadFeeds(env).feeds.filter((f) => f.enabled !== false && PULSE_NEWS_CATEGORIES.has(f.category));

  let cached: { at: number; value: Pulse } | undefined;
  let inflight: Promise<Pulse> | undefined;

  const part = async <T>(name: string, fallback: T, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    try {
      return await run(AbortSignal.timeout(PART_TIMEOUT_MS));
    } catch (err) {
      logger.warn("pulse part unavailable", { part: name, error: err instanceof Error ? err.name : "error" });
      return fallback;
    }
  };

  const readChain = (): Promise<PulseChain> =>
    part("chain", { ok: false }, async (signal) => {
      if (!env.ONCHAIN_ENABLED) return { ok: false };
      const budget = { signal, rpcCalls: 0, maxRpcCalls: 4, explorerCalls: 0, maxExplorerCalls: 0 };
      await rpc.ensureChain(budget); // never show data from a mis-configured RPC
      const block = await rpc.block("latest", budget);
      if (!block) return { ok: false };
      const gasUsedPct = block.gasLimit > 0n ? Number((block.gasUsed * 10_000n) / block.gasLimit) / 100 : undefined;
      const explorerUrl = links.block(block.number);
      return {
        ok: true,
        name: chain.name,
        chainId: chain.chainId,
        blockNumber: block.number,
        blockTime: block.timestamp,
        txCount: block.txCount,
        ...(gasUsedPct !== undefined ? { gasUsedPct } : {}),
        ...(explorerUrl ? { explorerUrl } : {}),
      };
    });

  const readMarket = (): Promise<Pulse["market"]> =>
    part("market", { ok: false, pools: [] }, async (signal) => {
      if (!env.MARKET_ENABLED) return { ok: false, pools: [] };
      const net = env.GECKOTERMINAL_NETWORK;
      type Pool = { attributes?: Record<string, unknown> };
      const res = await gecko.get<{ data?: Pool[] }>(`/networks/${encodeURIComponent(net)}/pools?page=1`, "pools", { signal, calls: 0, maxCalls: 1 });
      const pools = (res?.body.data ?? [])
        .map((p): PulsePool | null => {
          const a = p.attributes ?? {};
          const address = String(a.address ?? "");
          if (!/^0x[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/.test(address)) return null; // 20-byte pools or 32-byte v4 ids
          const vol = a.volume_usd as Record<string, unknown> | undefined;
          const chg = a.price_change_percentage as Record<string, unknown> | undefined;
          return {
            name: clean(a.name, 60) || "Pool",
            address,
            priceUsd: num(a.base_token_price_usd),
            liquidityUsd: num(a.reserve_in_usd),
            volume24hUsd: num(vol?.h24),
            change24hPct: num(chg?.h24),
            url: `https://www.geckoterminal.com/${encodeURIComponent(net)}/pools/${address}`,
          };
        })
        .filter((p): p is PulsePool => p !== null && (p.liquidityUsd ?? 0) >= PULSE_MIN_LIQUIDITY_USD)
        .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
        .slice(0, 5);
      return { ok: pools.length > 0, network: net, pools };
    });

  const readNews = (): Promise<Pulse["news"]> =>
    part("news", { ok: false, headlines: [] }, async (signal) => {
      if (!env.RSS_ENABLED || !feeds.length) return { ok: false, headlines: [] };
      const { articles } = await news.collect(feeds, signal, now());
      const maxAgeMs = env.NEWS_MAX_AGE_HOURS * 3_600_000;
      const seen = new Set<string>();
      const headlines = articles
        .filter((a) => a.publishedAt && now() - Date.parse(a.publishedAt) < maxAgeMs && checkUrl(a.url).ok)
        .sort((a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!))
        .filter((a) => {
          const key = a.title.toLowerCase().slice(0, 60);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 5)
        .map((a) => ({ title: clean(a.title), url: a.url, source: clean(a.source, 40), ...(a.publishedAt ? { publishedAt: a.publishedAt } : {}) }));
      return { ok: headlines.length > 0, headlines };
    });

  const refresh = async (): Promise<Pulse> => {
    const [c, m, n] = await Promise.all([readChain(), readMarket(), readNews()]);
    const value: Pulse = { generatedAt: new Date(now()).toISOString(), chain: c, market: m, news: n };
    cached = { at: now(), value };
    return value;
  };

  return {
    /** Cached snapshot; at most one refresh in flight. */
    get(): Promise<Pulse> {
      if (cached && now() - cached.at < PULSE_TTL_MS) return Promise.resolve(cached.value);
      inflight ??= refresh().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}

export function pulseRoutes(env: Env, logger: Logger, pulse = createPulse(env, logger)): Hono {
  const app = new Hono();
  app.get("/api/pulse", async (c) => {
    c.header("Cache-Control", "public, max-age=30");
    return c.json(await pulse.get());
  });
  return app;
}
