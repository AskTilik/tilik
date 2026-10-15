import { Hono } from "hono";
import { TtlCache } from "../cache/ttl-cache.js";
import { robinhoodChain, type ChainConfig } from "../config/chains.js";
import { rateLimitEnabled, type Env } from "../config/env.js";
import type { Logger } from "../core/logger.js";
import { formatUnits, toChecksumAddress, validateAddress } from "../providers/blockchain/evm.js";
import { BlockscoutExplorer } from "../providers/blockchain/explorer.js";
import { EvmRpcProvider, JsonRpcClient } from "../providers/blockchain/rpc.js";
import type { BlockchainProvider } from "../providers/blockchain/types.js";
import { GeckoTerminalClient } from "../providers/market/geckoterminal.js";
import type { ClientRateLimiter } from "../security/rate-limit.js";
import { clientKey, tooManyRequests, type AppVariables } from "./http-guards.js";

/**
 * Portfolio and watchlist prices — no model involved.
 *
 * - GET /api/portfolio/:address — what a wallet holds and what it is worth: native ETH (RPC) and ERC-20
 *   balances (Blockscout), priced with one GeckoTerminal multi-token call. Tokens whose markets are too thin
 *   to trust (liquidity under $1,000) are listed but left out of the total.
 * - GET /api/prices?tokens=0x…,0x… — price, 24 h change and liquidity for up to 30 tokens (the watchlist).
 */
const TTL_MS = 30_000;
const MAX_PRICED = 30;
const MIN_TRUSTED_LIQUIDITY = 1_000;
const PER_MINUTE = 20;
/** WETH on Robinhood Chain: the price of native ETH. */
export const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

export interface Holding {
  address: string | null; // null = native ETH
  symbol?: string;
  name?: string;
  amount: string;
  priceUsd?: number;
  valueUsd?: number;
  change24hPct?: number;
  liquidityUsd?: number;
  /** Price exists but the market is too thin to trust it; not counted in the total. */
  thin?: boolean;
}
export interface Portfolio {
  address: string;
  chain: { name: string; chainId: number };
  totalUsd: number;
  change24hUsd: number;
  change24hPct?: number;
  holdings: Holding[];
  unpriced: number;
  explorer: boolean;
  generatedAt: string;
}
export interface PriceRow {
  priceUsd?: number;
  change24hPct?: number;
  liquidityUsd?: number;
}

const INVISIBLE = new RegExp("[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\ufeff]", "g");
const clean = (s: unknown, max = 40): string | undefined => {
  const v = String(s ?? "").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return v || undefined;
};
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

export function createPortfolio(
  env: Env,
  logger: Logger,
  deps: { chain?: ChainConfig; provider?: BlockchainProvider; explorer?: BlockscoutExplorer | null; gecko?: GeckoTerminalClient; now?: () => number } = {},
) {
  const now = deps.now ?? Date.now;
  const chain = deps.chain ?? robinhoodChain(env);
  const net = env.GECKOTERMINAL_NETWORK;
  const rpcOpts = { timeoutMs: env.ONCHAIN_RPC_TIMEOUT_MS, retries: 1, stableTtlMs: 300_000, liveTtlMs: 15_000 };
  const provider = deps.provider ?? new EvmRpcProvider(chain, new JsonRpcClient(chain.rpcUrls, rpcOpts), rpcOpts);
  const explorer =
    deps.explorer === null
      ? undefined
      : (deps.explorer ??
        (chain.explorerApiUrl
          ? new BlockscoutExplorer(chain.explorerApiUrl, {
              timeoutMs: env.ONCHAIN_RPC_TIMEOUT_MS,
              liveTtlMs: 15_000,
              stableTtlMs: 300_000,
              ...(chain.explorerApiKey ? { apiKey: chain.explorerApiKey } : {}),
            })
          : undefined));
  const gecko =
    deps.gecko ??
    new GeckoTerminalClient({
      baseUrl: env.GECKOTERMINAL_API_URL.replace(/\/+$/, ""),
      timeoutMs: env.GECKOTERMINAL_TIMEOUT_MS,
      retries: 2,
      ratePerMinute: env.GECKOTERMINAL_RATE_LIMIT_PER_MINUTE,
      ttlSeconds: { live: 30, pools: 60, meta: 3600 },
      staleMaxSeconds: env.MARKET_STALE_MAX_SECONDS,
    });
  const cache = new TtlCache<unknown>(500);
  const inflight = new Map<string, Promise<unknown>>();
  const cached = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit as T;
    let p = inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load()
        .then((v) => {
          cache.set(key, v, TTL_MS);
          return v;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  };

  /** One GeckoTerminal call for up to 30 tokens (lowercase addresses). */
  async function prices(tokens: string[]): Promise<Record<string, PriceRow>> {
    const list = [...new Set(tokens.map((t) => t.toLowerCase()))].slice(0, MAX_PRICED);
    if (!list.length) return {};
    const res = await gecko.get<{ data?: { attributes?: Record<string, Record<string, string | null> | undefined> } }>(
      `/simple/networks/${encodeURIComponent(net)}/token_price/${list.join(",")}?include_24hr_price_change=true&include_total_reserve_in_usd=true`,
      "live",
      { signal: AbortSignal.timeout(15_000), calls: 0, maxCalls: 1 },
    );
    const a = res?.body.data?.attributes ?? {};
    const out: Record<string, PriceRow> = {};
    for (const t of list) {
      const p = num(a.token_prices?.[t]), c = num(a.h24_price_change_percentage?.[t]), l = num(a.total_reserve_in_usd?.[t]);
      if (p === undefined) continue;
      out[t] = { priceUsd: p, ...(c !== undefined ? { change24hPct: round2(c) } : {}), ...(l !== undefined ? { liquidityUsd: round2(l) } : {}) };
    }
    return out;
  }

  async function portfolio(address: string): Promise<Portfolio> {
    const budget = { signal: AbortSignal.timeout(15_000), rpcCalls: 0, maxRpcCalls: 3, explorerCalls: 0, maxExplorerCalls: 1 };
    await provider.ensureChain(budget);
    const [balance, tokens] = await Promise.all([
      provider.balance(address, budget),
      explorer ? explorer.addressTokens(address, budget).catch(() => null) : Promise.resolve(null),
    ]);
    const raw = (tokens?.items ?? [])
      .filter((h) => h.value && /^\d+$/.test(h.value) && h.value !== "0" && /^0x[0-9a-fA-F]{40}$/.test(h.token.address_hash))
      .map((h) => {
        const dec = h.token.decimals && /^\d+$/.test(h.token.decimals) ? Number(h.token.decimals) : 18;
        return {
          address: h.token.address_hash.toLowerCase(),
          symbol: clean(h.token.symbol, 20),
          name: clean(h.token.name),
          amount: formatUnits(BigInt(h.value!), dec, 6),
          units: Number(BigInt(h.value!) / 10n ** BigInt(Math.max(0, dec - 6))) / 1e6,
        };
      });
    const priced = await prices([WETH, ...raw.map((r) => r.address)]).catch((err) => {
      logger.warn("portfolio prices failed", { error: err instanceof Error ? err.name : "error" });
      return {} as Record<string, PriceRow>;
    });
    const eth = priced[WETH];
    const ethUnits = Number(balance / 10n ** 12n) / 1e6;
    const holdings: Holding[] = [];
    if (balance > 0n || !raw.length) {
      const v = eth?.priceUsd !== undefined ? ethUnits * eth.priceUsd : undefined;
      holdings.push({
        address: null,
        symbol: chain.nativeSymbol,
        name: "Ether (native)",
        amount: formatUnits(balance, chain.nativeDecimals, 6),
        ...(eth?.priceUsd !== undefined ? { priceUsd: eth.priceUsd } : {}),
        ...(v !== undefined ? { valueUsd: round2(v) } : {}),
        ...(eth?.change24hPct !== undefined ? { change24hPct: eth.change24hPct } : {}),
      });
    }
    let unpriced = 0;
    for (const r of raw) {
      const p = priced[r.address];
      if (!p?.priceUsd) unpriced++;
      const thin = p?.priceUsd !== undefined && (p.liquidityUsd ?? 0) < MIN_TRUSTED_LIQUIDITY;
      holdings.push({
        address: toChecksumAddress(r.address),
        ...(r.symbol ? { symbol: r.symbol } : {}),
        ...(r.name ? { name: r.name } : {}),
        amount: r.amount,
        ...(p?.priceUsd !== undefined ? { priceUsd: p.priceUsd, valueUsd: round2(r.units * p.priceUsd) } : {}),
        ...(p?.change24hPct !== undefined ? { change24hPct: p.change24hPct } : {}),
        ...(p?.liquidityUsd !== undefined ? { liquidityUsd: p.liquidityUsd } : {}),
        ...(thin ? { thin: true } : {}),
      });
    }
    holdings.sort((a, b) => Number(Boolean(a.thin)) - Number(Boolean(b.thin)) || (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
    const counted = holdings.filter((h) => h.valueUsd !== undefined && !h.thin);
    const total = counted.reduce((s, h) => s + h.valueUsd!, 0);
    // Value 24 h ago at today's balances: value / (1 + change).
    const before = counted.reduce((s, h) => s + (h.change24hPct !== undefined && h.change24hPct > -100 ? h.valueUsd! / (1 + h.change24hPct / 100) : h.valueUsd!), 0);
    return {
      address: toChecksumAddress(address),
      chain: { name: chain.name, chainId: chain.chainId },
      totalUsd: round2(total),
      change24hUsd: round2(total - before),
      ...(before > 0 ? { change24hPct: round2(((total - before) / before) * 100) } : {}),
      holdings: holdings.slice(0, 60),
      unpriced,
      explorer: Boolean(explorer),
      generatedAt: new Date(now()).toISOString(),
    };
  }

  return {
    portfolio: (address: string) => cached(`pf:${address.toLowerCase()}`, () => portfolio(address)),
    prices: (tokens: string[]) => cached(`px:${[...tokens].map((t) => t.toLowerCase()).sort().join(",")}`, () => prices(tokens)),
    logger,
  };
}

export function portfolioRoutes(env: Env, limiter: ClientRateLimiter, pf = createPortfolio(env, { warn() {}, info() {}, error() {}, debug() {} } as unknown as Logger)): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  const block = (c: Parameters<typeof clientKey>[0]) => {
    if (!rateLimitEnabled(env)) return null;
    const v = limiter.take("portfolio", clientKey(c, env), PER_MINUTE);
    return v.ok ? null : tooManyRequests(c, v.retryAfterMs);
  };
  const ok = (c: { header(k: string, v: string): void }, s: number) => c.header("Cache-Control", `public, max-age=15, s-maxage=${s}, stale-while-revalidate=${s * 4}`);
  app.get("/api/portfolio/:address", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!env.ONCHAIN_ENABLED) return c.json({ error: { kind: "unavailable", message: "On-chain data is turned off." } }, 503);
    const check = validateAddress(c.req.param("address").trim());
    if (!check.ok) return c.json({ error: { kind: "validation", message: "That is not a valid wallet address." } }, 400);
    const b = block(c);
    if (b) return b;
    try {
      const body = await pf.portfolio(check.address);
      ok(c, 30);
      return c.json(body);
    } catch (err) {
      pf.logger.warn("portfolio failed", { error: err instanceof Error ? err.name : "error" });
      return c.json({ error: { kind: "upstream", message: "This wallet could not be read right now. Try again in a moment." } }, 502);
    }
  });
  app.get("/api/prices", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!env.MARKET_ENABLED) return c.json({ error: { kind: "unavailable", message: "Market data is turned off." } }, 503);
    const tokens = (c.req.query("tokens") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    if (!tokens.length || tokens.length > MAX_PRICED || !tokens.every((t) => /^0x[0-9a-fA-F]{40}$/.test(t)))
      return c.json({ error: { kind: "validation", message: `Pass 1 to ${MAX_PRICED} token addresses, comma-separated.` } }, 400);
    const b = block(c);
    if (b) return b;
    try {
      const body = { prices: await pf.prices(tokens), generatedAt: new Date().toISOString() };
      ok(c, 30);
      return c.json(body);
    } catch (err) {
      const busy = (err as { kind?: string })?.kind === "rate_limit";
      return c.json({ error: { kind: busy ? "rate_limit" : "upstream", message: "Prices could not be read right now. Try again in a moment." } }, busy ? 503 : 502);
    }
  });
  return app;
}
