import { toVeyraError, VeyraError } from "../../core/errors.js";
import type { Entities } from "../../router/intent.js";
import { toChecksumAddress, validateAddress } from "../blockchain/evm.js";
import type { Fetched, GeckoTerminalClient, MarketBudget } from "./geckoterminal.js";

// ── Question → plan ──────────────────────────────────────────────────────────

export interface MarketQuery {
  kind: "address" | "symbol" | "overview";
  addresses: string[];
  symbol?: string;
  wants: { history: boolean; trades: boolean };
  timeframe: "day" | "hour";
  invalid: { value: string; reason: string }[];
}

const NOT_SYMBOLS = new Set(["USD", "THE", "AND", "PRICE", "TOKEN", "POOL", "WHAT", "SHOW", "ETH?", "DEX", "TVL", "FDV", "API", "AI", "TODAY", "OHLCV"]);

export function planMarketQuery(question: string, entities: Entities, maxTargets: number): MarketQuery {
  const invalid: MarketQuery["invalid"] = [];
  const addresses: string[] = [];
  for (const raw of [...new Set([...question.matchAll(/(?<![0-9a-zA-Z])0x[0-9a-fA-F]{40}(?![0-9a-zA-Z])/g)].map((m) => m[0]))]) {
    const v = validateAddress(raw);
    if (v.ok) addresses.push(v.address);
    else invalid.push({ value: raw, reason: v.reason });
  }
  // Entities are lower-cased: don't let a checksum-invalid address from the text slip back in that way.
  const rejected = new Set(invalid.map((i) => i.value.toLowerCase()));
  for (const a of entities.addresses) {
    const v = validateAddress(a);
    if (v.ok && !rejected.has(a.toLowerCase()) && !addresses.some((x) => x.toLowerCase() === v.address.toLowerCase())) addresses.push(v.address);
  }
  const symbolMatch =
    entities.tickers[0] ??
    /\b(?:price|liquidity|volume|chart|market cap|fdv|pools?) (?:of|for) \$?([A-Z][A-Z0-9]{1,9})\b/.exec(question)?.[1] ??
    /\b\$?([A-Z][A-Z0-9]{1,9}) (?:price|liquidity|volume|token|pools?)\b/.exec(question)?.[1];
  const symbol = symbolMatch && !NOT_SYMBOLS.has(symbolMatch.toUpperCase()) ? symbolMatch.toUpperCase() : undefined;

  const wants = {
    history: /\b(today|todays|chart|history|historical|ohlcv?|candles?|trend|this week|past \d+ (days|hours)|last \d+ (days|hours)|performance|happened|moved?|movement|change[ds]?|24 ?h)\b/i.test(question),
    trades: /\b(trades?|buys?|sells?|buyers|sellers|swaps?|recent transactions|activity|happened|whales?)\b/i.test(question),
  };
  const hourly = /\b(today|todays|24 ?h|hour|hourly|right now|last few hours|intraday)\b/i.test(question);
  return {
    kind: addresses.length ? "address" : symbol ? "symbol" : "overview",
    addresses: addresses.slice(0, maxTargets),
    ...(symbol ? { symbol } : {}),
    wants,
    timeframe: hourly ? "hour" : "day",
    invalid,
  };
}

// ── Validation (malformed API data never reaches the model as a fact) ────────

export class Validator {
  dropped = 0;
  num(v: unknown, opts: { min?: number; max?: number } = {}): number | undefined {
    if (v === null || v === undefined || v === "") return undefined;
    const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v.trim()) ? Number(v) : NaN;
    if (!Number.isFinite(n) || (opts.min !== undefined && n < opts.min) || (opts.max !== undefined && n > opts.max)) {
      this.dropped++;
      return undefined;
    }
    return n;
  }
  /** Prices, liquidity, volume: finite, non-negative, below an absurdity ceiling. */
  usd(v: unknown): number | undefined {
    return this.num(v, { min: 0, max: 1e15 });
  }
  pct(v: unknown): number | undefined {
    return this.num(v, { min: -100, max: 1e6 });
  }
  count(v: unknown): number | undefined {
    const n = this.num(v, { min: 0, max: 1e12 });
    return n !== undefined && Number.isInteger(n) ? n : undefined;
  }
  time(v: unknown): string | undefined {
    const t = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v * 1000 : NaN;
    if (!Number.isFinite(t) || t < Date.UTC(2015, 0, 1) || t > Date.now() + 3_600_000) {
      if (v !== null && v !== undefined) this.dropped++;
      return undefined;
    }
    return new Date(t).toISOString();
  }
  address(v: unknown): string | undefined {
    if (typeof v !== "string") return undefined;
    const raw = v.includes("_") ? v.slice(v.lastIndexOf("_") + 1) : v; // "robinhood_0x…" ids
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      this.dropped++;
      return undefined;
    }
    return toChecksumAddress(raw);
  }
  /** Pools: a 20-byte contract address, or a 32-byte pool id (Uniswap v4 pools have no contract of their own). */
  poolId(v: unknown): string | undefined {
    if (typeof v !== "string") return undefined;
    const raw = v.includes("_") ? v.slice(v.lastIndexOf("_") + 1) : v;
    if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase();
    return this.address(raw);
  }
  text(v: unknown, max = 80): string | undefined {
    return typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : undefined;
  }
}

type Windows = "m5" | "h1" | "h6" | "h24";
const WINDOWS: Windows[] = ["m5", "h1", "h6", "h24"];

export interface PoolFacts {
  address: string;
  name?: string;
  dex?: string;
  createdAt?: string;
  baseToken?: string;
  quoteToken?: string;
  basePriceUsd?: number;
  quotePriceUsd?: number;
  basePriceInQuote?: number;
  liquidityUsd?: number;
  fdvUsd?: number;
  marketCapUsd?: number;
  volumeUsd: Partial<Record<Windows, number>>;
  priceChangePct: Partial<Record<Windows, number>>;
  txns: Partial<Record<Windows, { buys?: number; sells?: number; buyers?: number; sellers?: number }>>;
}

export interface TokenFacts {
  address: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  priceUsd?: number;
  fdvUsd?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
}

interface JsonApiResource {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id?: string } | { id?: string }[] | null }>;
}

function rel(r: JsonApiResource, name: string): string | undefined {
  const d = r.relationships?.[name]?.data;
  return d && !Array.isArray(d) ? d.id : undefined;
}

export function parsePool(r: JsonApiResource, v: Validator): PoolFacts | undefined {
  const a = r.attributes ?? {};
  const address = v.poolId(a.address ?? r.id);
  if (!address) return undefined;
  const vol = (a.volume_usd ?? {}) as Record<string, unknown>;
  const chg = (a.price_change_percentage ?? {}) as Record<string, unknown>;
  const tx = (a.transactions ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const pick = <T>(f: (w: Windows) => T | undefined) => Object.fromEntries(WINDOWS.map((w) => [w, f(w)]).filter(([, x]) => x !== undefined)) as Partial<Record<Windows, T>>;
  const dexId = rel(r, "dex");
  const base = rel(r, "base_token");
  const quote = rel(r, "quote_token");
  const facts: PoolFacts = {
    address,
    volumeUsd: pick((w) => v.usd(vol[w])),
    priceChangePct: pick((w) => v.pct(chg[w])),
    txns: pick((w) => {
      const t = tx[w];
      if (!t || typeof t !== "object") return undefined;
      const o = { buys: v.count(t.buys), sells: v.count(t.sells), buyers: v.count(t.buyers), sellers: v.count(t.sellers) };
      return Object.values(o).some((x) => x !== undefined) ? (Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as PoolFacts["txns"][Windows]) : undefined;
    }),
  };
  const opt = <K extends keyof PoolFacts>(k: K, val: PoolFacts[K] | undefined) => {
    if (val !== undefined) facts[k] = val;
  };
  opt("name", v.text(a.name));
  opt("dex", dexId ? v.text(dexId) : undefined);
  opt("createdAt", v.time(a.pool_created_at));
  opt("baseToken", base ? v.address(base) : undefined);
  opt("quoteToken", quote ? v.address(quote) : undefined);
  opt("basePriceUsd", v.usd(a.base_token_price_usd));
  opt("quotePriceUsd", v.usd(a.quote_token_price_usd));
  opt("basePriceInQuote", v.usd(a.base_token_price_quote_token));
  opt("liquidityUsd", v.usd(a.reserve_in_usd));
  opt("fdvUsd", v.usd(a.fdv_usd));
  opt("marketCapUsd", v.usd(a.market_cap_usd));
  return facts;
}

export function parseToken(r: JsonApiResource, v: Validator): TokenFacts | undefined {
  const a = r.attributes ?? {};
  const address = v.address(a.address ?? r.id);
  if (!address) return undefined;
  const dec = v.count(a.decimals);
  const facts: TokenFacts = { address };
  const set = <K extends keyof TokenFacts>(k: K, val: TokenFacts[K] | undefined) => {
    if (val !== undefined) facts[k] = val;
  };
  set("name", v.text(a.name));
  set("symbol", v.text(a.symbol, 20));
  set("decimals", dec !== undefined && dec <= 255 ? dec : undefined);
  set("priceUsd", v.usd(a.price_usd));
  set("fdvUsd", v.usd(a.fdv_usd));
  set("marketCapUsd", v.usd(a.market_cap_usd));
  set("liquidityUsd", v.usd(a.total_reserve_in_usd));
  set("volume24hUsd", v.usd((a.volume_usd as Record<string, unknown> | undefined)?.h24));
  return facts;
}

// ── Workflows ────────────────────────────────────────────────────────────────

export interface MarketSection {
  title: string;
  url?: string;
  content: string;
  relevance: number;
}

export interface MarketContext {
  client: GeckoTerminalClient;
  network: string;
  budget: MarketBudget;
  limits: { maxPools: number; maxTrades: number; ohlcvDays: number };
  v: Validator;
  notices: Set<string>;
  /** Robinhood explorer tx link builder — trades link to on-chain references. */
  txLink: (hash: string) => string | undefined;
  citable: Set<string>;
  /** Oldest fetch time used, and whether any data was stale. */
  freshness: { oldest?: number; stale?: string };
  results: { tokens: TokenFacts[]; pools: PoolFacts[]; candles: number; trades: number };
}

async function fetchOr<T>(ctx: MarketContext, path: string, ttl: "live" | "pools" | "meta", what: string, required = false): Promise<Fetched<T> | null | undefined> {
  try {
    const r = await ctx.client.get<T>(path, ttl, ctx.budget);
    if (r) {
      ctx.freshness.oldest = Math.min(ctx.freshness.oldest ?? r.fetchedAt, r.fetchedAt);
      if (r.stale) ctx.freshness.stale = r.stale.reason;
    }
    return r;
  } catch (err) {
    const e = toVeyraError(err, "tool:geckoterminal");
    if (e.kind === "aborted" || required) throw e;
    ctx.notices.add(`Could not fetch ${what} from GeckoTerminal (${e.kind}).`);
    return undefined;
  }
}

/** Distinguishes "token not listed" from "network not supported" (checked only when something 404s). */
async function networkSupported(ctx: MarketContext): Promise<boolean | undefined> {
  for (let page = 1; page <= 5; page++) {
    const r = await fetchOr<{ data?: JsonApiResource[] }>(ctx, `/networks?page=${page}`, "meta", "the network list");
    if (!r) return undefined;
    const list = r.body.data ?? [];
    if (list.some((n) => n.id === ctx.network)) return true;
    if (list.length === 0) return false;
  }
  return undefined;
}

function unavailableSection(title: string, content: string): MarketSection {
  return { title, content, relevance: 1 };
}

export async function marketForAddress(address: string, q: MarketQuery, ctx: MarketContext): Promise<MarketSection[]> {
  const net = encodeURIComponent(ctx.network);
  const token = await fetchOr<{ data?: JsonApiResource; included?: JsonApiResource[] }>(ctx, `/networks/${net}/tokens/${address}?include=top_pools`, "live", "token data", true);
  let pools: PoolFacts[] = [];
  const sections: MarketSection[] = [];
  let primary: PoolFacts | undefined;

  if (token?.body.data) {
    const t = parseToken(token.body.data, ctx.v);
    if (!t) throw new VeyraError("invalid_output", "tool:geckoterminal", "Malformed GeckoTerminal token response");
    ctx.results.tokens.push(t);
    pools = (token.body.included ?? []).filter((r) => r.type === "pool").map((r) => parsePool(r, ctx.v)).filter((p): p is PoolFacts => Boolean(p));
    if (!pools.length) {
      const list = await fetchOr<{ data?: JsonApiResource[] }>(ctx, `/networks/${net}/tokens/${address}/pools`, "pools", "the token's pools");
      pools = (list?.body.data ?? []).map((r) => parsePool(r, ctx.v)).filter((p): p is PoolFacts => Boolean(p));
    }
    pools = pools.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)).slice(0, ctx.limits.maxPools);
    primary = pools[0];
    ctx.results.pools.push(...pools);
    sections.push(tokenSection(t, pools, token, ctx));
  } else {
    // Not a token: maybe a pool address.
    const pool = await fetchOr<{ data?: JsonApiResource }>(ctx, `/networks/${net}/pools/${address}`, "live", "pool data", true);
    if (pool?.body.data) {
      const p = parsePool(pool.body.data, ctx.v);
      if (!p) throw new VeyraError("invalid_output", "tool:geckoterminal", "Malformed GeckoTerminal pool response");
      primary = p;
      ctx.results.pools.push(p);
      sections.push(poolSection(p, pool, ctx, 1));
    } else {
      const supported = await networkSupported(ctx);
      return [
        unavailableSection(
          `Market data unavailable for ${address}`,
          supported === false
            ? `GeckoTerminal does not support the network "${ctx.network}", so no market data (price, liquidity, volume) is available. Do not estimate it.`
            : `GeckoTerminal has no token or pool at ${address} on network "${ctx.network}" (not listed, no DEX pools, or a different network). No price, liquidity or volume is available — do not estimate it.`,
        ),
      ];
    }
  }

  if (primary && q.wants.history) {
    const s = await historySection(primary, q.timeframe, ctx);
    if (s) sections.push(s);
  }
  if (primary && q.wants.trades) {
    const s = await tradesSection(primary, ctx);
    if (s) sections.push(s);
  }
  return sections;
}

export async function marketForSymbol(symbol: string, ctx: MarketContext): Promise<MarketSection[]> {
  const net = encodeURIComponent(ctx.network);
  const r = await fetchOr<{ data?: JsonApiResource[]; included?: JsonApiResource[] }>(
    ctx,
    `/search/pools?query=${encodeURIComponent(symbol)}&network=${net}&include=base_token,quote_token`,
    "pools",
    "symbol search",
    true,
  );
  const tokens = new Map<string, TokenFacts>();
  for (const inc of r?.body.included ?? []) {
    if (inc.type !== "token") continue;
    const t = parseToken(inc, ctx.v);
    if (t?.symbol?.toUpperCase() === symbol) tokens.set(t.address.toLowerCase(), t);
  }
  const pools = (r?.body.data ?? []).map((p) => parsePool(p, ctx.v)).filter((p): p is PoolFacts => Boolean(p));
  // Candidates: tokens with this symbol, ranked by the liquidity of pools they trade in.
  const liquidity = new Map<string, number>();
  for (const p of pools) {
    for (const t of [p.baseToken, p.quoteToken]) if (t && tokens.has(t.toLowerCase())) liquidity.set(t.toLowerCase(), (liquidity.get(t.toLowerCase()) ?? 0) + (p.liquidityUsd ?? 0));
  }
  const candidates = [...tokens.values()].sort((a, b) => (liquidity.get(b.address.toLowerCase()) ?? 0) - (liquidity.get(a.address.toLowerCase()) ?? 0));
  if (!candidates.length) {
    return [unavailableSection(`Market data unavailable for ${symbol}`, `GeckoTerminal search found no token with the symbol ${symbol} on network "${ctx.network}". No price is available — do not estimate it. A contract address identifies a token reliably.`)];
  }
  ctx.results.pools.push(...pools.slice(0, ctx.limits.maxPools));
  const lines = [
    `Symbol search for "${symbol}" on GeckoTerminal network "${ctx.network}" — ${fetchedLine(r!)}`,
    candidates.length > 1
      ? `⚠ ${candidates.length} different tokens use the symbol ${symbol}. A symbol does not uniquely identify a token — ask the user for the contract address before treating any one of them as "${symbol}".`
      : `One token with this symbol was found in search results; symbols are not unique, so confirm by contract address.`,
    ...candidates.slice(0, 5).map((t) => {
      const pool = pools.find((p) => p.baseToken?.toLowerCase() === t.address.toLowerCase());
      return `- ${t.symbol} (${t.name ?? "unnamed"}) contract ${t.address}: ${pool?.basePriceUsd !== undefined ? `price ${usd(pool.basePriceUsd)} in pool ${pool.name ?? pool.address}` : "price not reported"}, liquidity in matched pools ${usd(liquidity.get(t.address.toLowerCase()))}`;
    }),
  ];
  return [{ title: `Market: tokens named ${symbol}`, url: r!.url, content: lines.join("\n"), relevance: 1 }];
}

export async function marketOverview(ctx: MarketContext): Promise<MarketSection[]> {
  const net = encodeURIComponent(ctx.network);
  const r = await fetchOr<{ data?: JsonApiResource[] }>(ctx, `/networks/${net}/pools`, "pools", "top pools", true);
  if (!r) {
    const supported = await networkSupported(ctx);
    return [unavailableSection("Market data unavailable", supported === false ? `GeckoTerminal does not support the network "${ctx.network}".` : `GeckoTerminal returned no pools for network "${ctx.network}".`)];
  }
  const pools = (r.body.data ?? []).map((p) => parsePool(p, ctx.v)).filter((p): p is PoolFacts => Boolean(p)).slice(0, ctx.limits.maxPools * 2);
  ctx.results.pools.push(...pools);
  return [
    {
      title: `Market: most active DEX pools on ${ctx.network}`,
      url: r.url,
      content: [
        `Most active pools on GeckoTerminal network "${ctx.network}" (GeckoTerminal's ranking) — ${fetchedLine(r)}`,
        ...pools.map(
          (p, i) =>
            `${i + 1}. ${p.name ?? p.address} (${p.dex ?? "dex unknown"}) pool ${p.address}: liquidity ${usd(p.liquidityUsd)}, 24h volume ${usd(p.volumeUsd.h24)}, 24h price change ${pct(p.priceChangePct.h24)}, 24h trades ${txLine(p.txns.h24)}`,
        ),
      ].join("\n"),
      relevance: 0.95,
    },
  ];
}

async function historySection(pool: PoolFacts, timeframe: "day" | "hour", ctx: MarketContext): Promise<MarketSection | undefined> {
  const limit = timeframe === "hour" ? 24 : ctx.limits.ohlcvDays;
  const r = await fetchOr<{ data?: { attributes?: { ohlcv_list?: unknown[] } } }>(
    ctx,
    `/networks/${encodeURIComponent(ctx.network)}/pools/${pool.address}/ohlcv/${timeframe}?limit=${limit}&currency=usd`,
    "live",
    "price history",
  );
  const rows = (r?.body.data?.attributes?.ohlcv_list ?? [])
    .map((row) => {
      if (!Array.isArray(row) || row.length < 6) {
        ctx.v.dropped++;
        return undefined;
      }
      const t = ctx.v.time(row[0]);
      const [o, h, l, c, vol] = [row[1], row[2], row[3], row[4], row[5]].map((x) => ctx.v.usd(x));
      if (!t || o === undefined || h === undefined || l === undefined || c === undefined || h < l) {
        ctx.v.dropped++;
        return undefined;
      }
      return { t, o, h, l, c, vol };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .sort((a, b) => a.t.localeCompare(b.t));
  if (!r || !rows.length) return undefined;
  ctx.results.candles += rows.length;
  const first = rows[0]!;
  const last = rows.at(-1)!;
  const change = first.o > 0 ? ((last.c - first.o) / first.o) * 100 : undefined;
  return {
    title: `Market: ${timeframe === "hour" ? "hourly" : "daily"} price history — ${pool.name ?? pool.address}`,
    url: r.url,
    content: [
      `OHLCV (USD, ${timeframe === "hour" ? "1-hour" : "1-day"} candles, UTC) for pool ${pool.name ?? ""} ${pool.address} — ${fetchedLine(r)}`,
      `Over these ${rows.length} candles: open ${usd(first.o)} → latest close ${usd(last.c)} (${pct(change)}), high ${usd(Math.max(...rows.map((x) => x.h)))}, low ${usd(Math.min(...rows.map((x) => x.l)))}.`,
      `The latest candle may still be in progress.`,
      ...rows.slice(-12).map((x) => `- ${x.t}: O ${usd(x.o)} H ${usd(x.h)} L ${usd(x.l)} C ${usd(x.c)} · volume ${usd(x.vol)}`),
    ].join("\n"),
    relevance: 0.9,
  };
}

async function tradesSection(pool: PoolFacts, ctx: MarketContext): Promise<MarketSection | undefined> {
  const r = await fetchOr<{ data?: JsonApiResource[] }>(ctx, `/networks/${encodeURIComponent(ctx.network)}/pools/${pool.address}/trades`, "live", "recent trades");
  const trades = (r?.body.data ?? [])
    .map((t) => {
      const a = t.attributes ?? {};
      const hash = typeof a.tx_hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(a.tx_hash) ? a.tx_hash : undefined;
      const time = ctx.v.time(a.block_timestamp);
      const kind = a.kind === "buy" || a.kind === "sell" ? a.kind : undefined;
      if (!hash || !time || !kind) {
        ctx.v.dropped++;
        return undefined;
      }
      return { hash, time, kind, usdValue: ctx.v.usd(a.volume_in_usd), from: ctx.v.address(a.tx_from_address) };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .slice(0, ctx.limits.maxTrades);
  if (!r || !trades.length) return undefined;
  ctx.results.trades += trades.length;
  const largest = [...trades].sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0))[0];
  for (const t of trades) {
    const link = ctx.txLink(t.hash);
    if (link) ctx.citable.add(link);
  }
  return {
    title: `Market: recent trades — ${pool.name ?? pool.address}`,
    url: r.url,
    content: [
      `The ${trades.length} most recent trades in pool ${pool.name ?? ""} ${pool.address} (GeckoTerminal) — ${fetchedLine(r)}. Each trade is an on-chain transaction (see the Robinhood explorer).`,
      `Buys: ${trades.filter((t) => t.kind === "buy").length} · Sells: ${trades.filter((t) => t.kind === "sell").length} · Largest in sample: ${usd(largest?.usdValue)} (${largest?.kind}, tx ${largest?.hash})`,
      ...trades.map((t) => `- ${t.time} ${t.kind.toUpperCase()} ${usd(t.usdValue)}${t.from ? ` by ${t.from}` : ""} (tx ${t.hash}${ctx.txLink(t.hash) ? ` · ${ctx.txLink(t.hash)}` : ""})`),
    ].join("\n"),
    relevance: 0.88,
  };
}

function tokenSection(t: TokenFacts, pools: PoolFacts[], r: Fetched<unknown>, ctx: MarketContext): MarketSection {
  return {
    title: `Market: ${t.symbol ?? "token"} ${t.address}`,
    url: r.url,
    content: [
      `Token ${t.symbol ?? "?"} (${t.name ?? "unnamed"}) — contract ${t.address} on GeckoTerminal network "${ctx.network}" — ${fetchedLine(r)}`,
      `Price: ${t.priceUsd !== undefined ? usd(t.priceUsd) : "not reported"} (GeckoTerminal's DEX-derived price; not an exchange quote)`,
      `Liquidity across its pools: ${usd(t.liquidityUsd)} · 24h volume: ${usd(t.volume24hUsd)}`,
      `Market cap: ${t.marketCapUsd !== undefined ? usd(t.marketCapUsd) : "not reported"} · FDV: ${usd(t.fdvUsd)}`,
      pools.length ? `Top pools (by liquidity):` : `No DEX pools reported for this token.`,
      ...pools.map(
        (p) =>
          `- ${p.name ?? p.address} (${p.dex ?? "dex unknown"}) pool ${p.address}: liquidity ${usd(p.liquidityUsd)}, volume 1h ${usd(p.volumeUsd.h1)} / 24h ${usd(p.volumeUsd.h24)}, price change 1h ${pct(p.priceChangePct.h1)} / 24h ${pct(p.priceChangePct.h24)}, 24h trades ${txLine(p.txns.h24)}`,
      ),
      pools.length && pools[0]!.liquidityUsd !== undefined && pools[0]!.liquidityUsd < 10_000 ? "Note: very low liquidity — prices can move sharply on small trades." : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
    relevance: 1,
  };
}

function poolSection(p: PoolFacts, r: Fetched<unknown>, ctx: MarketContext, relevance: number): MarketSection {
  return {
    title: `Market: pool ${p.name ?? p.address}`,
    url: r.url,
    content: [
      `DEX pool ${p.name ?? "?"} (${p.dex ?? "dex unknown"}) — address ${p.address} on GeckoTerminal network "${ctx.network}" — ${fetchedLine(r)}`,
      `Tokens: base ${p.baseToken ?? "?"}, quote ${p.quoteToken ?? "?"}${p.createdAt ? ` · created ${p.createdAt}` : ""}`,
      `Base token price: ${usd(p.basePriceUsd)}${p.basePriceInQuote !== undefined ? ` (${p.basePriceInQuote} quote tokens)` : ""} · Liquidity: ${usd(p.liquidityUsd)}`,
      `Volume: ${WINDOWS.map((w) => `${w} ${usd(p.volumeUsd[w])}`).join(" · ")}`,
      `Price change: ${WINDOWS.map((w) => `${w} ${pct(p.priceChangePct[w])}`).join(" · ")}`,
      `Trades: ${WINDOWS.map((w) => `${w} ${txLine(p.txns[w])}`).join(" · ")}`,
    ].join("\n"),
    relevance,
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

function fetchedLine(r: Fetched<unknown>): string {
  const ageS = Math.max(0, Math.round((Date.now() - r.fetchedAt) / 1000));
  const when = new Date(r.fetchedAt).toISOString();
  return r.stale
    ? `⚠ STALE DATA: last-known values from ${when} (${Math.round(ageS / 60)} min old) because GeckoTerminal is currently unavailable (${r.stale.reason}); not current`
    : `data fetched ${when} (${ageS}s ago)`;
}

export function usd(n: number | undefined): string {
  if (n === undefined) return "not reported";
  if (n === 0) return "$0";
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 2 })}`;
  // 4 significant digits, trailing zeros trimmed (0.9800 → 0.98); tiny values keep exponent form.
  return n < 1e-6 ? `$${n.toPrecision(4)}` : `$${Number(n.toPrecision(4)).toString()}`;
}

function pct(n: number | undefined): string {
  return n === undefined ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function txLine(t: { buys?: number; sells?: number } | undefined): string {
  return t ? `${t.buys ?? "?"} buys / ${t.sells ?? "?"} sells` : "n/a";
}
