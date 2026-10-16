import { Hono } from "hono";
import { TtlCache } from "../cache/ttl-cache.js";
import { robinhoodChain, type ChainConfig } from "../config/chains.js";
import { rateLimitEnabled, type Env } from "../config/env.js";
import type { Logger } from "../core/logger.js";
import { toChecksumAddress, validateAddress } from "../providers/blockchain/evm.js";
import { BlockscoutExplorer } from "../providers/blockchain/explorer.js";
import { GeckoTerminalClient } from "../providers/market/geckoterminal.js";
import type { ClientRateLimiter } from "../security/rate-limit.js";
import type { AddressProfile } from "./address.js";
import { clientKey, tooManyRequests, type AppVariables } from "./http-guards.js";

/**
 * Token intelligence for the landing page — no model involved:
 *
 * - GET /api/token/:address — every pool of a token (GeckoTerminal) with its real liquidity, the
 *   largest holders (Blockscout) and a list of plain, sourced safety signals. Signals are facts with a
 *   level ("ok" / "info" / "warn" / "risk"), never a verdict or advice.
 * - GET /api/radar — trending and newest pools on Robinhood Chain (GeckoTerminal).
 *
 * Everything is cached (60 s) and shared by all visitors, so upstream sees at most a few calls per
 * minute; each client also has its own allowance. Third-party text is cleaned and bounded.
 */
const TOKEN_TTL_MS = 60_000;
const RADAR_TTL_MS = 60_000;
const TIMEOUT_MS = 15_000;
const PER_MINUTE = 20;

export type Level = "ok" | "info" | "warn" | "risk";
export interface Check {
  id: string;
  level: Level;
  title: string;
  detail: string;
}
export interface PoolInfo {
  name: string;
  dex: string;
  address: string;
  liquidityUsd?: number;
  volume24hUsd?: number;
  buys24h?: number;
  sells24h?: number;
  change24hPct?: number;
  priceUsd?: number;
  createdAt?: string;
  /** Pool fee read from the pool name (e.g. "TILIK / WETH 90%"). */
  feePct?: number;
  main?: boolean;
  url: string;
}
export interface HolderInfo {
  address: string;
  label?: string;
  contract: boolean;
  pct: number;
  /** Pools, lockers and burn addresses are not "holders" in the usual sense. */
  role?: "pool" | "locker" | "burn";
}
export interface TokenIntel {
  address: string;
  chain: { name: string; chainId: number };
  token: { name?: string; symbol?: string; holders?: number; totalSupply?: string };
  verified?: boolean;
  creator?: string;
  market?: { priceUsd?: number; fdvUsd?: number; liquidityUsd?: number; volume24hUsd?: number; graduated?: { at?: string; pool?: string } };
  pools: PoolInfo[];
  holders?: { top: HolderInfo[]; top10Pct: number; note: string };
  checks: Check[];
  sources: string[];
  generatedAt: string;
}
export const TIMEFRAMES = { "15m": ["minute", 15, 96], "1h": ["hour", 1, 72], "4h": ["hour", 4, 90], "1d": ["day", 1, 60] } as const;
export type Timeframe = keyof typeof TIMEFRAMES;
export interface Chart {
  pool: { name: string; address: string; dex: string; url: string };
  tf: Timeframe;
  /** [unix seconds, open, high, low, close, volume USD], oldest first, price in USD. */
  candles: [number, number, number, number, number, number][];
  generatedAt: string;
}
export interface Trade {
  kind: "buy" | "sell";
  usd: number;
  amount: number;
  priceUsd?: number;
  wallet: string;
  time: string;
  tx: string;
  url?: string;
  whale?: boolean;
}
export interface Trades {
  pool: { name: string; address: string; dex: string; url: string };
  trades: Trade[];
  summary: { buys: number; sells: number; buyUsd: number; sellUsd: number; wallets: number; since?: string; whaleUsd: number };
  generatedAt: string;
}

export interface Launch {
  token: { address: string; symbol?: string; name?: string };
  pool: { name: string; dex: string; address: string; url: string; createdAt?: string; liquidityUsd?: number; buys1h?: number; sells1h?: number; feePct?: number };
  holders?: number;
  verified?: boolean;
  /** Plain facts, worst first. Not a rating. */
  flags: { level: Level; text: string }[];
  level: Level;
}

export interface RadarPool extends PoolInfo {
  token: { address: string; symbol?: string };
}

const INVISIBLE = new RegExp("[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\ufeff]", "g");
const clean = (s: unknown, max = 60): string | undefined => {
  const v = String(s ?? "").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return v || undefined;
};
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const feeOf = (name?: string): number | undefined => {
  const m = name?.match(/(\d+(?:\.\d+)?)%\s*$/);
  return m ? Number(m[1]) : undefined;
};
const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(n < 10 ? 2 : 0)}`);
const BURN = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead", "0xdead000000000000000000000000000000000000"]);

type GtPool = {
  attributes?: Record<string, any>;
  relationships?: { dex?: { data?: { id?: string } }; base_token?: { data?: { id?: string } } };
};

export function createTokenIntel(
  env: Env,
  logger: Logger,
  lookup: { get(address: string): Promise<AddressProfile> },
  deps: { chain?: ChainConfig; gecko?: GeckoTerminalClient; explorer?: BlockscoutExplorer | null; now?: () => number } = {},
) {
  const now = deps.now ?? Date.now;
  const chain = deps.chain ?? robinhoodChain(env);
  const net = env.GECKOTERMINAL_NETWORK;
  const gecko =
    deps.gecko ??
    new GeckoTerminalClient({
      baseUrl: env.GECKOTERMINAL_API_URL.replace(/\/+$/, ""),
      timeoutMs: env.GECKOTERMINAL_TIMEOUT_MS,
      retries: 2, // GeckoTerminal answers short bursts with 429 + Retry-After: 0; a quick retry succeeds
      ratePerMinute: env.GECKOTERMINAL_RATE_LIMIT_PER_MINUTE,
      ttlSeconds: { live: 60, pools: 60, meta: 3600 },
      staleMaxSeconds: env.MARKET_STALE_MAX_SECONDS,
    });
  const explorer =
    deps.explorer === null
      ? undefined
      : (deps.explorer ??
        (chain.explorerApiUrl
          ? new BlockscoutExplorer(chain.explorerApiUrl, {
              timeoutMs: env.ONCHAIN_RPC_TIMEOUT_MS,
              liveTtlMs: 60_000,
              stableTtlMs: 60_000, // holder counts move every minute on new tokens
              ...(chain.explorerApiKey ? { apiKey: chain.explorerApiKey } : {}),
            })
          : undefined));
  const cache = new TtlCache<unknown>(300);
  const inflight = new Map<string, Promise<unknown>>();
  const cached = async <T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit as T;
    let p = inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load()
        .then((v) => {
          cache.set(key, v, ttl);
          return v;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  };
  const gtBudget = (calls: number) => ({ signal: AbortSignal.timeout(TIMEOUT_MS), calls: 0, maxCalls: calls });
  const poolUrl = (address: string) => `https://www.geckoterminal.com/${encodeURIComponent(net)}/pools/${address}`;

  const toPool = (p: GtPool): PoolInfo | null => {
    const a = p.attributes ?? {};
    const address = String(a.address ?? "");
    if (!/^0x[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/.test(address)) return null;
    const name = clean(a.name, 60) ?? "Pool";
    const fee = feeOf(name);
    const liq = num(a.reserve_in_usd);
    const vol = num(a.volume_usd?.h24);
    const buys = num(a.transactions?.h24?.buys);
    const sells = num(a.transactions?.h24?.sells);
    const chg = num(a.price_change_percentage?.h24);
    const price = num(a.base_token_price_usd);
    const dex = clean(p.relationships?.dex?.data?.id, 40) ?? "dex";
    return {
      name,
      dex,
      address,
      ...(liq !== undefined ? { liquidityUsd: liq } : {}),
      ...(vol !== undefined ? { volume24hUsd: vol } : {}),
      ...(buys !== undefined ? { buys24h: buys } : {}),
      ...(sells !== undefined ? { sells24h: sells } : {}),
      ...(chg !== undefined ? { change24hPct: chg } : {}),
      ...(price !== undefined ? { priceUsd: price } : {}),
      ...(typeof a.pool_created_at === "string" ? { createdAt: a.pool_created_at } : {}),
      ...(fee !== undefined ? { feePct: fee } : {}),
      url: poolUrl(address),
    };
  };

  async function intel(address: string): Promise<TokenIntel> {
    const lower = address.toLowerCase();
    const budget = { signal: AbortSignal.timeout(TIMEOUT_MS), rpcCalls: 0, maxRpcCalls: 0, explorerCalls: 0, maxExplorerCalls: 4 };
    const [profile, gtToken, gtPools, holdersRes, bsToken, bsAddr] = await Promise.all([
      lookup.get(address).catch(() => undefined),
      gecko.get<{ data?: { attributes?: Record<string, any> } }>(`/networks/${encodeURIComponent(net)}/tokens/${lower}`, "pools", gtBudget(1)).catch(() => null),
      gecko.get<{ data?: GtPool[] }>(`/networks/${encodeURIComponent(net)}/tokens/${lower}/pools?page=1`, "pools", gtBudget(1)).catch(() => null),
      explorer ? explorer.tokenHolders(lower, budget).catch(() => null) : Promise.resolve(null),
      // Explorer fallbacks for when the RPC-backed profile is slow or down.
      explorer ? explorer.token(lower, budget).catch(() => null) : Promise.resolve(null),
      explorer ? explorer.address(lower, budget).catch(() => null) : Promise.resolve(null),
    ]);
    const holderCount = typeof profile?.token?.holders === "number" ? profile.token.holders : bsToken?.holders_count && /^\d+$/.test(bsToken.holders_count) ? Number(bsToken.holders_count) : undefined;
    const verifiedSrc = typeof profile?.verified === "boolean" ? profile.verified : typeof bsAddr?.is_verified === "boolean" ? bsAddr.is_verified : undefined;
    const scamFlag = Boolean(profile?.scam || bsAddr?.is_scam);
    if (profile && profile.kind !== "token" && !gtToken) {
      const e = new Error("not a token");
      e.name = "NotAToken";
      throw e;
    }
    const sources: string[] = [];
    const t = gtToken?.body.data?.attributes ?? {};
    if (gtToken) sources.push(`https://www.geckoterminal.com/${encodeURIComponent(net)}/tokens/${lower}`);
    if (profile?.url) sources.push(profile.url);

    // Pools: real liquidity first; the main pool is the deepest one.
    const pools = (gtPools?.body.data ?? [])
      .map(toPool)
      .filter((p): p is PoolInfo => p !== null)
      .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
      .slice(0, 12);
    if (pools[0] && (pools[0].liquidityUsd ?? 0) > 0) pools[0].main = true;
    const poolSet = new Set(pools.map((p) => p.address.toLowerCase()));

    // Holders: % of supply; pools, lockers and burn addresses are labelled and left out of the concentration figure.
    const supplyRaw = num(t.total_supply);
    let holders: TokenIntel["holders"];
    if (holdersRes?.items?.length && supplyRaw && supplyRaw > 0) {
      const top: HolderInfo[] = holdersRes.items.slice(0, 15).map((h) => {
        const a = h.address.hash.toLowerCase();
        const label = clean(h.address.name ?? h.address.public_tags?.[0]?.display_name ?? undefined, 40);
        const role: HolderInfo["role"] = BURN.has(a)
          ? "burn"
          : /locker|lock|vesting/i.test(label ?? "")
            ? "locker"
            : poolSet.has(a) || /poolmanager|pool|pair|vault/i.test(label ?? "")
              ? "pool"
              : undefined;
        return {
          address: toChecksumAddress(h.address.hash),
          ...(label ? { label } : {}),
          contract: Boolean(h.address.is_contract),
          pct: Math.round((Number(h.value) / supplyRaw) * 10_000) / 100,
          ...(role ? { role } : {}),
        };
      });
      const top10Pct = Math.round(top.filter((h) => !h.role).slice(0, 10).reduce((s, h) => s + h.pct, 0) * 100) / 100;
      holders = { top: top.slice(0, 10), top10Pct, note: "Top 10 holders excluding pools, lockers and burn addresses." };
    }

    const poolSum = pools.reduce((s, p) => s + (p.liquidityUsd ?? 0), 0);
    const liquidity = Math.max(num(t.total_reserve_in_usd) ?? 0, poolSum) || undefined;
    const lp = t.launchpad_details as { completed?: boolean; completed_at?: string; migrated_destination_pool_address?: string } | undefined;
    const market: TokenIntel["market"] = gtToken
      ? {
          ...(num(t.price_usd) !== undefined ? { priceUsd: num(t.price_usd)! } : {}),
          ...(num(t.fdv_usd) !== undefined ? { fdvUsd: num(t.fdv_usd)! } : {}),
          ...(liquidity !== undefined ? { liquidityUsd: liquidity } : {}),
          ...(num(t.volume_usd?.h24) !== undefined ? { volume24hUsd: num(t.volume_usd?.h24)! } : {}),
          ...(lp?.completed ? { graduated: { ...(lp.completed_at ? { at: lp.completed_at } : {}), ...(lp.migrated_destination_pool_address ? { pool: lp.migrated_destination_pool_address } : {}) } } : {}),
        }
      : undefined;

    // Signals — facts with a level, in plain words.
    const checks: Check[] = [];
    if (scamFlag) checks.push({ id: "scam", level: "risk", title: "Flagged by the explorer", detail: "The official explorer marks this address as a scam." });
    if (verifiedSrc === true) checks.push({ id: "verified", level: "ok", title: "Source code verified", detail: "The contract's source code is published and verified on the explorer." });
    else if (verifiedSrc === false) checks.push({ id: "verified", level: "warn", title: "Source code not verified", detail: "The contract's code is not published on the explorer, so it can't be read." });
    if (market?.graduated) checks.push({ id: "graduated", level: "ok", title: "Graduated from its launchpad", detail: `The launch completed${market.graduated.at ? ` on ${market.graduated.at.slice(0, 10)}` : ""} and liquidity moved to a DEX pool.` });
    const main = pools.find((p) => p.main);
    if (!main) checks.push({ id: "liquidity", level: "risk", title: "No pool with liquidity found", detail: "GeckoTerminal lists no pool with liquidity for this token on Robinhood Chain." });
    else {
      const l = main.liquidityUsd ?? 0;
      checks.push({
        id: "liquidity",
        level: l >= 50_000 ? "ok" : l >= 5_000 ? "info" : "warn",
        title: `Main pool liquidity: ${usd(l)}`,
        detail: `${main.name} on ${main.dex}. ${l < 5_000 ? "Low liquidity: small trades can move the price a lot." : "This is the pool to compare prices against."}`,
      });
    }
    const highFee = pools.filter((p) => (p.feePct ?? 0) >= 10);
    if (highFee.length)
      checks.push({
        id: "fees",
        level: "warn",
        title: `${highFee.length} pool${highFee.length > 1 ? "s" : ""} with a very high fee`,
        detail: `${highFee.map((p) => `${p.name}`).slice(0, 4).join(", ")}. A ${Math.max(...highFee.map((p) => p.feePct!))}% fee takes most of a trade; these are usually not the token's real market.`,
      });
    const tiny = pools.filter((p) => !p.main && (p.liquidityUsd ?? 0) < 100);
    if (tiny.length)
      checks.push({ id: "side-pools", level: "info", title: `${tiny.length} side pool${tiny.length > 1 ? "s" : ""} under $100 liquidity`, detail: "Prices and charts on these pools are unreliable; some trackers may show one of them instead of the main pool." });
    if (holders) {
      const c = holders.top10Pct;
      checks.push({
        id: "holders",
        level: c < 30 ? "ok" : c < 50 ? "info" : c < 70 ? "warn" : "risk",
        title: `Top 10 holders own ${c}%`,
        detail: `${holders.note} ${c >= 50 ? "Supply is concentrated in a few wallets." : "Supply is spread across holders."}`,
      });
    }
    if (holderCount !== undefined) checks.push({ id: "holder-count", level: "info", title: `${holderCount.toLocaleString("en-US")} holders`, detail: "Addresses holding a balance, as counted by the explorer." });
    const firstPool = pools.map((p) => p.createdAt).filter((s): s is string => Boolean(s)).sort()[0];
    if (firstPool) {
      const hours = (now() - Date.parse(firstPool)) / 3_600_000;
      if (hours < 72) checks.push({ id: "age", level: "info", title: `New token: first pool ${hours < 1 ? "under an hour" : `${Math.round(hours)}h`} old`, detail: "Young tokens move fast and have little history to judge by." });
    }
    const order: Record<Level, number> = { risk: 0, warn: 1, info: 2, ok: 3 };
    checks.sort((a, b) => order[a.level] - order[b.level]);

    return {
      address: toChecksumAddress(address),
      chain: { name: chain.name, chainId: chain.chainId },
      token: {
        ...((clean(t.name) ?? profile?.token?.name) ? { name: clean(t.name) ?? profile?.token?.name } : {}),
        ...((clean(t.symbol, 20) ?? profile?.token?.symbol) ? { symbol: clean(t.symbol, 20) ?? profile?.token?.symbol } : {}),
        ...(holderCount !== undefined ? { holders: holderCount } : {}),
        ...(profile?.token?.totalSupply ? { totalSupply: profile.token.totalSupply } : {}),
      },
      ...(verifiedSrc !== undefined ? { verified: verifiedSrc } : {}),
      ...(market ? { market } : {}),
      pools,
      ...(holders ? { holders } : {}),
      checks,
      sources,
      generatedAt: new Date(now()).toISOString(),
    };
  }

  async function radar(): Promise<{ trending: RadarPool[]; fresh: RadarPool[]; generatedAt: string }> {
    const [tr, nw] = await Promise.all([
      gecko.get<{ data?: GtPool[] }>(`/networks/${encodeURIComponent(net)}/trending_pools?page=1`, "pools", gtBudget(1)).catch(() => null),
      gecko.get<{ data?: GtPool[] }>(`/networks/${encodeURIComponent(net)}/new_pools?page=1`, "pools", gtBudget(1)).catch(() => null),
    ]);
    if (!tr && !nw) throw new Error("radar unavailable");
    const map = (list: GtPool[] | undefined, minLiq: number) =>
      (list ?? [])
        .map((p): RadarPool | null => {
          const pool = toPool(p);
          const id = p.relationships?.base_token?.data?.id ?? "";
          const tokenAddress = id.slice(id.indexOf("_") + 1);
          if (!pool || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) return null;
          if ((pool.liquidityUsd ?? 0) < minLiq || (pool.feePct ?? 0) >= 10) return null;
          return { ...pool, token: { address: toChecksumAddress(tokenAddress), ...(clean(pool.name.split("/")[0], 20) ? { symbol: clean(pool.name.split("/")[0], 20)! } : {}) } };
        })
        .filter((p): p is RadarPool => p !== null)
        .slice(0, 10);
    return { trending: map(tr?.body.data, 1_000), fresh: map(nw?.body.data, 0), generatedAt: new Date(now()).toISOString() };
  }

  /** The token's main pool (deepest liquidity), from the cached intel. */
  async function mainPool(address: string) {
    const t = (await cached(`tok:${address.toLowerCase()}`, TOKEN_TTL_MS, () => intel(address))) as TokenIntel;
    const p = t.pools.find((x) => x.main);
    if (!p) {
      const e = new Error("no pool");
      e.name = "NoPool";
      throw e;
    }
    return { info: { name: p.name, address: p.address, dex: p.dex, url: p.url }, liquidity: p.liquidityUsd ?? 0, token: t.address.toLowerCase() };
  }

  async function chart(address: string, tf: Timeframe): Promise<Chart> {
    const { info } = await mainPool(address);
    const [unit, agg, limit] = TIMEFRAMES[tf];
    const res = await gecko.get<{ data?: { attributes?: { ohlcv_list?: unknown[][] } } }>(
      `/networks/${encodeURIComponent(net)}/pools/${info.address}/ohlcv/${unit}?aggregate=${agg}&limit=${limit}&currency=usd&token=base`,
      "live",
      gtBudget(1),
    );
    const candles = (res?.body.data?.attributes?.ohlcv_list ?? [])
      .map((r) => r.map(Number))
      .filter((r) => r.length >= 6 && r.every(Number.isFinite) && r[1]! > 0)
      .map((r) => [r[0], r[1], r[2], r[3], r[4], r[5]] as [number, number, number, number, number, number])
      .sort((a, b) => a[0] - b[0]);
    return { pool: info, tf, candles, generatedAt: new Date(now()).toISOString() };
  }

  async function trades(address: string): Promise<Trades> {
    const { info, liquidity, token } = await mainPool(address);
    const res = await gecko.get<{ data?: { attributes?: Record<string, any> }[] }>(`/networks/${encodeURIComponent(net)}/pools/${info.address}/trades`, "live", gtBudget(1));
    // "Whale": a single trade worth at least 2% of the pool's liquidity (and $100+).
    const whaleUsd = Math.max(100, Math.round(liquidity * 0.02));
    const all = (res?.body.data ?? [])
      .map((d): Trade | null => {
        const a = d.attributes ?? {};
        const kind = a.kind === "buy" || a.kind === "sell" ? a.kind : null;
        const usdV = num(a.volume_in_usd);
        const wallet = String(a.tx_from_address ?? "");
        const tx = String(a.tx_hash ?? "");
        if (!kind || usdV === undefined || !/^0x[0-9a-fA-F]{40}$/.test(wallet) || !/^0x[0-9a-fA-F]{64}$/.test(tx) || typeof a.block_timestamp !== "string") return null;
        const amount = num(kind === "buy" ? a.to_token_amount : a.from_token_amount) ?? 0;
        const tokenSide = String(kind === "buy" ? a.to_token_address : a.from_token_address).toLowerCase();
        const price = num(kind === "buy" ? a.price_to_in_usd : a.price_from_in_usd);
        return {
          kind,
          usd: usdV,
          amount: tokenSide === token ? amount : 0,
          ...(price !== undefined && tokenSide === token ? { priceUsd: price } : {}),
          wallet: toChecksumAddress(wallet),
          time: a.block_timestamp,
          tx,
          ...(chain.explorerUrl ? { url: `${chain.explorerUrl}/tx/${tx}` } : {}),
          ...(usdV >= whaleUsd ? { whale: true } : {}),
        };
      })
      .filter((t): t is Trade => t !== null)
      .sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
    const buys = all.filter((t) => t.kind === "buy"), sells = all.filter((t) => t.kind === "sell");
    const sum = (l: Trade[]) => Math.round(l.reduce((s, t) => s + t.usd, 0) * 100) / 100;
    return {
      pool: info,
      trades: all.slice(0, 25),
      summary: { buys: buys.length, sells: sells.length, buyUsd: sum(buys), sellUsd: sum(sells), wallets: new Set(all.map((t) => t.wallet)).size, ...(all.length ? { since: all[all.length - 1]!.time } : {}), whaleUsd },
      generatedAt: new Date(now()).toISOString(),
    };
  }

  /** Newest pools on the chain, each with a quick, sourced safety read (GeckoTerminal + the explorer). */
  async function launches(): Promise<{ launches: Launch[]; generatedAt: string }> {
    const res = await gecko.get<{ data?: GtPool[]; included?: { id?: string; attributes?: Record<string, any> }[] }>(
      `/networks/${encodeURIComponent(net)}/new_pools?page=1&include=base_token`,
      "pools",
      gtBudget(1),
    );
    if (!res) throw new Error("launches unavailable");
    const meta = new Map((res.body.included ?? []).map((t) => [String(t.id ?? ""), t.attributes ?? {}]));
    const seen = new Set<string>();
    const picked: { pool: PoolInfo; a: Record<string, any>; token: string; tm: Record<string, any> }[] = [];
    for (const p of res.body.data ?? []) {
      const pool = toPool(p);
      const id = p.relationships?.base_token?.data?.id ?? "";
      const token = id.slice(id.indexOf("_") + 1).toLowerCase();
      if (!pool || !/^0x[0-9a-f]{40}$/.test(token) || seen.has(token)) continue;
      seen.add(token);
      picked.push({ pool, a: p.attributes ?? {}, token, tm: meta.get(id) ?? {} });
      if (picked.length >= 12) break;
    }
    // Explorer facts, a few at a time (rate limits); a failure only drops those facts.
    const facts = new Map<string, { verified?: boolean; scam?: boolean; holders?: number }>();
    if (explorer) {
      const budget = { signal: AbortSignal.timeout(25_000), rpcCalls: 0, maxRpcCalls: 0, explorerCalls: 0, maxExplorerCalls: 4 * picked.length };
      // The explorer allows ~5 requests/s: two tokens (four calls) at a time, one retry on a failed call.
      const once = async <T>(fn: () => Promise<T | null>): Promise<T | null> => {
        try {
          return await fn();
        } catch {
          await new Promise((r) => setTimeout(r, 600));
          return fn().catch(() => null);
        }
      };
      // A small worker pool keeps ~5 explorer calls in flight (its rate limit) instead of waiting batch by batch.
      const jobs = picked.flatMap(({ token }) => [
        { token, kind: "address" as const, run: () => explorer.address(token, budget) },
        { token, kind: "token" as const, run: () => explorer.token(token, budget) },
      ]);
      const got = new Map<string, { address?: Awaited<ReturnType<BlockscoutExplorer["address"]>>; token?: Awaited<ReturnType<BlockscoutExplorer["token"]>> }>();
      let next = 0;
      await Promise.all(
        Array.from({ length: 5 }, async () => {
          while (next < jobs.length) {
            const job = jobs[next++]!;
            const res = await once(job.run as () => Promise<any>);
            const slot = got.get(job.token) ?? {};
            if (job.kind === "address") slot.address = res; else slot.token = res;
            got.set(job.token, slot);
          }
        }),
      );
      for (const { token } of picked) {
        const g = got.get(token) ?? {};
        facts.set(token, {
          ...(typeof g.address?.is_verified === "boolean" ? { verified: g.address.is_verified } : {}),
          ...(g.address?.is_scam ? { scam: true } : {}),
          ...(g.token?.holders_count && /^\d+$/.test(g.token.holders_count) ? { holders: Number(g.token.holders_count) } : {}),
        });
      }
    }
    const order: Record<Level, number> = { risk: 0, warn: 1, info: 2, ok: 3 };
    const launches = picked.map(({ pool, a, token, tm }): Launch => {
      const fx = facts.get(token) ?? {};
      const buys = num(a.transactions?.h1?.buys), sells = num(a.transactions?.h1?.sells), liq = pool.liquidityUsd ?? 0;
      const flags: Launch["flags"] = [];
      if (fx.scam) flags.push({ level: "risk", text: "Flagged as a scam by the explorer" });
      if ((pool.feePct ?? 0) >= 10) flags.push({ level: "risk", text: `${pool.feePct}% pool fee` });
      if (liq < 1_000) flags.push({ level: "risk", text: `Very low liquidity (${usd(liq)})` });
      else if (liq < 5_000) flags.push({ level: "warn", text: `Low liquidity (${usd(liq)})` });
      if (fx.verified === false) flags.push({ level: "warn", text: "Source code not verified" });
      if ((buys ?? 0) >= 5 && (sells ?? 0) === 0) flags.push({ level: "warn", text: "No sells yet in the last hour" });
      if (fx.holders !== undefined && fx.holders < 25) flags.push({ level: "info", text: `${fx.holders} holders` });
      if (/pons-v2$|launch/i.test(pool.dex)) flags.push({ level: "info", text: "Still on its launchpad" });
      if (fx.verified === true) flags.push({ level: "ok", text: "Source code verified" });
      if (!flags.length) flags.push({ level: "info", text: "No red flags found in the quick check" });
      flags.sort((x, y) => order[x.level] - order[y.level]);
      return {
        token: { address: toChecksumAddress(token), ...(clean(tm.symbol, 20) ? { symbol: clean(tm.symbol, 20)! } : {}), ...(clean(tm.name, 40) ? { name: clean(tm.name, 40)! } : {}) },
        pool: {
          name: pool.name, dex: pool.dex, address: pool.address, url: pool.url,
          ...(pool.createdAt ? { createdAt: pool.createdAt } : {}),
          ...(pool.liquidityUsd !== undefined ? { liquidityUsd: pool.liquidityUsd } : {}),
          ...(buys !== undefined ? { buys1h: buys } : {}),
          ...(sells !== undefined ? { sells1h: sells } : {}),
          ...(pool.feePct !== undefined ? { feePct: pool.feePct } : {}),
        },
        ...(fx.holders !== undefined ? { holders: fx.holders } : {}),
        ...(fx.verified !== undefined ? { verified: fx.verified } : {}),
        flags,
        level: flags[0]!.level,
      };
    });
    return { launches, generatedAt: new Date(now()).toISOString() };
  }

  return {
    launches: () => cached("launches", 90_000, launches),
    chart: (address: string, tf: Timeframe) => cached(`chart:${address.toLowerCase()}:${tf}`, 120_000, () => chart(address, tf)),
    trades: (address: string) => cached(`trades:${address.toLowerCase()}`, 30_000, () => trades(address)),
    get: (address: string) => cached(`tok:${address.toLowerCase()}`, TOKEN_TTL_MS, () => intel(address)),
    radar: () => cached("radar", RADAR_TTL_MS, radar),
    _log: logger,
  };
}

export function tokenRoutes(env: Env, limiter: ClientRateLimiter, intel: ReturnType<typeof createTokenIntel>): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  const limited = (c: Parameters<typeof clientKey>[0]) => {
    if (!rateLimitEnabled(env)) return null;
    const v = limiter.take("token", clientKey(c, env), PER_MINUTE);
    return v.ok ? null : tooManyRequests(c, v.retryAfterMs);
  };
  app.get("/api/token/:address", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!env.MARKET_ENABLED && !env.ONCHAIN_ENABLED) return c.json({ error: { kind: "unavailable", message: "Market data is turned off." } }, 503);
    const check = validateAddress(c.req.param("address").trim());
    if (!check.ok) return c.json({ error: { kind: "validation", message: "That is not a valid token address." } }, 400);
    const block = limited(c);
    if (block) return block;
    try {
      const body = await intel.get(check.address);
      // Public data, same for everyone: let the CDN serve repeats so GeckoTerminal sees ~1 call per minute.
      c.header("Cache-Control", "public, max-age=15, s-maxage=60, stale-while-revalidate=240");
      return c.json(body);
    } catch (err) {
      if (err instanceof Error && err.name === "NotAToken") return c.json({ error: { kind: "validation", message: "This address is not a token." } }, 400);
      intel._log.warn("token intel failed", { error: err instanceof Error ? err.name : "error" });
      return c.json({ error: { kind: "upstream", message: "Token data could not be read right now. Try again in a moment." } }, 502);
    }
  });
  const sub = (kind: "chart" | "trades") => async (c: any) => {
    c.header("Cache-Control", "no-store");
    if (!env.MARKET_ENABLED) return c.json({ error: { kind: "unavailable", message: "Market data is turned off." } }, 503);
    const check = validateAddress(String(c.req.param("address")).trim());
    if (!check.ok) return c.json({ error: { kind: "validation", message: "That is not a valid token address." } }, 400);
    const tf = (c.req.query("tf") ?? "1h") as Timeframe;
    if (kind === "chart" && !(tf in TIMEFRAMES)) return c.json({ error: { kind: "validation", message: "Timeframe must be 15m, 1h, 4h or 1d." } }, 400);
    const block = limited(c);
    if (block) return block;
    try {
      const body = kind === "chart" ? await intel.chart(check.address, tf) : await intel.trades(check.address);
      c.header("Cache-Control", kind === "chart" ? "public, max-age=15, s-maxage=60, stale-while-revalidate=240" : "public, max-age=10, s-maxage=20, stale-while-revalidate=60");
      return c.json(body);
    } catch (err) {
      if (err instanceof Error && (err.name === "NoPool" || err.name === "NotAToken")) return c.json({ error: { kind: "not_found", message: "No pool with liquidity for this token yet." } }, 404);
      const busy = (err as { kind?: string })?.kind === "rate_limit";
      intel._log.warn("token " + kind + " failed", { error: err instanceof Error ? err.name : "error", busy });
      return busy
        ? c.json({ error: { kind: "rate_limit", message: "Market data is busy right now. Try again in a few seconds." } }, 503)
        : c.json({ error: { kind: "upstream", message: "Market data could not be read right now. Try again in a moment." } }, 502);
    }
  };
  app.get("/api/token/:address/chart", sub("chart"));
  app.get("/api/token/:address/trades", sub("trades"));
  app.get("/api/launches", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!env.MARKET_ENABLED) return c.json({ error: { kind: "unavailable", message: "Market data is turned off." } }, 503);
    const block = limited(c);
    if (block) return block;
    try {
      const body = await intel.launches();
      c.header("Cache-Control", "public, max-age=15, s-maxage=60, stale-while-revalidate=240");
      return c.json(body);
    } catch {
      return c.json({ error: { kind: "upstream", message: "New launches could not be loaded right now." } }, 502);
    }
  });
  app.get("/api/radar", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!env.MARKET_ENABLED) return c.json({ error: { kind: "unavailable", message: "Market data is turned off." } }, 503);
    const block = limited(c);
    if (block) return block;
    try {
      const body = await intel.radar();
      c.header("Cache-Control", "public, max-age=15, s-maxage=60, stale-while-revalidate=240");
      return c.json(body);
    } catch {
      return c.json({ error: { kind: "upstream", message: "The radar could not be loaded right now." } }, 502);
    }
  });
  return app;
}
