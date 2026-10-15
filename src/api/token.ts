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
      retries: 0,
      ratePerMinute: Math.min(12, env.GECKOTERMINAL_RATE_LIMIT_PER_MINUTE),
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
              stableTtlMs: 300_000,
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
    const budget = { signal: AbortSignal.timeout(TIMEOUT_MS), rpcCalls: 0, maxRpcCalls: 0, explorerCalls: 0, maxExplorerCalls: 2 };
    const [profile, gtToken, gtPools, holdersRes] = await Promise.all([
      lookup.get(address).catch(() => undefined),
      gecko.get<{ data?: { attributes?: Record<string, any> } }>(`/networks/${encodeURIComponent(net)}/tokens/${lower}`, "pools", gtBudget(1)).catch(() => null),
      gecko.get<{ data?: GtPool[] }>(`/networks/${encodeURIComponent(net)}/tokens/${lower}/pools?page=1`, "pools", gtBudget(1)).catch(() => null),
      explorer ? explorer.tokenHolders(lower, budget).catch(() => null) : Promise.resolve(null),
    ]);
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
    if (profile?.scam) checks.push({ id: "scam", level: "risk", title: "Flagged by the explorer", detail: "The official explorer marks this address as a scam." });
    if (profile?.verified === true) checks.push({ id: "verified", level: "ok", title: "Source code verified", detail: "The contract's source code is published and verified on the explorer." });
    else if (profile?.verified === false) checks.push({ id: "verified", level: "warn", title: "Source code not verified", detail: "The contract's code is not published on the explorer, so it can't be read." });
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
    if (typeof profile?.token?.holders === "number") checks.push({ id: "holder-count", level: "info", title: `${profile.token.holders.toLocaleString("en-US")} holders`, detail: "Addresses holding a balance, as counted by the explorer." });
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
        ...(typeof profile?.token?.holders === "number" ? { holders: profile.token.holders } : {}),
        ...(profile?.token?.totalSupply ? { totalSupply: profile.token.totalSupply } : {}),
      },
      ...(typeof profile?.verified === "boolean" ? { verified: profile.verified } : {}),
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

  return {
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
      return c.json(await intel.get(check.address));
    } catch (err) {
      if (err instanceof Error && err.name === "NotAToken") return c.json({ error: { kind: "validation", message: "This address is not a token." } }, 400);
      intel._log.warn("token intel failed", { error: err instanceof Error ? err.name : "error" });
      return c.json({ error: { kind: "upstream", message: "Token data could not be read right now. Try again in a moment." } }, 502);
    }
  });
  app.get("/api/radar", async (c) => {
    c.header("Cache-Control", "public, max-age=30");
    if (!env.MARKET_ENABLED) return c.json({ error: { kind: "unavailable", message: "Market data is turned off." } }, 503);
    const block = limited(c);
    if (block) return block;
    try {
      return c.json(await intel.radar());
    } catch {
      return c.json({ error: { kind: "upstream", message: "The radar could not be loaded right now." } }, 502);
    }
  });
  return app;
}
