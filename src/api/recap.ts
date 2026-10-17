import { Hono } from "hono";
import { TtlCache } from "../cache/ttl-cache.js";
import { robinhoodChain, type ChainConfig } from "../config/chains.js";
import { rateLimitEnabled, type Env } from "../config/env.js";
import type { Logger } from "../core/logger.js";
import { toChecksumAddress, validateAddress } from "../providers/blockchain/evm.js";
import { BlockscoutExplorer, type BsTokenTransfer, type BsTransaction } from "../providers/blockchain/explorer.js";
import type { ClientRateLimiter } from "../security/rate-limit.js";
import { clientKey, tooManyRequests, type AppVariables } from "./http-guards.js";
import { again } from "./launch-safety.js";
import { WETH, type PriceRow } from "./portfolio.js";

/**
 * GET /api/recap/:address — a wallet's last 7 days from the explorer: activity, fees,
 * ETH in/out, and each token moved in and out (valued at today's price). Very busy
 * wallets are read up to a page limit and the recap says how far back it reaches.
 */
const DAYS = 7;
const MAX_PAGES = 6; // 50 items per page, per list
const TTL_MS = 120_000;
const PER_MINUTE = 10;
const MIN_TRUSTED_LIQUIDITY = 1_000;

export interface RecapToken {
  address: string;
  symbol?: string;
  in: number;
  out: number;
  transfersIn: number;
  transfersOut: number;
  priceUsd?: number;
  netUsd?: number;
}
export interface Recap {
  address: string;
  since: string;
  until: string;
  /** False when the wallet had more activity than the pages read; `coveredSince` says how far back the recap reaches. */
  complete: boolean;
  coveredSince: string;
  txs: number;
  sent: number;
  failed: number;
  activeDays: number;
  busiestDay?: { date: string; txs: number };
  feesEth: number;
  feesUsd?: number;
  ethIn: number;
  ethOut: number;
  /** Transactions where the wallet both gave and got tokens or ETH. */
  swaps: number;
  tokens: RecapToken[];
  topContracts: { address: string; label?: string; txs: number }[];
  ethPriceUsd?: number;
  /** False when the price lookup itself failed (so missing values mean "unknown", not "thin market"). */
  priced: boolean;
  generatedAt: string;
}

const units = (raw: string | null | undefined, decimals: string | number | null | undefined): number => {
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const d = Number(decimals ?? 18);
  return Number(raw) / 10 ** (Number.isFinite(d) ? d : 18);
};
const r = (n: number, p = 6) => Math.round(n * 10 ** p) / 10 ** p;
const INVISIBLE = new RegExp("[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\ufeff]", "g");
const clean = (s: unknown, max = 40) => String(s ?? "").replace(INVISIBLE, " ").trim().slice(0, max) || undefined;

export function createRecap(
  env: Env,
  logger: Logger,
  prices: (tokens: string[]) => Promise<Record<string, PriceRow>>,
  deps: { chain?: ChainConfig; explorer?: BlockscoutExplorer | null; now?: () => number } = {},
) {
  const now = deps.now ?? Date.now;
  const chain = deps.chain ?? robinhoodChain(env);
  const explorer =
    deps.explorer === null
      ? undefined
      : (deps.explorer ??
        (chain.explorerApiUrl
          ? new BlockscoutExplorer(chain.explorerApiUrl, {
              timeoutMs: env.ONCHAIN_RPC_TIMEOUT_MS,
              liveTtlMs: 60_000,
              stableTtlMs: 60_000,
              ...(chain.explorerApiKey ? { apiKey: chain.explorerApiKey } : {}),
            })
          : undefined));
  const cache = new TtlCache<Recap>(200);
  const inflight = new Map<string, Promise<Recap>>();

  /** Newest-first pages until an item is older than `since` or the page limit is hit. */
  async function walk<T extends { timestamp: string | null }>(
    load: (after: Record<string, unknown> | null) => Promise<{ items?: T[]; next_page_params?: Record<string, unknown> | null } | null>,
    since: number,
  ): Promise<{ items: T[]; complete: boolean }> {
    const items: T[] = [];
    let after: Record<string, unknown> | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      let res: Awaited<ReturnType<typeof load>>;
      try {
        res = await again(() => load(after));
      } catch (err) {
        if (page === 0) throw err;
        return { items, complete: false }; // a slow later page: report what was read, marked partial
      }
      for (const it of res?.items ?? []) {
        const t = it.timestamp ? Date.parse(it.timestamp) : NaN;
        if (Number.isFinite(t) && t < since) return { items, complete: true };
        items.push(it);
      }
      after = res?.next_page_params ?? null;
      if (!after) return { items, complete: true };
    }
    return { items, complete: false };
  }

  async function recap(address: string): Promise<Recap> {
    if (!explorer) throw new Error("explorer unavailable");
    const w = address.toLowerCase();
    const until = now(), since = until - DAYS * 86_400_000;
    const budget = () => ({ signal: AbortSignal.timeout(20_000), rpcCalls: 0, maxRpcCalls: 0, explorerCalls: 0, maxExplorerCalls: MAX_PAGES * 2 });
    const tb = budget(), fb = budget();
    const [txs, moves] = await Promise.all([
      walk<BsTransaction>((after) => explorer.addressTransactionsPage(w, after, tb), since),
      walk<BsTokenTransfer>((after) => explorer.addressTokenTransfersPage(w, after, fb), since),
    ]);
    // When a list was cut short, only claim what both lists fully cover.
    const oldest = (xs: { timestamp: string | null }[]) => xs.reduce((m, x) => Math.min(m, x.timestamp ? Date.parse(x.timestamp) : m), until);
    const coveredSince = Math.max(since, txs.complete ? since : oldest(txs.items), moves.complete ? since : oldest(moves.items));
    const inRange = (x: { timestamp: string | null }) => (x.timestamp ? Date.parse(x.timestamp) >= coveredSince : false);
    const tx = txs.items.filter(inRange), mv = moves.items.filter(inRange);

    let sent = 0, failed = 0, feesWei = 0, ethIn = 0, ethOut = 0;
    const perDay = new Map<string, number>(), contracts = new Map<string, { label?: string; txs: number }>();
    const gave = new Map<string, boolean>(), got = new Map<string, boolean>();
    for (const t of tx) {
      const day = t.timestamp!.slice(0, 10);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
      const fromMe = t.from.hash.toLowerCase() === w, toMe = t.to?.hash.toLowerCase() === w;
      const v = units(t.value, 18);
      if (fromMe) {
        sent++;
        if (t.status && t.status !== "ok") failed++;
        feesWei += Number(t.fee?.value ?? 0) || 0;
        if (v > 0 && t.status === "ok") { ethOut += v; gave.set(t.hash, true); }
        if (t.to && t.to.is_contract !== false && !toMe) {
          const k = t.to.hash.toLowerCase(), c = contracts.get(k) ?? { ...(clean(t.to.name) ? { label: clean(t.to.name)! } : {}), txs: 0 };
          c.txs++;
          contracts.set(k, c);
        }
      } else if (toMe && v > 0 && t.status === "ok") { ethIn += v; got.set(t.hash, true); }
    }
    const tokens = new Map<string, RecapToken>();
    for (const m of mv) {
      if (m.token.type !== "ERC-20") continue;
      const a = m.token.address_hash.toLowerCase();
      const row = tokens.get(a) ?? { address: toChecksumAddress(a), ...(clean(m.token.symbol, 16) ? { symbol: clean(m.token.symbol, 16)! } : {}), in: 0, out: 0, transfersIn: 0, transfersOut: 0 };
      const v = units(m.total?.value, m.total?.decimals ?? m.token.decimals);
      const from = m.from.hash.toLowerCase(), to = m.to.hash.toLowerCase();
      if (to === w && from !== w) { row.in += v; row.transfersIn++; got.set(m.transaction_hash, true); }
      else if (from === w && to !== w) { row.out += v; row.transfersOut++; gave.set(m.transaction_hash, true); }
      tokens.set(a, row);
    }
    const swaps = [...gave.keys()].filter((h) => got.has(h)).length;

    const list = [...tokens.values()];
    let priced = true;
    const px = await prices([WETH, ...list.map((t) => t.address)].slice(0, 30)).catch(() => ((priced = false), {} as Record<string, PriceRow>));
    const trusted = (p?: PriceRow) => (p?.priceUsd !== undefined && (p.liquidityUsd ?? 0) >= MIN_TRUSTED_LIQUIDITY ? p.priceUsd : undefined);
    for (const t of list) {
      const p = trusted(px[t.address.toLowerCase()]);
      t.in = r(t.in); t.out = r(t.out);
      if (p !== undefined) { t.priceUsd = p; t.netUsd = Math.round((t.in - t.out) * p * 100) / 100; }
    }
    list.sort((a, b) => Math.abs(b.netUsd ?? 0) - Math.abs(a.netUsd ?? 0) || b.transfersIn + b.transfersOut - (a.transfersIn + a.transfersOut));
    const eth = px[WETH]?.priceUsd;
    const feesEth = feesWei / 1e18;
    const busiest = [...perDay.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      address: toChecksumAddress(w),
      since: new Date(since).toISOString(),
      until: new Date(until).toISOString(),
      complete: coveredSince === since,
      coveredSince: new Date(coveredSince).toISOString(),
      txs: tx.length,
      sent,
      failed,
      activeDays: perDay.size,
      ...(busiest ? { busiestDay: { date: busiest[0], txs: busiest[1] } } : {}),
      feesEth: r(feesEth, 8),
      ...(eth !== undefined ? { feesUsd: Math.round(feesEth * eth * 100) / 100, ethPriceUsd: eth } : {}),
      ethIn: r(ethIn),
      ethOut: r(ethOut),
      swaps,
      tokens: list.slice(0, 12),
      topContracts: [...contracts.entries()]
        .sort((a, b) => b[1].txs - a[1].txs)
        .slice(0, 5)
        .map(([a, c]) => ({ address: toChecksumAddress(a), ...c })),
      priced,
      generatedAt: new Date(until).toISOString(),
    };
  }

  return {
    get(address: string): Promise<Recap> {
      const key = address.toLowerCase();
      const hit = cache.get(key);
      if (hit) return Promise.resolve(hit);
      let p = inflight.get(key);
      if (!p) {
        p = recap(address)
          .then((v) => (cache.set(key, v, TTL_MS), v))
          .finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      return p;
    },
    logger,
  };
}

export function recapRoutes(env: Env, limiter: ClientRateLimiter, rc: ReturnType<typeof createRecap>): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.get("/api/recap/:address", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!env.ONCHAIN_ENABLED) return c.json({ error: { kind: "unavailable", message: "On-chain data is turned off." } }, 503);
    const check = validateAddress(c.req.param("address").trim());
    if (!check.ok) return c.json({ error: { kind: "validation", message: "That is not a valid wallet address." } }, 400);
    if (rateLimitEnabled(env)) {
      const v = limiter.take("recap", clientKey(c, env), PER_MINUTE);
      if (!v.ok) return tooManyRequests(c, v.retryAfterMs);
    }
    try {
      const body = await rc.get(check.address);
      c.header("Cache-Control", "public, max-age=60, s-maxage=120, stale-while-revalidate=600");
      return c.json(body);
    } catch (err) {
      rc.logger.warn("recap failed", { error: err instanceof Error ? err.name : "error" });
      return c.json({ error: { kind: "upstream", message: "This wallet's week could not be read right now. Try again in a moment." } }, 502);
    }
  });
  return app;
}
