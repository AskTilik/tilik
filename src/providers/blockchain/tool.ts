import { z } from "zod";
import { robinhoodChain, type ChainConfig } from "../../config/chains.js";
import type { Env } from "../../config/env.js";
import { toVeyraError, VeyraError } from "../../core/errors.js";
import type { SourceInput } from "../../sources/types.js";
import type { Tool, ToolResult } from "../../tools/types.js";
import { AnalysisContext, analyzeAddress, analyzeBlock, analyzeNetwork, analyzeTransaction, planOnchainQuery, type OnchainQuery, type Section } from "./analysis.js";
import { BlockscoutExplorer } from "./explorer.js";
import { EvmRpcProvider, JsonRpcClient } from "./rpc.js";
import type { BlockchainProvider, ChainBudget } from "./types.js";

export const OnchainInputSchema = z.object({
  kind: z.enum(["transaction", "address", "block", "network"]),
  txHashes: z.array(z.string().regex(/^0x[0-9a-f]{64}$/)).max(10),
  addresses: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).max(10),
  block: z.union([z.number().int().nonnegative(), z.literal("latest")]).optional(),
  focus: z.array(z.enum(["largest_transfers", "active_contracts", "trend", "tokens", "recent"])),
  invalid: z.array(z.object({ value: z.string().max(200), reason: z.string().max(300) })).max(10),
});

export const OnchainDataSchema = z.object({
  chain: z.object({ name: z.string(), chainId: z.number(), explorer: z.string().optional(), rpc: z.enum(["public", "custom"]) }),
  kind: z.enum(["transaction", "address", "block", "network"]),
  targets: z.array(z.string()),
  sections: z.array(z.object({ title: z.string(), url: z.string().optional() })),
  dataSources: z.object({ rpc: z.enum(["ok", "unavailable"]), explorer: z.enum(["ok", "unavailable", "not configured"]) }),
  requests: z.object({ rpc: z.number(), explorer: z.number() }),
  invalid: z.array(z.object({ value: z.string(), reason: z.string() })),
});
export type OnchainData = z.infer<typeof OnchainDataSchema>;

export interface OnchainDeps {
  chain?: ChainConfig;
  provider?: BlockchainProvider;
  explorer?: BlockscoutExplorer | null;
}

/**
 * Robinhood Chain intelligence. The LLM never fetches chain facts: this tool
 * reads them (RPC first, explorer API for history/labels/stats), normalizes
 * them into sourced sections with explorer links, and the model explains them.
 */
export function createRobinhoodChainTool(env: Env, deps: OnchainDeps = {}): Tool<OnchainQuery, OnchainData> {
  const chain = deps.chain ?? robinhoodChain(env);
  const rpcOpts = {
    timeoutMs: env.ONCHAIN_RPC_TIMEOUT_MS,
    retries: env.ONCHAIN_RPC_RETRIES,
    stableTtlMs: env.ONCHAIN_CACHE_TTL_SECONDS * 1000,
    liveTtlMs: env.ONCHAIN_LIVE_TTL_SECONDS * 1000,
  };
  const provider = deps.provider ?? new EvmRpcProvider(chain, new JsonRpcClient(chain.rpcUrls, rpcOpts), rpcOpts);
  const explorer =
    deps.explorer === null
      ? undefined
      : (deps.explorer ??
        (chain.explorerApiUrl
          ? new BlockscoutExplorer(chain.explorerApiUrl, {
              timeoutMs: env.ONCHAIN_RPC_TIMEOUT_MS,
              liveTtlMs: rpcOpts.liveTtlMs,
              stableTtlMs: rpcOpts.stableTtlMs,
              ...(chain.explorerApiKey ? { apiKey: chain.explorerApiKey } : {}),
            })
          : undefined));

  return {
    name: "robinhood-chain",
    description: `${chain.name} on-chain data: transactions, addresses, contracts, tokens, blocks and network activity.`,
    capabilities: ["chain.data"],
    inputSchema: OnchainInputSchema,
    outputSchema: OnchainDataSchema,
    auth: { envKeys: ["ROBINHOOD_RPC_URL"] },
    rateLimit: { requestsPerMinute: 30 },
    dailyLimit: env.ONCHAIN_DAILY_REQUEST_LIMIT,
    costTier: "free",
    priority: 1,
    // Whole answers are live data: reuse only for a few seconds. Mined blocks/receipts are cached longer inside the RPC client.
    cacheTtlSeconds: env.ONCHAIN_LIVE_TTL_SECONDS,
    timeoutMs: env.ONCHAIN_TIMEOUT_MS,
    isConfigured: () => env.ONCHAIN_ENABLED && chain.rpcUrls.length > 0,
    planInput: (ctx) => (ctx.intents.includes("onchain") ? planOnchainQuery(ctx.query, ctx.entities, env.ONCHAIN_MAX_ADDRESSES) : null),

    async execute(q, { signal }): Promise<ToolResult<OnchainData>> {
      const budget: ChainBudget = {
        signal,
        rpcCalls: 0,
        maxRpcCalls: Math.max(2, env.ONCHAIN_MAX_RPC_CALLS),
        explorerCalls: 0,
        maxExplorerCalls: Math.max(1, env.ONCHAIN_MAX_EXPLORER_CALLS),
      };
      const ctx = new AnalysisContext(chain, provider, explorer, budget, {
        maxTransactions: env.ONCHAIN_MAX_TRANSACTIONS,
        maxLogs: env.ONCHAIN_MAX_LOG_RESULTS,
        blockWindow: env.ONCHAIN_BLOCK_WINDOW,
      });

      // 1. Is the RPC up, and is it really this chain? A wrong chain is fatal; an outage falls back to the explorer.
      try {
        await provider.ensureChain(budget);
      } catch (err) {
        const e = toVeyraError(err, "rpc");
        if (e.kind === "aborted" || /chain ID mismatch/.test(e.message)) throw e;
        if (!explorer) throw new VeyraError(e.kind, "rpc", `${chain.name} RPC is unavailable (${e.kind}). No explorer API is configured to fall back to.`);
        ctx.rpcDown = e.kind;
        ctx.notices.add(`${chain.name} RPC is unavailable (${e.kind}${chain.publicRpc ? " — the official public RPC is rate-limited; set ROBINHOOD_RPC_URL to a provider such as Alchemy for production" : ""}); answering from explorer data only.`);
      }

      // 2. Run the bounded workflow(s).
      const sections: Section[] = [];
      if (q.invalid.length) {
        sections.push({
          title: "Input validation",
          content: q.invalid.map((i) => `- ${i.reason}. It was not queried.`).join("\n"),
          relevance: 1,
        });
      }
      if (q.kind === "transaction") for (const h of q.txHashes) sections.push(...(await analyzeTransaction(h, ctx)));
      else if (q.kind === "address") for (const a of q.addresses) sections.push(...(await analyzeAddress(a, ctx)));
      else if (q.kind === "block") sections.push(...(await analyzeBlock(q.block ?? "latest", ctx)));
      else if (!q.invalid.length || q.focus.length) sections.push(...(await analyzeNetwork(q, ctx)));

      // One URL per source: several sections about the same address/network would otherwise be
      // merged as duplicates. Later sections keep their links via citableUrls.
      const usedUrls = new Set<string>();
      const sources: SourceInput[] = sections.map((s) => ({
        title: s.title,
        ...(s.url && !usedUrls.has(s.url) && usedUrls.add(s.url) ? { url: s.url } : {}),
        type: "onchain",
        evidence: "live_data",
        content: s.content,
        snippet: s.content.split("\n").slice(0, 2).join(" · ").slice(0, 300),
        relevance: s.relevance,
      }));

      const explorerUsed = budget.explorerCalls > 0;
      return {
        data: {
          chain: { name: chain.name, chainId: chain.chainId, ...(chain.explorerUrl ? { explorer: chain.explorerUrl } : {}), rpc: chain.publicRpc ? "public" : "custom" },
          kind: q.kind,
          targets: q.kind === "transaction" ? q.txHashes : q.kind === "address" ? q.addresses : q.kind === "block" ? [String(q.block ?? "latest")] : [],
          sections: sections.map((s) => ({ title: s.title, ...(s.url ? { url: s.url } : {}) })),
          dataSources: {
            rpc: ctx.rpcDown ? "unavailable" : "ok",
            explorer: !explorer ? "not configured" : ctx.explorerDown || ([...ctx.notices].some((n) => n.startsWith("Explorer data unavailable")) && !explorerUsed) ? "unavailable" : "ok",
          },
          requests: { rpc: budget.rpcCalls, explorer: budget.explorerCalls },
          invalid: q.invalid,
        },
        sources,
        notices: [...ctx.notices],
        citableUrls: [...ctx.citable],
      };
    },
  };
}
