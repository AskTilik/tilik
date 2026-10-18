import { z } from "zod";
import { robinhoodChain } from "../config/chains.js";
import type { Env } from "../config/env.js";
import type { Logger } from "../core/logger.js";
import type { SourceInput } from "../sources/types.js";
import { decodeUint, ERC20 } from "../providers/blockchain/evm.js";
import { EvmRpcProvider, JsonRpcClient } from "../providers/blockchain/rpc.js";
import type { BlockchainProvider } from "../providers/blockchain/types.js";
import type { Tool, ToolResult } from "../tools/types.js";
import { createAddressLookup } from "./address.js";
import { createHolderTracker, type HolderHistory } from "./holders.js";
import { createTokenIntel, type TokenIntel } from "./token.js";

/**
 * The same token check the website shows (asktilik.com/token/<address>), as a
 * tool for the answer engine: safety checks, liquidity lock, dev wallet,
 * first-minute buyers and holder growth. The answer and the page then agree.
 */
export const TILIK_TOKEN = "0x160b29692f83a2f76d4fee8f04d05f9fdc9aca96";
const MAX_TOKENS = 2;

const InputSchema = z.object({ addresses: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).min(1).max(MAX_TOKENS) });
const DataSchema = z.object({
  tokens: z.array(z.object({ address: z.string(), symbol: z.string().optional(), checks: z.number(), url: z.string() })),
});
type Input = z.infer<typeof InputSchema>;
type Data = z.infer<typeof DataSchema>;

const usd = (n: number | undefined) => (n === undefined ? "unknown" : n >= 1 ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `$${n.toPrecision(3)}`);

export function tokenCheckSources(t: TokenIntel, history: HolderHistory | undefined, site = "https://asktilik.com"): SourceInput[] {
  const name = t.token.symbol ? `$${t.token.symbol}` : t.address;
  const page = `${site}/token/${t.address}`;
  const out: SourceInput[] = [];
  const m = t.market;
  out.push({
    title: `TILIK token check — ${name}`,
    url: page,
    type: "onchain",
    evidence: "live_data",
    relevance: 1,
    content: [
      `Token ${name} (${t.token.name ?? "unnamed"}) at ${t.address} on ${t.chain.name}.`,
      m ? `Price ${usd(m.priceUsd)}, liquidity ${usd(m.liquidityUsd)}, 24h volume ${usd(m.volume24hUsd)}.` : "No DEX market data.",
      t.token.holders !== undefined ? `${t.token.holders} holders (explorer count).` : "",
      "Note: for a launchpad token the explorer's \"creator\" is the launchpad factory contract, not a person. The launcher (dev) wallet is the sender of the creation transaction" + (t.dev ? `: ${t.dev.address}.` : "; it could not be read this time, so say the dev wallet is unknown rather than naming the factory."),
      "Checks (most important first):",
      ...t.checks.map((c) => `- [${c.level.toUpperCase()}] ${c.title}: ${c.detail}`),
    ]
      .filter(Boolean)
      .join("\n"),
  });
  const lk = t.liquidityLock;
  if (lk) {
    out.push({
      title: `Liquidity lock — ${name} (read on-chain)`,
      url: `https://robinhoodchain.blockscout.com/address/${lk.locker}`,
      type: "onchain",
      evidence: "live_data",
      relevance: 0.95,
      content: [
        `The pool position NFT #${lk.positionId} is ${lk.held ? "held by" : "NOT held by"} ${lk.lockerName} (${lk.locker}).`,
        lk.hasLiquidity ? "The position still has liquidity in it." : "The position has no liquidity left.",
        lk.mainPool === true ? "It is the token's main (deepest) pool." : lk.mainPool === false ? "It is not the token's deepest pool." : "",
        lk.held && lk.hasLiquidity ? `Status: locked permanently. ${lk.note}` : "Status: the lock no longer covers a funded position.",
        "Read directly from the locker contract (isLocked, lockedPositions) and the Uniswap v4 PositionManager (ownerOf, getPositionLiquidity).",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  const d = t.dev;
  if (d) {
    out.push({
      title: `Dev wallet — ${name} launcher ${d.address.slice(0, 6)}…${d.address.slice(-4)}`,
      ...(d.url ? { url: d.url } : {}),
      type: "onchain",
      evidence: "live_data",
      relevance: 0.9,
      content: [
        `Launched by ${d.address}${d.launchedVia ? ` via ${d.launchedVia}` : ""}${d.launchedAt ? ` at ${d.launchedAt}` : ""} (sender of the token's creation transaction).`,
        d.holdsPct !== undefined ? `It holds ${d.holdsPct}% of the supply now.` : "",
        `Its transfers of this token: received/bought ${d.received}×, burned ${d.burned}×, sent or sold ${d.sentOut}×.`,
        d.launches !== undefined ? `Launches through the same launchpad in its recent transactions: ${d.launches}.` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  const s = t.snipers;
  if (s) {
    out.push({
      title: `First-minute buyers — ${name}`,
      type: "onchain",
      evidence: "live_data",
      relevance: 0.85,
      content: [
        `${s.buyers} wallets bought ${s.boughtPct}% of the supply within ${s.windowSec} seconds of launch (from Transfer events; routers skipped).`,
        s.stillHoldPct !== undefined ? `The ${s.checked} largest of them still hold ${s.stillHoldPct}% of the supply; ${s.soldAll} sold or moved everything.` : "",
        ...s.top.slice(0, 5).map((w) => `- ${w.address}: bought ${w.boughtPct}%, ${w.sold ? "exited" : w.holdsPct !== undefined ? `holds ${w.holdsPct}%` : "balance unknown"}${w.dev ? " (dev wallet)" : ""}`),
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  const pts = history?.points ?? [];
  if (pts.length >= 2) {
    const peak = pts.reduce((a, p) => (p.holders > a.holders ? p : a), pts[0]!);
    const last = pts.at(-1)!;
    out.push({
      title: `Holder growth — ${name}`,
      type: "onchain",
      evidence: "live_data",
      relevance: 0.8,
      content: [
        `Holder count over time${history?.rebuilt ? ", rebuilt since launch from every Transfer event" : ""}: ${pts[0]!.holders} at ${pts[0]!.t}, peak ${peak.holders} at ${peak.t}, ${last.holders} at ${last.t}.`,
        history?.change24h !== undefined ? `Change in the last 24h: ${history.change24h >= 0 ? "+" : ""}${history.change24h}.` : "",
        history?.change7d !== undefined ? `Change in the last 7 days: ${history.change7d >= 0 ? "+" : ""}${history.change7d}.` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  return out;
}

export function createTokenCheckTool(
  env: Env,
  deps: { intel?: ReturnType<typeof createTokenIntel>; holders?: ReturnType<typeof createHolderTracker>; provider?: BlockchainProvider; logger?: Logger } = {},
): Tool<Input, Data> {
  const quiet = deps.logger ?? ({ info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger);
  let intel = deps.intel, holders = deps.holders, provider = deps.provider;
  const ready = () => {
    intel ??= createTokenIntel(env, quiet, createAddressLookup(env, quiet));
    holders ??= createHolderTracker(env, quiet);
    if (!provider) {
      const chain = robinhoodChain(env), o = { timeoutMs: env.ONCHAIN_RPC_TIMEOUT_MS, retries: env.ONCHAIN_RPC_RETRIES, stableTtlMs: 300_000, liveTtlMs: 15_000 };
      provider = new EvmRpcProvider(chain, new JsonRpcClient(chain.rpcUrls, o), o);
    }
    return { intel, holders, provider };
  };
  return {
    name: "tilik-token-check",
    description: "TILIK's token check: safety checks, liquidity lock, dev wallet, first-minute buyers and holder growth for a Robinhood Chain token.",
    capabilities: ["token.check"],
    inputSchema: InputSchema,
    outputSchema: DataSchema,
    auth: { envKeys: [] },
    rateLimit: { requestsPerMinute: 30 },
    costTier: "free",
    priority: 1,
    cacheTtlSeconds: 60,
    timeoutMs: 30_000,
    isConfigured: () => env.ONCHAIN_ENABLED,
    planInput(ctx) {
      if (!ctx.intents.includes("onchain") && !ctx.intents.includes("market")) return null;
      const addrs = [...ctx.entities.addresses];
      if (ctx.entities.tickers.includes("TILIK") || /\btilik\b/i.test(ctx.query)) addrs.push(TILIK_TOKEN);
      const unique = [...new Set(addrs.map((a) => a.toLowerCase()))].slice(0, MAX_TOKENS);
      return unique.length ? { addresses: unique } : null;
    },
    async execute(q): Promise<ToolResult<Data>> {
      const { intel: ti, holders: ht, provider: rpc } = ready();
      const sources: SourceInput[] = [], tokens: Data["tokens"] = [];
      for (const a of q.addresses) {
        // One cheap call first: no decimals() means a wallet or a plain contract, which the chain tool already covers.
        const budget = { signal: AbortSignal.timeout(10_000), rpcCalls: 0, maxRpcCalls: 2, explorerCalls: 0, maxExplorerCalls: 0 };
        const dec = decodeUint(await rpc.call(a, ERC20.decimals, budget, { stable: true }).catch((err) => { if (err?.kind === "bad_request" || /revert/i.test(String(err?.message))) return "0x"; throw err; }));
        if (dec === undefined || dec > 255n) continue;
        let t: TokenIntel;
        try {
          t = await ti.get(a);
        } catch (err) {
          if (err instanceof Error && err.name === "NotAToken") continue; // a wallet or contract: the chain tool covers it
          throw err;
        }
        const history = ht.enabled ? await Promise.race([ht.history(a).catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), 4000))]) : undefined;
        if (!t.market && !t.token.symbol) throw new Error("token check: no data"); // nothing read: a failure, never empty "facts"
        sources.push(...tokenCheckSources(t, history));
        tokens.push({ address: t.address, ...(t.token.symbol ? { symbol: t.token.symbol } : {}), checks: t.checks.length, url: `https://asktilik.com/token/${t.address}` });
      }
      return { data: { tokens }, sources, ...(tokens.length ? {} : { notices: ["No token found at the given address for a token check."] }) };
    },
  };
}
