import { Hono } from "hono";
import { TtlCache } from "../cache/ttl-cache.js";
import { robinhoodChain, type ChainConfig } from "../config/chains.js";
import { rateLimitEnabled, type Env } from "../config/env.js";
import { toVeyraError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { ClientRateLimiter } from "../security/rate-limit.js";
import { AnalysisContext } from "../providers/blockchain/analysis.js";
import { formatUnits, toChecksumAddress, validateAddress } from "../providers/blockchain/evm.js";
import { BlockscoutExplorer, type BsAddressRef, type BsToken } from "../providers/blockchain/explorer.js";
import { EvmRpcProvider, JsonRpcClient } from "../providers/blockchain/rpc.js";
import type { BlockchainProvider, ChainBudget } from "../providers/blockchain/types.js";
import { clientKey, tooManyRequests, type AppVariables } from "./http-guards.js";

/**
 * GET /api/address/:address — a structured, read-only profile of one Robinhood Chain address for the
 * landing page's address lookup. No model is called: every value comes straight from the chain (RPC)
 * or the official explorer (Blockscout API, only when a key is configured).
 *
 * Without an explorer key the lookup still works from RPC alone (type, balance, nonce, token metadata);
 * history fields are then absent and `history.available` says why. Results are cached briefly per
 * address and each client has its own request allowance. Third-party text (names, symbols, labels)
 * is cleaned and bounded; the UI renders it with textContent.
 */
const CACHE_TTL_MS = 30_000;
const TIMEOUT_MS = 15_000;
const LOOKUPS_PER_MINUTE = 15;
const LIST_MAX = 10;

export interface AddressTx {
  hash: string;
  time?: string;
  method?: string;
  direction: "in" | "out" | "self";
  counterparty?: string;
  counterpartyLabel?: string;
  value: string;
  failed?: boolean;
  url?: string;
}
export interface AddressTransfer {
  hash: string;
  time?: string;
  token: { symbol?: string; name?: string; address: string };
  amount?: string;
  direction: "in" | "out" | "self";
  counterparty?: string;
  /** Token pages: who sent and who received (a token contract is rarely a party itself). */
  from?: string;
  to?: string;
  url?: string;
}
export interface AddressHolding {
  symbol?: string;
  name?: string;
  address: string;
  balance?: string;
  url?: string;
}
export interface AddressProfile {
  address: string;
  chain: { name: string; chainId: number };
  kind: "wallet" | "contract" | "token";
  url?: string;
  balance?: { value: string; symbol: string };
  sent?: number;
  label?: string;
  verified?: boolean;
  scam?: boolean;
  token?: { name?: string; symbol?: string; decimals?: number; totalSupply?: string; holders?: number };
  counters?: { transactions?: number; tokenTransfers?: number };
  history: { available: boolean; reason?: string };
  holdings?: AddressHolding[];
  transactions?: AddressTx[];
  transfers?: AddressTransfer[];
  generatedAt: string;
}

const INVISIBLE = new RegExp("[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\ufeff]", "g");
const clean = (s: unknown, max = 60): string | undefined => {
  const v = String(s ?? "").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return v || undefined;
};
const count = (v: unknown): number | undefined => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
const labelOf = (r?: { name?: string | null; public_tags?: { display_name?: string; label?: string }[] } | null) =>
  clean(r?.public_tags?.[0]?.display_name ?? r?.public_tags?.[0]?.label ?? r?.name ?? undefined, 40);
const amountOf = (raw: string | null | undefined, decimals: number | undefined, digits = 4): string | undefined =>
  raw && /^\d+$/.test(raw) && decimals !== undefined ? formatUnits(BigInt(raw), decimals, digits) : undefined;
const decimalsOf = (t: BsToken): number | undefined => (t.decimals && /^\d+$/.test(t.decimals) ? Number(t.decimals) : undefined);

export interface AddressDeps {
  chain?: ChainConfig;
  provider?: BlockchainProvider;
  explorer?: BlockscoutExplorer | null;
  now?: () => number;
}

export function createAddressLookup(env: Env, logger: Logger, deps: AddressDeps = {}) {
  const now = deps.now ?? Date.now;
  const chain = deps.chain ?? robinhoodChain(env);
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
  const cache = new TtlCache<AddressProfile>(500);

  async function profile(address: string): Promise<AddressProfile> {
    const budget: ChainBudget = { signal: AbortSignal.timeout(TIMEOUT_MS), rpcCalls: 0, maxRpcCalls: 12, explorerCalls: 0, maxExplorerCalls: 8 };
    const ctx = new AnalysisContext(chain, provider, explorer, budget, { maxTransactions: LIST_MAX, maxLogs: 0, blockWindow: 0 });
    try {
      await provider.ensureChain(budget);
    } catch (err) {
      const e = toVeyraError(err, "rpc");
      if (e.kind === "aborted" || /chain ID mismatch/.test(e.message) || !explorer) throw e;
      ctx.rpcDown = e.kind;
    }

    const [balance, sent, code, info, counters] = await Promise.all([
      ctx.optionalRpc("balance", () => provider.balance(address, budget)),
      ctx.optionalRpc("nonce", () => provider.transactionCount(address, budget)),
      ctx.optionalRpc("code", () => provider.code(address, budget)),
      ctx.fromExplorer("address", (e) => e.address(address, budget)),
      ctx.fromExplorer("counters", (e) => e.addressCounters(address, budget)),
    ]);
    if (balance === undefined && !info) throw toVeyraError(new Error("unreadable"), "rpc");

    const isContract = code !== undefined ? code !== "0x" : Boolean(info?.is_contract);
    const meta = isContract ? await ctx.tokenMeta(address) : undefined;
    const isToken = Boolean(meta && meta.source !== "none");
    const native = balance ?? (info?.coin_balance && /^\d+$/.test(info.coin_balance) ? BigInt(info.coin_balance) : undefined);
    const lower = address.toLowerCase();
    const dir = (from?: string, to?: string): "in" | "out" | "self" =>
      from?.toLowerCase() === lower && to?.toLowerCase() === lower ? "self" : from?.toLowerCase() === lower ? "out" : "in";
    const other = (from: BsAddressRef, to: BsAddressRef | null): BsAddressRef | null => (from.hash.toLowerCase() === lower ? to : from);

    const out: AddressProfile = {
      address,
      chain: { name: chain.name, chainId: chain.chainId },
      kind: isToken ? "token" : isContract ? "contract" : "wallet",
      ...(ctx.links.address(address) ? { url: ctx.links.address(address)! } : {}),
      ...(native !== undefined ? { balance: { value: formatUnits(native, chain.nativeDecimals, 6), symbol: chain.nativeSymbol } } : {}),
      ...(sent !== undefined && !isContract ? { sent } : {}),
      ...(labelOf(info) ? { label: labelOf(info)! } : {}),
      ...(isContract && typeof info?.is_verified === "boolean" ? { verified: info.is_verified } : {}),
      ...(info?.is_scam ? { scam: true } : {}),
      ...(isToken && meta
        ? {
            token: {
              ...(meta.name ? { name: clean(meta.name)! } : {}),
              ...(meta.symbol ? { symbol: clean(meta.symbol, 20)! } : {}),
              ...(meta.decimals !== undefined ? { decimals: meta.decimals } : {}),
              ...(meta.totalSupply !== undefined && meta.decimals !== undefined ? { totalSupply: formatUnits(meta.totalSupply, meta.decimals, 2) } : {}),
              ...(meta.holders !== undefined ? { holders: meta.holders } : {}),
            },
          }
        : {}),
      ...(counters ? { counters: { ...(count(counters.transactions_count) !== undefined ? { transactions: count(counters.transactions_count)! } : {}), ...(count(counters.token_transfers_count) !== undefined ? { tokenTransfers: count(counters.token_transfers_count)! } : {}) } } : {}),
      history: { available: false },
      generatedAt: new Date(now()).toISOString(),
    };

    if (!explorer) {
      out.history = { available: false, reason: "Transaction history needs the explorer API, which is not configured yet." };
      return out;
    }
    const [txs, transfers, tokens] = await Promise.all([
      ctx.fromExplorer("transactions", (e) => e.addressTransactions(address, budget)),
      isToken ? ctx.fromExplorer("transfers", (e) => e.tokenTransfers(address, budget)) : ctx.fromExplorer("transfers", (e) => e.addressTokenTransfers(address, budget)),
      isContract ? Promise.resolve(undefined) : ctx.fromExplorer("tokens", (e) => e.addressTokens(address, budget)),
    ]);
    if (ctx.explorerDown || (!txs && !transfers && !tokens && !info)) {
      out.history = { available: false, reason: "The explorer API is unavailable right now." };
      return out;
    }
    out.history = { available: true };
    out.transactions = (txs?.items ?? []).slice(0, LIST_MAX).map((t): AddressTx => {
      const o = other(t.from, t.to);
      return {
        hash: t.hash,
        ...(t.timestamp ? { time: t.timestamp } : {}),
        ...(clean(t.method, 32) ? { method: clean(t.method, 32)! } : {}),
        direction: dir(t.from.hash, t.to?.hash),
        ...(o ? { counterparty: toChecksumAddress(o.hash) } : {}),
        ...(labelOf(o) ? { counterpartyLabel: labelOf(o)! } : {}),
        value: amountOf(t.value, chain.nativeDecimals, 6) ?? "0",
        ...(t.status && t.status !== "ok" ? { failed: true } : {}),
        ...(ctx.links.tx(t.hash) ? { url: ctx.links.tx(t.hash)! } : {}),
      };
    });
    out.transfers = (transfers?.items ?? []).slice(0, LIST_MAX).map((t): AddressTransfer => {
      const o = isToken ? null : other(t.from, t.to);
      const dec = t.total?.decimals && /^\d+$/.test(t.total.decimals) ? Number(t.total.decimals) : decimalsOf(t.token);
      return {
        hash: t.transaction_hash,
        ...(t.timestamp ? { time: t.timestamp } : {}),
        token: { address: toChecksumAddress(t.token.address_hash), ...(clean(t.token.symbol, 20) ? { symbol: clean(t.token.symbol, 20)! } : {}), ...(clean(t.token.name) ? { name: clean(t.token.name)! } : {}) },
        ...(amountOf(t.total?.value, dec) ? { amount: amountOf(t.total?.value, dec)! } : {}),
        direction: isToken ? "self" : dir(t.from.hash, t.to.hash),
        ...(o ? { counterparty: toChecksumAddress(o.hash) } : {}),
        ...(isToken ? { from: toChecksumAddress(t.from.hash), to: toChecksumAddress(t.to.hash) } : {}),
        ...(ctx.links.tx(t.transaction_hash) ? { url: ctx.links.tx(t.transaction_hash)! } : {}),
      };
    });
    if (tokens) {
      out.holdings = (tokens.items ?? []).slice(0, LIST_MAX).map((h): AddressHolding => {
        const a = toChecksumAddress(h.token.address_hash);
        return {
          address: a,
          ...(clean(h.token.symbol, 20) ? { symbol: clean(h.token.symbol, 20)! } : {}),
          ...(clean(h.token.name) ? { name: clean(h.token.name)! } : {}),
          ...(amountOf(h.value, decimalsOf(h.token)) ? { balance: amountOf(h.value, decimalsOf(h.token))! } : {}),
          ...(ctx.links.token(a) ? { url: ctx.links.token(a)! } : {}),
        };
      });
    }
    return out;
  }

  const inflight = new Map<string, Promise<AddressProfile>>();
  return {
    async get(address: string): Promise<AddressProfile> {
      const key = address.toLowerCase();
      const hit = cache.get(key);
      if (hit) return hit;
      let p = inflight.get(key);
      if (!p) {
        p = profile(address)
          .then((v) => {
            cache.set(key, v, CACHE_TTL_MS);
            return v;
          })
          .finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      try {
        return await p;
      } catch (err) {
        logger.warn("address lookup failed", { error: err instanceof Error ? err.name : "error" });
        throw err;
      }
    },
  };
}

export function addressRoutes(
  env: Env,
  logger: Logger,
  limiter: ClientRateLimiter,
  lookup = createAddressLookup(env, logger),
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.get("/api/address/:address", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!env.ONCHAIN_ENABLED) return c.json({ error: { kind: "unavailable", message: "On-chain data is turned off." } }, 503);
    const check = validateAddress(c.req.param("address").trim());
    if (!check.ok) return c.json({ error: { kind: "validation", message: "That is not a valid address (expected 0x followed by 40 hex characters)." } }, 400);
    if (rateLimitEnabled(env)) {
      const verdict = limiter.take("address", clientKey(c, env), LOOKUPS_PER_MINUTE);
      if (!verdict.ok) return tooManyRequests(c, verdict.retryAfterMs);
    }
    try {
      return c.json(await lookup.get(check.address));
    } catch {
      return c.json({ error: { kind: "upstream", message: "Robinhood Chain could not be read right now. Try again in a moment." } }, 502);
    }
  });
  return app;
}
