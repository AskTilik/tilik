import type { ChainConfig } from "../../config/chains.js";
import { explorerLinks } from "../../config/chains.js";
import { toVeyraError, VeyraError } from "../../core/errors.js";
import type { Entities } from "../../router/intent.js";
import { explorerLabel, type BlockscoutExplorer, type BsAddressRef, type BsToken, type BsTokenTransfer, type BsTransaction } from "./explorer.js";
import {
  decodeString,
  decodeUint,
  encodeAddressArg,
  ERC20,
  formatUnits,
  isTxHash,
  KNOWN_EVENTS,
  KNOWN_FUNCTIONS,
  malformedHexTokens,
  shortAddr,
  topicToAddress,
  toChecksumAddress,
  TRANSFER_TOPIC,
  validateAddress,
} from "./evm.js";
import type { BlockchainProvider, BlockInfo, ChainBudget, LogInfo } from "./types.js";

// ── Question → plan (deterministic, free) ────────────────────────────────────

export type OnchainKind = "transaction" | "address" | "block" | "network";
export type Focus = "largest_transfers" | "active_contracts" | "trend" | "tokens" | "recent";

export interface OnchainQuery {
  kind: OnchainKind;
  txHashes: string[];
  addresses: string[];
  block?: number | "latest";
  focus: Focus[];
  /** User-supplied values that failed validation, with the reason (reported back, never queried). */
  invalid: { value: string; reason: string }[];
}

export function planOnchainQuery(question: string, entities: Entities, maxTargets: number): OnchainQuery {
  const invalid: OnchainQuery["invalid"] = [];
  const addresses: string[] = [];
  // Re-read addresses with their original case so EIP-55 checksums can be verified.
  for (const raw of [...new Set([...question.matchAll(/(?<![0-9a-zA-Z])0x[0-9a-fA-F]{40}(?![0-9a-zA-Z])/g)].map((m) => m[0]))]) {
    const v = validateAddress(raw);
    if (v.ok) addresses.push(v.address);
    else invalid.push({ value: raw, reason: v.reason });
  }
  // Inherited from conversation context (already lower-cased by entity extraction) — but never
  // re-admit an address whose checksum failed in the original text.
  const rejected = new Set(invalid.map((i) => i.value.toLowerCase()));
  for (const a of entities.addresses) {
    const v = validateAddress(a);
    if (v.ok && !rejected.has(a.toLowerCase()) && !addresses.some((x) => x.toLowerCase() === v.address.toLowerCase())) addresses.push(v.address);
  }
  const txHashes = [...new Set(entities.txHashes.filter(isTxHash).map((h) => h.toLowerCase()))];
  for (const bad of malformedHexTokens(question)) {
    invalid.push({ value: bad, reason: `"${bad.slice(0, 18)}…" is neither a valid address (0x + 40 hex) nor a transaction hash (0x + 64 hex)` });
  }

  const blockMatch = /\bblock\s*(?:#|number\s*)?(\d{1,12})\b/i.exec(question);
  const block = blockMatch ? Number(blockMatch[1]) : /\b(latest|last|current|newest) block\b/i.test(question) ? ("latest" as const) : undefined;

  const focus: Focus[] = [];
  if (/\b(largest|biggest|whale|big|huge|top)\b.{0,20}\b(transfers?|transactions?|moves?)\b/i.test(question)) focus.push("largest_transfers");
  if (/\b(most active|busiest|top|popular|hottest)\b.{0,20}\b(contracts?|apps?|protocols?|addresses)\b/i.test(question)) focus.push("active_contracts");
  if (/\b(increas|decreas|grow|declin|trend|compared|change|changed|more|less|today|yesterday|activity)\w*/i.test(question)) focus.push("trend");
  if (/\b(tokens?|tokeni[sz]ed|stocks?|stablecoins?|assets?)\b/i.test(question)) focus.push("tokens");
  if (/\b(recent|latest|now|happening|happened)\b/i.test(question)) focus.push("recent");

  const kind: OnchainKind = txHashes.length ? "transaction" : addresses.length ? "address" : block !== undefined ? "block" : "network";
  return {
    kind,
    txHashes: txHashes.slice(0, maxTargets),
    addresses: addresses.slice(0, maxTargets),
    ...(block !== undefined ? { block } : {}),
    focus: [...new Set(focus)],
    invalid,
  };
}

// ── Execution context ────────────────────────────────────────────────────────

export interface Section {
  title: string;
  url?: string;
  content: string;
  relevance: number;
}

export interface Limits {
  maxTransactions: number;
  maxLogs: number;
  blockWindow: number;
}

export class AnalysisContext {
  readonly notices = new Set<string>();
  readonly citable = new Set<string>();
  readonly links;
  private readonly tokenCache = new Map<string, Promise<TokenMeta>>();
  rpcDown?: string;

  constructor(
    readonly chain: ChainConfig,
    readonly provider: BlockchainProvider,
    readonly explorer: BlockscoutExplorer | undefined,
    readonly budget: ChainBudget,
    readonly limits: Limits,
  ) {
    this.links = explorerLinks(chain);
  }

  link(kind: "tx" | "address" | "block" | "token", id: string | number): string | undefined {
    const url = kind === "tx" ? this.links.tx(String(id)) : kind === "address" ? this.links.address(String(id)) : kind === "block" ? this.links.block(id) : this.links.token(String(id));
    if (url) this.citable.add(url);
    return url;
  }

  /** Set after an auth/quota failure: no further explorer calls in this request. */
  explorerDown?: string;

  /** Optional explorer data: failures become notices, never errors. */
  async fromExplorer<T>(what: string, fn: (e: BlockscoutExplorer) => Promise<T | null>): Promise<T | undefined> {
    if (!this.explorer || this.explorerDown) return undefined;
    try {
      return (await fn(this.explorer)) ?? undefined;
    } catch (err) {
      const e = toVeyraError(err, "explorer");
      if (e.kind === "aborted") throw e;
      if (e.kind === "auth" || e.kind === "quota") {
        // Won't fix itself within this request: one clear notice, stop calling.
        this.explorerDown = e.kind;
        this.notices.add(`Explorer API unavailable: ${e.message}. Answering from RPC data only.`);
      } else this.notices.add(`Explorer data unavailable for ${what} (${e.kind}).`);
      return undefined;
    }
  }

  /** RPC data that the answer can do without (e.g. confirmations): failures become notices. */
  async optionalRpc<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (this.rpcDown) return undefined;
    try {
      return await fn();
    } catch (err) {
      const e = toVeyraError(err, "rpc");
      if (e.kind === "aborted") throw e;
      this.notices.add(`Could not read ${what} from the RPC (${e.kind}).`);
      return undefined;
    }
  }

  /** `light`: symbol + decimals only (enough to format a transfer) — half the RPC calls. */
  tokenMeta(address: string, opts: { light?: boolean } = {}): Promise<TokenMeta> {
    const key = `${address.toLowerCase()}:${opts.light ? "light" : "full"}`;
    let p = this.tokenCache.get(key) ?? (opts.light ? this.tokenCache.get(`${address.toLowerCase()}:full`) : undefined);
    if (!p) {
      p = readTokenMeta(this, address, Boolean(opts.light));
      this.tokenCache.set(key, p);
    }
    return p;
  }
}

export interface TokenMeta {
  address: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: bigint;
  holders?: number;
  source: "explorer" | "rpc" | "none";
}

async function readTokenMeta(ctx: AnalysisContext, address: string, light: boolean): Promise<TokenMeta> {
  const bs = await ctx.fromExplorer(`token ${shortAddr(address)}`, (e) => e.token(address, ctx.budget));
  if (bs && (bs.symbol || bs.decimals)) return fromBsToken(bs);
  if (ctx.rpcDown) return { address, source: "none" };
  // eth_call the ERC-20 metadata functions; any that revert/are missing simply stay unknown.
  const call = (data: string) => ctx.provider.call(address, data, ctx.budget, { stable: true }).catch(() => "0x");
  const [name, symbol, decimals, supply] = await Promise.all([
    light ? Promise.resolve("0x") : call(ERC20.name),
    call(ERC20.symbol),
    call(ERC20.decimals),
    light ? Promise.resolve("0x") : call(ERC20.totalSupply),
  ]);
  const dec = decodeUint(decimals);
  const sup = decodeUint(supply);
  const meta: TokenMeta = {
    address,
    ...(decodeString(name) ? { name: decodeString(name)! } : {}),
    ...(decodeString(symbol) ? { symbol: decodeString(symbol)! } : {}),
    ...(dec !== undefined && dec <= 255n ? { decimals: Number(dec) } : {}),
    ...(sup !== undefined ? { totalSupply: sup } : {}),
    source: "rpc",
  };
  return meta.symbol || meta.decimals !== undefined ? meta : { address, source: "none" };
}

function fromBsToken(t: BsToken): TokenMeta {
  return {
    address: toChecksumAddress(t.address_hash),
    ...(t.name ? { name: clean(t.name) } : {}),
    ...(t.symbol ? { symbol: clean(t.symbol) } : {}),
    ...(t.decimals !== null && t.decimals !== undefined && /^\d+$/.test(t.decimals) ? { decimals: Number(t.decimals) } : {}),
    ...(t.total_supply && /^\d+$/.test(t.total_supply) ? { totalSupply: BigInt(t.total_supply) } : {}),
    ...(t.holders_count && /^\d+$/.test(t.holders_count) ? { holders: Number(t.holders_count) } : {}),
    source: "explorer",
  };
}

// ── Workflows ────────────────────────────────────────────────────────────────

export async function analyzeTransaction(hash: string, ctx: AnalysisContext): Promise<Section[]> {
  const tx = ctx.rpcDown ? undefined : await ctx.provider.transaction(hash, ctx.budget);
  const bs = await ctx.fromExplorer(`transaction ${hash.slice(0, 10)}…`, (e) => e.transaction(hash, ctx.budget));

  if (!tx && !bs) {
    // A 32-byte hash may be a block hash.
    const block = ctx.rpcDown ? null : await ctx.provider.block(hash, ctx.budget);
    if (block) return analyzeBlock(block.number, ctx);
    return [
      {
        title: `Lookup: ${hash}`,
        content: `No transaction or block with hash ${hash} exists on ${ctx.chain.name} (chain ${ctx.chain.chainId})${ctx.rpcDown ? " according to the explorer (the RPC was unavailable)" : " according to the RPC"}. It may belong to another network, still be pending broadcast, or contain a typo.`,
        relevance: 1,
      },
    ];
  }

  const blockNumber = tx?.blockNumber ?? bs?.block_number ?? null;
  const [receipt, block, latest, bsTransfers] = await Promise.all([
    blockNumber !== null && !ctx.rpcDown ? ctx.provider.receipt(hash, ctx.budget) : Promise.resolve(null),
    blockNumber !== null ? ctx.optionalRpc("the block timestamp", () => ctx.provider.block(blockNumber, ctx.budget)) : Promise.resolve(undefined),
    ctx.optionalRpc("the latest block", () => ctx.provider.latestBlockNumber(ctx.budget)),
    ctx.fromExplorer("token transfers", (e) => e.txTokenTransfers(hash, ctx.budget)),
  ]);

  const from = tx?.from ?? (bs ? toChecksumAddress(bs.from.hash) : "unknown");
  const to = tx ? tx.to : bs?.to ? toChecksumAddress(bs.to.hash) : null;
  const value = tx?.value ?? (bs?.value && /^\d+$/.test(bs.value) ? BigInt(bs.value) : 0n);
  const input = tx?.input ?? "0x";
  const selector = input.length >= 10 ? input.slice(0, 10).toLowerCase() : undefined;
  const method =
    input === "0x" && !bs?.method
      ? "none (plain native-token transfer)"
      : bs?.decoded_input?.method_call
        ? `${clean(bs.decoded_input.method_call)} (decoded by the explorer)`
        : selector && KNOWN_FUNCTIONS[selector]
          ? `${KNOWN_FUNCTIONS[selector]} (selector ${selector})`
          : bs?.method
            ? `${clean(bs.method)}${selector ? ` (selector ${selector})` : ""}`
            : selector
              ? `unknown function (selector ${selector}; contract not decoded)`
              : "unknown";
  const status = receipt?.status ?? (bs?.status === "ok" ? "success" : bs?.status === "error" ? "failed" : blockNumber === null ? "pending" : "unknown");
  const fee =
    receipt?.effectiveGasPrice !== undefined
      ? receipt.gasUsed * receipt.effectiveGasPrice
      : bs?.fee?.value && /^\d+$/.test(bs.fee.value)
        ? BigInt(bs.fee.value)
        : undefined;
  const timestamp = block?.timestamp ?? bs?.timestamp ?? undefined;

  const lines = [
    `Transaction ${hash} on ${ctx.chain.name} (chain ${ctx.chain.chainId})`,
    `Status: ${status}${blockNumber !== null ? ` · Block: ${blockNumber.toLocaleString("en-US")}` : " · not yet mined"}${timestamp ? ` · Time: ${timestamp}` : ""}${latest !== undefined && blockNumber !== null ? ` · Confirmations: ${(latest - blockNumber + 1).toLocaleString("en-US")}` : ""}`,
    `From: ${from}${labelFor(bs?.from)}`,
    `To: ${to ?? `(contract creation${receipt?.contractAddress ? ` → ${receipt.contractAddress}` : ""})`}${labelFor(bs?.to)}${bs?.to?.is_contract ? " [contract]" : ""}`,
    `Value: ${formatUnits(value, ctx.chain.nativeDecimals)} ${ctx.chain.nativeSymbol}`,
    `Function called: ${method}`,
    `Gas: ${receipt ? `used ${receipt.gasUsed.toLocaleString("en-US")}` : "used unknown"}${tx ? ` of limit ${tx.gas.toLocaleString("en-US")}` : ""}${receipt?.effectiveGasPrice !== undefined ? ` · effective gas price ${formatUnits(receipt.effectiveGasPrice, 9, 4)} gwei` : ""}${fee !== undefined ? ` · fee ${formatUnits(fee, ctx.chain.nativeDecimals, 9)} ${ctx.chain.nativeSymbol}` : ""}`,
  ];
  if (from !== "unknown") ctx.link("address", from);
  if (to) ctx.link("address", to);
  if (blockNumber !== null) ctx.link("block", blockNumber);

  // Events: decode what we can, label the rest honestly.
  const logs = receipt?.logs ?? [];
  if (logs.length) {
    const shown = logs.slice(0, ctx.limits.maxLogs);
    const decoded = await Promise.all(shown.map((l) => describeLog(l, ctx)));
    lines.push(`Events emitted: ${logs.length}${logs.length > shown.length ? ` (showing ${shown.length})` : ""}`, ...decoded.map((d) => `- ${d}`));
  } else if (receipt) lines.push("Events emitted: none");
  if (bsTransfers?.items?.length) {
    lines.push(`Token transfers (explorer): ${bsTransfers.items.length}`, ...bsTransfers.items.slice(0, 10).map((t) => `- ${describeBsTransfer(t, ctx)}`));
  }
  if (!receipt && !ctx.rpcDown && blockNumber !== null) lines.push("Receipt: unavailable from the RPC.");

  return [{ title: `Transaction ${shortAddr(hash)} — ${status}`, ...urlField(ctx.link("tx", hash)), content: lines.join("\n"), relevance: 1 }];
}

export async function analyzeAddress(address: string, ctx: AnalysisContext): Promise<Section[]> {
  const [balance, sent, code, info, counters] = await Promise.all([
    ctx.optionalRpc("the balance", () => ctx.provider.balance(address, ctx.budget)),
    ctx.optionalRpc("the transaction count", () => ctx.provider.transactionCount(address, ctx.budget)),
    ctx.optionalRpc("the contract code", () => ctx.provider.code(address, ctx.budget)),
    ctx.fromExplorer(`address ${shortAddr(address)}`, (e) => e.address(address, ctx.budget)),
    ctx.fromExplorer("address counters", (e) => e.addressCounters(address, ctx.budget)),
  ]);
  if (balance === undefined && !info) throw new VeyraError("upstream", "rpc", `Could not read ${address} from the RPC or the explorer`);

  const isContract = code !== undefined ? code !== "0x" : Boolean(info?.is_contract);
  const nativeBalance = balance ?? (info?.coin_balance && /^\d+$/.test(info.coin_balance) ? BigInt(info.coin_balance) : undefined);
  const token = isContract ? await ctx.tokenMeta(address) : undefined;
  const isToken = Boolean(token && token.source !== "none");

  const overview = [
    `Address ${address} on ${ctx.chain.name} (chain ${ctx.chain.chainId})`,
    `Type: ${isContract ? (isToken ? "token contract" : "smart contract") : "externally owned account (EOA)"}${code !== undefined && isContract ? ` · bytecode ${((code.length - 2) / 2).toLocaleString("en-US")} bytes` : ""}`,
    `Native balance: ${nativeBalance !== undefined ? `${formatUnits(nativeBalance, ctx.chain.nativeDecimals)} ${ctx.chain.nativeSymbol}` : "unavailable"}`,
    sent !== undefined && !isContract ? `Transactions sent (nonce): ${sent.toLocaleString("en-US")}` : undefined,
    counters?.transactions_count ? `Transactions involving this address (explorer count): ${Number(counters.transactions_count).toLocaleString("en-US")}` : undefined,
    counters?.token_transfers_count ? `Token transfers involving this address (explorer count): ${Number(counters.token_transfers_count).toLocaleString("en-US")}` : undefined,
    explorerLabel(info) ? `Explorer label (third-party annotation, not verified identity): ${explorerLabel(info)}` : "Explorer label: none — ownership/identity unknown",
    info?.is_verified !== null && info?.is_verified !== undefined && isContract ? `Source code verified on the explorer: ${info.is_verified ? "yes" : "no"}` : undefined,
    info?.proxy_type ? `Proxy: ${clean(info.proxy_type)}${info.implementations?.length ? ` → implementation ${info.implementations.map((i) => `${i.address_hash ?? i.address}${i.name ? ` (${clean(i.name)})` : ""}`).join(", ")}` : ""}` : undefined,
    info?.creator_address_hash ? `Created by ${toChecksumAddress(info.creator_address_hash)}${info.creation_transaction_hash ? ` in tx ${info.creation_transaction_hash}` : ""}` : undefined,
    info?.is_scam ? "⚠ The explorer flags this address as a scam." : undefined,
  ].filter(Boolean);
  if (info?.creator_address_hash) ctx.link("address", toChecksumAddress(info.creator_address_hash));
  if (info?.creation_transaction_hash) ctx.link("tx", info.creation_transaction_hash);

  const sections: Section[] = [{ title: `Address ${shortAddr(address)} — overview`, ...urlField(ctx.link("address", address)), content: overview.join("\n"), relevance: 1 }];

  if (isToken && token) {
    sections.push({
      title: `Token ${token.symbol ?? shortAddr(address)} — metadata`,
      ...urlField(ctx.link("token", address)),
      content: [
        `Token contract: ${address}`,
        `Name: ${token.name ?? "unavailable"} · Symbol: ${token.symbol ?? "unavailable"} · Decimals: ${token.decimals ?? "unavailable"}`,
        `Total supply: ${token.totalSupply !== undefined && token.decimals !== undefined ? `${formatUnits(token.totalSupply, token.decimals, 2)} ${token.symbol ?? ""}` : "unavailable"}`,
        `Holders: ${token.holders !== undefined ? token.holders.toLocaleString("en-US") : "unavailable (needs the explorer API)"}`,
        `Metadata source: ${token.source === "explorer" ? "explorer API" : "on-chain ERC-20 calls"}. Name and symbol are set by the deployer and are not proof of authenticity.`,
      ].join("\n"),
      relevance: 0.98,
    });
  }

  if (!ctx.explorer) {
    ctx.notices.add("Transaction history, token holdings and labels need an explorer API (RPC has no address index) — set ROBINHOOD_EXPLORER_API_URL.");
    return sections;
  }

  const [txs, transfers, tokens] = await Promise.all([
    ctx.fromExplorer("recent transactions", (e) => e.addressTransactions(address, ctx.budget)),
    isToken ? ctx.fromExplorer("token transfers", (e) => e.tokenTransfers(address, ctx.budget)) : ctx.fromExplorer("token transfers", (e) => e.addressTokenTransfers(address, ctx.budget)),
    isContract ? Promise.resolve(undefined) : ctx.fromExplorer("token balances", (e) => e.addressTokens(address, ctx.budget)),
  ]);

  const list = (txs?.items ?? []).slice(0, ctx.limits.maxTransactions);
  if (list.length) {
    const counterparties = new Map<string, number>();
    const methods = new Map<string, number>();
    const days = new Map<string, number>();
    for (const t of list) {
      const other = t.from.hash.toLowerCase() === address.toLowerCase() ? t.to?.hash : t.from.hash;
      if (other) counterparties.set(other, (counterparties.get(other) ?? 0) + 1);
      methods.set(clean(t.method ?? "transfer"), (methods.get(clean(t.method ?? "transfer")) ?? 0) + 1);
      if (t.timestamp) days.set(t.timestamp.slice(0, 10), (days.get(t.timestamp.slice(0, 10)) ?? 0) + 1);
    }
    const stamps = list.map((t) => t.timestamp).filter((s): s is string => Boolean(s)).sort();
    sections.push({
      title: `Address ${shortAddr(address)} — ${list.length} most recent transactions`,
      ...urlField(ctx.link("address", address)),
      content: [
        `Sample: the ${list.length} most recent transactions (explorer)${stamps.length ? `, from ${stamps[0]} to ${stamps.at(-1)}` : ""}.`,
        `Activity by day (sample): ${[...days].sort().map(([d, n]) => `${d}: ${n}`).join(", ")}`,
        `Most frequent counterparties (sample): ${top(counterparties, 5).map(([a, n]) => `${toChecksumAddress(a)} (${n}×)`).join(", ")}`,
        `Functions called (sample): ${top(methods, 6).map(([m, n]) => `${m} (${n}×)`).join(", ")}`,
        ...list.map((t) => `- ${describeBsTx(t, address, ctx)}`),
      ].join("\n"),
      relevance: 0.95,
    });
    for (const [a] of top(counterparties, 5)) ctx.link("address", toChecksumAddress(a));
  } else if (txs) {
    sections.push({ title: `Address ${shortAddr(address)} — transactions`, content: "The explorer lists no transactions for this address.", relevance: 0.9 });
  }

  const holdings = (tokens?.items ?? []).slice(0, 10);
  if (holdings.length) {
    sections.push({
      title: `Address ${shortAddr(address)} — token balances`,
      ...urlField(ctx.link("address", address)),
      content: [
        `Token balances (explorer, up to 10; no USD values — market data is not part of this answer):`,
        ...holdings.map((h) => {
          const m = fromBsToken(h.token);
          return `- ${m.symbol ?? "?"} (${m.name ?? "unnamed"}, ${m.address}): ${h.value && /^\d+$/.test(h.value) && m.decimals !== undefined ? formatUnits(BigInt(h.value), m.decimals, 4) : h.value ?? "?"}`;
        }),
        "Token names/symbols are chosen by their deployers; a familiar name does not prove a token is genuine.",
      ].join("\n"),
      relevance: 0.9,
    });
  }

  const tt = (transfers?.items ?? []).slice(0, Math.min(15, ctx.limits.maxTransactions));
  if (tt.length) {
    sections.push({
      title: `${isToken ? `Token ${token?.symbol ?? shortAddr(address)}` : `Address ${shortAddr(address)}`} — recent token transfers`,
      ...urlField(isToken ? ctx.link("token", address) : ctx.link("address", address)),
      content: [`The ${tt.length} most recent token transfers (explorer):`, ...tt.map((t) => `- ${describeBsTransfer(t, ctx)}`)].join("\n"),
      relevance: 0.88,
    });
  }
  return sections;
}

export async function analyzeBlock(id: number | "latest", ctx: AnalysisContext): Promise<Section[]> {
  if (ctx.rpcDown) throw new VeyraError("upstream", "rpc", `Block data needs the RPC, which is unavailable (${ctx.rpcDown})`);
  const block = await ctx.provider.block(id, ctx.budget, { full: true });
  if (!block) {
    const latest = await ctx.optionalRpc("the latest block", () => ctx.provider.latestBlockNumber(ctx.budget));
    return [
      {
        title: `Lookup: block ${id}`,
        content: `Block ${typeof id === "number" ? id.toLocaleString("en-US") : id} does not exist on ${ctx.chain.name} yet${latest !== undefined ? ` (latest block is ${latest.toLocaleString("en-US")})` : ""}.`,
        relevance: 1,
      },
    ];
  }
  return [blockSection(block, ctx)];
}

function blockSection(block: BlockInfo, ctx: AnalysisContext): Section {
  const txs = block.transactions ?? [];
  const recipients = new Map<string, number>();
  let moved = 0n;
  for (const t of txs) {
    if (t.to) recipients.set(t.to, (recipients.get(t.to) ?? 0) + 1);
    moved += t.value;
  }
  const largest = [...txs].filter((t) => t.value > 0n).sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0)).slice(0, 5);
  const utilization = block.gasLimit > 0n ? Number((block.gasUsed * 10000n) / block.gasLimit) / 100 : 0;
  const shown = txs.slice(0, ctx.limits.maxTransactions);
  for (const t of shown) ctx.link("tx", t.hash);
  return {
    title: `Block ${block.number.toLocaleString("en-US")}`,
    ...urlField(ctx.link("block", block.number)),
    content: [
      `Block ${block.number.toLocaleString("en-US")} on ${ctx.chain.name} (chain ${ctx.chain.chainId}) · hash ${block.hash}`,
      `Time: ${block.timestamp} · Transactions: ${block.txCount} · Gas used: ${block.gasUsed.toLocaleString("en-US")} of ${block.gasLimit.toLocaleString("en-US")} (${utilization}%)${block.baseFeePerGas !== undefined ? ` · Base fee: ${formatUnits(block.baseFeePerGas, 9, 4)} gwei` : ""}`,
      `Native value moved: ${formatUnits(moved, ctx.chain.nativeDecimals)} ${ctx.chain.nativeSymbol}`,
      recipients.size ? `Most called addresses: ${top(recipients, 5).map(([a, n]) => `${a} (${n}×)`).join(", ")}` : undefined,
      largest.length ? `Largest native transfers: ${largest.map((t) => `${formatUnits(t.value, ctx.chain.nativeDecimals)} ${ctx.chain.nativeSymbol} ${shortAddr(t.from)}→${t.to ? shortAddr(t.to) : "new contract"} (tx ${t.hash})`).join("; ")}` : undefined,
      shown.length ? `Transactions${txs.length > shown.length ? ` (first ${shown.length} of ${txs.length})` : ""}:` : undefined,
      ...shown.map((t) => `- ${t.hash} ${t.from} → ${t.to ?? "(contract creation)"} · ${formatUnits(t.value, ctx.chain.nativeDecimals)} ${ctx.chain.nativeSymbol}${t.input.length >= 10 ? ` · ${KNOWN_FUNCTIONS[t.input.slice(0, 10).toLowerCase()] ?? `selector ${t.input.slice(0, 10)}`}` : ""}`),
    ]
      .filter(Boolean)
      .join("\n"),
    relevance: 1,
  };
}

/** Bounded network overview: never scans more than the configured windows/samples. */
export async function analyzeNetwork(q: OnchainQuery, ctx: AnalysisContext): Promise<Section[]> {
  const sections: Section[] = [];
  const wantTokens = q.focus.includes("tokens");
  const [latest, stats, chart, recentTxs, recentTransfers, topTokens] = await Promise.all([
    ctx.optionalRpc("the latest block", () => ctx.provider.block("latest", ctx.budget)),
    ctx.fromExplorer("network statistics", (e) => e.stats(ctx.budget)),
    ctx.fromExplorer("daily transaction history", (e) => e.txChart(ctx.budget)),
    ctx.fromExplorer("recent transactions", (e) => e.recentTransactions(ctx.budget)),
    ctx.fromExplorer("recent token transfers", (e) => e.recentTokenTransfers(ctx.budget)),
    wantTokens ? ctx.fromExplorer("top tokens", (e) => e.topTokens(ctx.budget)) : Promise.resolve(undefined),
  ]);
  if (!latest && !stats) throw new VeyraError("upstream", "rpc", "Neither the RPC nor the explorer returned network data");

  // 1. Network status.
  const status = [
    `${ctx.chain.name} (chain ${ctx.chain.chainId})`,
    latest ? `Latest block: ${latest.number.toLocaleString("en-US")} at ${latest.timestamp} (${latest.txCount} transactions in that block)` : "Latest block: unavailable (RPC)",
    stats?.average_block_time !== undefined ? `Average block time (explorer): ${(stats.average_block_time / 1000).toFixed(2)} s` : undefined,
    stats?.total_transactions ? `Total transactions to date (explorer): ${Number(stats.total_transactions).toLocaleString("en-US")}` : undefined,
    stats?.total_addresses ? `Total addresses (explorer): ${Number(stats.total_addresses).toLocaleString("en-US")}` : undefined,
  ].filter(Boolean);
  if (latest) ctx.link("block", latest.number);
  sections.push({ title: `${ctx.chain.name} — network status`, ...urlField(ctx.links.home()), content: status.join("\n"), relevance: 1 });

  // 2. Daily activity and trend.
  const days = [...(chart?.chart_data ?? [])].filter((d) => typeof d.transactions_count === "number").sort((a, b) => a.date.localeCompare(b.date)).slice(-8);
  if (days.length || stats?.transactions_today) {
    const lines = [`Daily transaction counts (explorer):`, ...days.map((d) => `- ${d.date}: ${d.transactions_count.toLocaleString("en-US")}`)];
    if (stats?.transactions_today) lines.push(`Explorer "transactions today" figure: ${Number(stats.transactions_today).toLocaleString("en-US")} (the explorer's own daily window; it may lag the calendar day).`);
    if (days.length >= 3) {
      const last = days.at(-1)!;
      const prior = days.slice(0, -1);
      const avg = prior.reduce((s, d) => s + d.transactions_count, 0) / prior.length;
      const change = ((last.transactions_count - avg) / avg) * 100;
      lines.push(
        `Trend: ${last.date} had ${last.transactions_count.toLocaleString("en-US")} transactions, ${Math.abs(change).toFixed(1)}% ${change >= 0 ? "above" : "below"} the average of the ${prior.length} preceding days (${Math.round(avg).toLocaleString("en-US")}).`,
      );
    }
    if (stats?.gas_used_today) lines.push(`Gas used today (explorer): ${Number(stats.gas_used_today).toLocaleString("en-US")}`);
    sections.push({ title: `${ctx.chain.name} — daily activity`, ...urlField(ctx.links.home()), content: lines.join("\n"), relevance: 0.97 });
  }

  // 3. Recent transactions sample: most active contracts, largest native transfers.
  const txs = (recentTxs?.items ?? []).slice(0, Math.max(ctx.limits.maxTransactions, 10));
  if (txs.length) {
    const targets = new Map<string, { n: number; label?: string }>();
    for (const t of txs) {
      if (!t.to) continue;
      const prev = targets.get(t.to.hash) ?? { n: 0, ...(explorerLabel(t.to) ? { label: explorerLabel(t.to)! } : {}) };
      prev.n++;
      targets.set(t.to.hash, prev);
    }
    const byValue = txs.filter((t) => /^\d+$/.test(t.value) && t.value !== "0").sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1)).slice(0, 5);
    const stamps = txs.map((t) => t.timestamp).filter((s): s is string => Boolean(s)).sort();
    const busiest = [...targets].sort((a, b) => b[1].n - a[1].n).slice(0, 8);
    for (const [a] of busiest) ctx.link("address", toChecksumAddress(a));
    sections.push({
      title: `${ctx.chain.name} — most recent transactions (sample)`,
      ...urlField(ctx.links.home()),
      content: [
        `Sample: the ${txs.length} most recent transactions (explorer)${stamps.length ? `, ${stamps[0]} → ${stamps.at(-1)}` : ""}. This is a snapshot, not a full-day ranking.`,
        `Most called contracts/addresses in the sample: ${busiest.map(([a, v]) => `${toChecksumAddress(a)}${v.label ? ` ("${v.label}", explorer label)` : ""} (${v.n}×)`).join("; ")}`,
        byValue.length
          ? `Largest native-token transfers in the sample: ${byValue.map((t) => `${formatUnits(BigInt(t.value), ctx.chain.nativeDecimals)} ${ctx.chain.nativeSymbol} (tx ${t.hash})`).join("; ")}`
          : "No native-token value moved in the sample.",
      ].join("\n"),
      relevance: 0.93,
    });
    for (const t of byValue) ctx.link("tx", t.hash);
  }

  // 4. Recent token transfers: explorer sample, or a small RPC log window if no explorer.
  const transfers = (recentTransfers?.items ?? []).slice(0, ctx.limits.maxLogs);
  if (transfers.length) {
    sections.push(tokenTransferSection(transfers, ctx, `the ${transfers.length} most recent token transfers (explorer)`));
  } else if (!ctx.rpcDown && latest && (q.focus.includes("largest_transfers") || q.focus.includes("active_contracts") || !ctx.explorer)) {
    const s = await rpcTransferWindow(latest.number, ctx);
    if (s) sections.push(s);
  }

  // 5. Tokens by holders.
  const tokens = (topTokens?.items ?? []).slice(0, 10);
  if (tokens.length) {
    for (const t of tokens) ctx.link("token", toChecksumAddress(t.address_hash));
    sections.push({
      title: `${ctx.chain.name} — tokens with the most holders`,
      ...urlField(ctx.links.home()),
      content: [
        "ERC-20 tokens ranked by holder count (explorer). Names/symbols are set by deployers — a familiar name does not prove authenticity. No prices (market data is not part of this answer).",
        ...tokens.map((t) => {
          const m = fromBsToken(t);
          return `- ${m.symbol ?? "?"} (${m.name ?? "unnamed"}) ${m.address}: ${m.holders?.toLocaleString("en-US") ?? "?"} holders`;
        }),
      ].join("\n"),
      relevance: 0.9,
    });
  }
  if (!ctx.explorer) ctx.notices.add("Daily statistics, trends and token rankings need the explorer API — only a short RPC block window was analysed.");
  return sections;
}

async function rpcTransferWindow(latest: number, ctx: AnalysisContext): Promise<Section | undefined> {
  let window = Math.max(1, ctx.limits.blockWindow);
  let logs: LogInfo[] | undefined;
  for (let attempt = 0; attempt < 2 && !logs; attempt++) {
    try {
      logs = await ctx.provider.logs({ fromBlock: latest - window + 1, toBlock: latest, topics: [TRANSFER_TOPIC] }, ctx.budget);
    } catch (err) {
      const e = toVeyraError(err, "rpc");
      if (e.kind === "aborted") throw e;
      if (e.kind === "bad_request" && /too large/i.test(e.message) && window > 1) window = Math.ceil(window / 2); // shrink once
      else {
        ctx.notices.add(`Could not read recent transfer events from the RPC (${e.kind}).`);
        return undefined;
      }
    }
  }
  if (!logs) return undefined;
  const erc20 = logs.filter((l) => l.topics.length === 3).slice(0, ctx.limits.maxLogs);
  const byToken = new Map<string, LogInfo[]>();
  for (const l of erc20) byToken.set(l.address, [...(byToken.get(l.address) ?? []), l]);
  const busiest = [...byToken].sort((a, b) => b[1].length - a[1].length).slice(0, 5);
  const lines = [`Window: blocks ${(latest - window + 1).toLocaleString("en-US")}–${latest.toLocaleString("en-US")} (${window} blocks ≈ ${(window * 0.1).toFixed(1)} s on this chain) via RPC logs; ${logs.length} Transfer events${logs.length > erc20.length ? `, ${erc20.length} analysed` : ""}.`];
  // Token metadata for the busiest tokens, fetched in parallel (symbol + decimals only).
  const metas = await Promise.all(busiest.map(([token]) => ctx.tokenMeta(token, { light: true })));
  for (const [i, [token, ls]] of busiest.entries()) {
    const meta = metas[i]!;
    const biggest = ls.map((l) => ({ l, v: decodeUint(l.data) ?? 0n })).sort((a, b) => (b.v > a.v ? 1 : -1))[0]!;
    ctx.link("token", token);
    ctx.link("tx", biggest.l.txHash);
    lines.push(
      `- ${meta.symbol ?? "unknown token"} ${token}: ${ls.length} transfers; largest ${meta.decimals !== undefined ? formatUnits(biggest.v, meta.decimals, 4) : `${biggest.v} (raw units, decimals unknown)`} ${meta.symbol ?? ""} (tx ${biggest.l.txHash})`,
    );
  }
  return { title: `${ctx.chain.name} — token transfers in the last ${window} blocks`, ...urlField(ctx.links.home()), content: lines.join("\n"), relevance: 0.92 };
}

function tokenTransferSection(transfers: BsTokenTransfer[], ctx: AnalysisContext, what: string): Section {
  const byToken = new Map<string, BsTokenTransfer[]>();
  for (const t of transfers) byToken.set(t.token.address_hash, [...(byToken.get(t.token.address_hash) ?? []), t]);
  const busiest = [...byToken].sort((a, b) => b[1].length - a[1].length).slice(0, 6);
  const lines = [`Sample: ${what}. Amounts are compared within each token only (no USD prices).`];
  for (const [addr, list] of busiest) {
    const m = fromBsToken(list[0]!.token);
    const biggest = list
      .map((t) => ({ t, v: t.total?.value && /^\d+$/.test(t.total.value) ? BigInt(t.total.value) : 0n }))
      .sort((a, b) => (b.v > a.v ? 1 : -1))[0]!;
    ctx.link("token", toChecksumAddress(addr));
    ctx.link("tx", biggest.t.transaction_hash);
    lines.push(`- ${m.symbol ?? "?"} (${m.address}): ${list.length} transfers; largest ${m.decimals !== undefined ? formatUnits(biggest.v, m.decimals, 4) : biggest.v.toString()} ${m.symbol ?? ""} (tx ${biggest.t.transaction_hash})`);
  }
  return { title: `${ctx.chain.name} — recent token transfers (sample)`, ...urlField(ctx.links.home()), content: lines.join("\n"), relevance: 0.92 };
}

// ── Formatting helpers ───────────────────────────────────────────────────────

async function describeLog(l: LogInfo, ctx: AnalysisContext): Promise<string> {
  const topic0 = l.topics[0]?.toLowerCase();
  const sig = topic0 ? KNOWN_EVENTS[topic0] : undefined;
  if (topic0 === TRANSFER_TOPIC && l.topics.length === 3) {
    const meta = await ctx.tokenMeta(l.address, { light: true });
    const amount = decodeUint(l.data);
    ctx.link("token", l.address);
    const from = topicToAddress(l.topics[1]);
    const to = topicToAddress(l.topics[2]);
    const what =
      amount !== undefined && meta.decimals !== undefined ? `${formatUnits(amount, meta.decimals, 4)} ${meta.symbol ?? "tokens"}` : `${amount ?? "?"} raw units of ${meta.symbol ?? "an unknown token"}`;
    const kind = from === "0x0000000000000000000000000000000000000000" ? "Mint" : to === "0x0000000000000000000000000000000000000000" ? "Burn" : "Transfer";
    return `${kind}: ${what} from ${from} to ${to} (token ${l.address})`;
  }
  if (topic0 === TRANSFER_TOPIC && l.topics.length === 4) return `NFT Transfer (ERC-721) token #${decodeUint(l.topics[3] ?? "0x") ?? "?"} at ${l.address} from ${topicToAddress(l.topics[1])} to ${topicToAddress(l.topics[2])}`;
  return sig ? `${sig.split("(")[0]} event (${sig}) at ${l.address}` : `Unrecognized event (topic ${topic0?.slice(0, 10) ?? "none"}…) at ${l.address}`;
}

function describeBsTransfer(t: BsTokenTransfer, ctx: AnalysisContext): string {
  const m = fromBsToken(t.token);
  const v = t.total?.value && /^\d+$/.test(t.total.value) ? BigInt(t.total.value) : undefined;
  const dec = t.total?.decimals && /^\d+$/.test(t.total.decimals) ? Number(t.total.decimals) : m.decimals;
  ctx.link("tx", t.transaction_hash);
  return `${t.timestamp ?? "?"} ${v !== undefined && dec !== undefined ? formatUnits(v, dec, 4) : "?"} ${m.symbol ?? "?"} from ${toChecksumAddress(t.from.hash)}${labelFor(t.from)} to ${toChecksumAddress(t.to.hash)}${labelFor(t.to)} (tx ${t.transaction_hash})`;
}

function describeBsTx(t: BsTransaction, self: string, ctx: AnalysisContext): string {
  const out = t.from.hash.toLowerCase() === self.toLowerCase();
  const other = out ? t.to : t.from;
  ctx.link("tx", t.hash);
  const value = /^\d+$/.test(t.value) && t.value !== "0" ? ` · ${formatUnits(BigInt(t.value), 18)} ETH` : "";
  return `${t.timestamp ?? "?"} ${out ? "OUT to" : "IN from"} ${other ? `${toChecksumAddress(other.hash)}${labelFor(other)}` : "(contract creation)"} · ${clean(t.method ?? "transfer")}${value} · ${t.status ?? "?"} (tx ${t.hash})`;
}

function labelFor(ref: BsAddressRef | null | undefined): string {
  const l = explorerLabel(ref);
  return l ? ` ["${l}" — explorer label]` : "";
}

function top<K>(m: Map<K, number>, n: number): [K, number][] {
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function urlField(url: string | undefined): { url?: string } {
  return url ? { url } : {};
}

/** External strings (token names, labels, method names) — strip control chars and cap length. */
function clean(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120);
}
