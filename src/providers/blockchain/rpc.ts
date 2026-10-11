import type { ChainConfig } from "../../config/chains.js";
import { cacheKey, TtlCache } from "../../cache/ttl-cache.js";
import { VeyraError, toVeyraError } from "../../core/errors.js";
import { httpRequest } from "../../core/http.js";
import { hexToBigInt, hexToNumber, toChecksumAddress, toHex } from "./evm.js";
import type { BlockchainProvider, BlockInfo, ChainBudget, LogInfo, ReceiptInfo, TxInfo } from "./types.js";

export interface RpcOptions {
  timeoutMs: number;
  retries: number;
  /** Mined blocks, receipts, token metadata. */
  stableTtlMs: number;
  /** Latest block, balances, nonces. */
  liveTtlMs: number;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const SOURCE = "rpc";

/**
 * JSON-RPC 2.0 over HTTP with:
 * - bounded retries (exponential backoff + jitter) on rate limits, timeouts, network and 5xx errors;
 * - failover to ROBINHOOD_RPC_FALLBACK_URLS;
 * - per-question call caps; caching per method/params;
 * - errors that never contain the RPC URL (provider URLs often embed API keys).
 */
export class JsonRpcClient {
  private nextId = 1;

  constructor(
    private readonly urls: string[],
    private readonly opts: RpcOptions,
    private readonly cache = new TtlCache<unknown>(2000),
  ) {}

  async call<T>(method: string, params: unknown[], budget: ChainBudget, ttlMs = 0): Promise<T> {
    const key = cacheKey("rpc", method, params);
    if (ttlMs > 0) {
      const hit = this.cache.get(key);
      if (hit !== undefined) return hit as T;
    }
    if (budget.rpcCalls >= budget.maxRpcCalls) {
      throw new VeyraError("budget", SOURCE, `On-chain request limit for this question (${budget.maxRpcCalls} RPC calls) reached`);
    }
    budget.rpcCalls++;

    let lastError: VeyraError | undefined;
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      const url = this.urls[attempt % this.urls.length]!;
      try {
        const result = await this.send(url, method, params, budget.signal);
        if (ttlMs > 0 && result !== null) this.cache.set(key, result, ttlMs);
        return result as T;
      } catch (err) {
        const e = toVeyraError(err, SOURCE);
        lastError = e;
        const retryable = e.kind === "rate_limit" || e.kind === "timeout" || e.kind === "network" || e.kind === "upstream";
        if (!retryable || attempt === this.opts.retries || budget.signal.aborted) break;
        // Respect Retry-After when short; give up rather than wait long (the request has a deadline).
        if (e.retryAfterMs !== undefined && e.retryAfterMs > 2000) break;
        const backoff = e.retryAfterMs ?? Math.min(2000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);
        await sleep(backoff, budget.signal);
      }
    }
    throw lastError ?? new VeyraError("upstream", SOURCE, "RPC request failed");
  }

  private async send(url: string, method: string, params: unknown[], signal: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const res = await httpRequest(url, {
      source: SOURCE,
      body: { jsonrpc: "2.0", id, method, params },
      timeoutMs: this.opts.timeoutMs,
      signal,
      mapError: (status, body, headers) => {
        if (status === 429) {
          const ra = Number(headers.get("retry-after"));
          return new VeyraError("rate_limit", SOURCE, "The RPC endpoint is rate-limiting requests (429)", {
            status,
            ...(Number.isFinite(ra) && ra > 0 ? { retryAfterMs: ra * 1000 } : {}),
          });
        }
        if (status === 401 || status === 403) return new VeyraError("auth", SOURCE, `The RPC endpoint rejected the request (${status}) — check ROBINHOOD_RPC_URL credentials`, { status });
        if (status >= 500) return new VeyraError("upstream", SOURCE, `The RPC endpoint returned ${status}`, { status });
        return new VeyraError("bad_request", SOURCE, `The RPC endpoint returned ${status}: ${body.slice(0, 120)}`, { status });
      },
    });
    let json: JsonRpcResponse;
    try {
      json = (await res.json()) as JsonRpcResponse;
    } catch {
      throw new VeyraError("invalid_output", SOURCE, `Malformed RPC response to ${method} (not JSON)`);
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new VeyraError("invalid_output", SOURCE, `Malformed RPC response to ${method}`);
    if (json.error) throw mapRpcError(method, json.error);
    if (!("result" in json)) throw new VeyraError("invalid_output", SOURCE, `Malformed RPC response to ${method} (no result)`);
    return json.result;
  }
}

function mapRpcError(method: string, err: { code?: number; message?: string }): VeyraError {
  const msg = String(err.message ?? "unknown error").slice(0, 200);
  if (err.code === -32601 || /method not (found|supported)|not available|unsupported/i.test(msg)) {
    return new VeyraError("bad_request", SOURCE, `The RPC endpoint does not support ${method}`);
  }
  if (err.code === -32005 || err.code === 429 || /rate|limit exceeded|too many/i.test(msg)) return new VeyraError("rate_limit", SOURCE, `RPC rate limit: ${msg}`);
  if (/more than \d+ results|range|too large|response size/i.test(msg)) return new VeyraError("bad_request", SOURCE, `RPC query too large: ${msg}`);
  if (err.code === -32602 || err.code === -32600) return new VeyraError("bad_request", SOURCE, `Invalid RPC request (${method}): ${msg}`);
  return new VeyraError("upstream", SOURCE, `RPC error (${method}): ${msg}`);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new VeyraError("aborted", SOURCE, "Aborted"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new VeyraError("aborted", SOURCE, "Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ── Generic EVM provider ─────────────────────────────────────────────────────

interface RawBlock {
  number: string;
  hash: string;
  timestamp: string;
  gasUsed: string;
  gasLimit: string;
  baseFeePerGas?: string;
  transactions: (string | RawTx)[];
}
interface RawTx {
  hash: string;
  blockNumber: string | null;
  from: string;
  to: string | null;
  value: string;
  nonce: string;
  gas: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  input: string;
  type?: string;
}
interface RawReceipt {
  status?: string;
  gasUsed: string;
  effectiveGasPrice?: string;
  contractAddress?: string | null;
  logs: RawLog[];
}
interface RawLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: string;
  blockNumber: string;
  transactionHash: string;
}

export class EvmRpcProvider implements BlockchainProvider {
  private verified = false;

  constructor(
    readonly chain: ChainConfig,
    private readonly rpc: JsonRpcClient,
    private readonly opts: RpcOptions,
  ) {}

  async ensureChain(budget: ChainBudget): Promise<void> {
    if (this.verified) return;
    const raw = await this.rpc.call<string>("eth_chainId", [], budget);
    const actual = hexToNumber(raw, "chainId");
    if (actual !== this.chain.chainId) {
      throw new VeyraError("bad_request", SOURCE, `RPC chain ID mismatch: configured ${this.chain.chainId} (${this.chain.name}) but the RPC serves chain ${actual}. Check ROBINHOOD_RPC_URL / ROBINHOOD_CHAIN_ID.`);
    }
    this.verified = true;
  }

  async latestBlockNumber(budget: ChainBudget): Promise<number> {
    return hexToNumber(await this.rpc.call<string>("eth_blockNumber", [], budget, this.opts.liveTtlMs), "blockNumber");
  }

  async block(id: number | "latest" | string, budget: ChainBudget, opts: { full?: boolean } = {}): Promise<BlockInfo | null> {
    const full = Boolean(opts.full);
    const byHash = typeof id === "string" && id !== "latest";
    const raw = byHash
      ? await this.rpc.call<RawBlock | null>("eth_getBlockByHash", [id, full], budget, this.opts.stableTtlMs)
      : await this.rpc.call<RawBlock | null>("eth_getBlockByNumber", [id === "latest" ? "latest" : toHex(id), full], budget, id === "latest" ? this.opts.liveTtlMs : this.opts.stableTtlMs);
    if (raw === null || raw === undefined) return null;
    return normalizeBlock(raw);
  }

  async transaction(hash: string, budget: ChainBudget): Promise<TxInfo | null> {
    const raw = await this.rpc.call<RawTx | null>("eth_getTransactionByHash", [hash], budget, this.opts.liveTtlMs);
    return raw ? normalizeTx(raw) : null;
  }

  async receipt(hash: string, budget: ChainBudget): Promise<ReceiptInfo | null> {
    // Receipts of mined transactions never change: cache them as stable data.
    const raw = await this.rpc.call<RawReceipt | null>("eth_getTransactionReceipt", [hash], budget, this.opts.stableTtlMs);
    if (!raw) return null;
    if (!Array.isArray(raw.logs)) throw new VeyraError("invalid_output", SOURCE, "Malformed RPC response: receipt logs");
    return {
      status: raw.status === "0x1" ? "success" : "failed",
      gasUsed: hexToBigInt(raw.gasUsed, "gasUsed"),
      ...(raw.effectiveGasPrice ? { effectiveGasPrice: hexToBigInt(raw.effectiveGasPrice, "effectiveGasPrice") } : {}),
      ...(raw.contractAddress ? { contractAddress: toChecksumAddress(raw.contractAddress) } : {}),
      logs: raw.logs.map(normalizeLog),
    };
  }

  async balance(address: string, budget: ChainBudget): Promise<bigint> {
    return hexToBigInt(await this.rpc.call<string>("eth_getBalance", [address, "latest"], budget, this.opts.liveTtlMs), "balance");
  }

  async transactionCount(address: string, budget: ChainBudget): Promise<number> {
    return hexToNumber(await this.rpc.call<string>("eth_getTransactionCount", [address, "latest"], budget, this.opts.liveTtlMs), "nonce");
  }

  async code(address: string, budget: ChainBudget): Promise<string> {
    const code = await this.rpc.call<string>("eth_getCode", [address, "latest"], budget, this.opts.stableTtlMs);
    if (typeof code !== "string" || !/^0x[0-9a-fA-F]*$/.test(code)) throw new VeyraError("invalid_output", SOURCE, "Malformed RPC response: code");
    return code;
  }

  async call(to: string, data: string, budget: ChainBudget, opts: { stable?: boolean } = {}): Promise<string> {
    const out = await this.rpc.call<string>("eth_call", [{ to, data }, "latest"], budget, opts.stable ? this.opts.stableTtlMs : this.opts.liveTtlMs);
    if (typeof out !== "string") throw new VeyraError("invalid_output", SOURCE, "Malformed RPC response: eth_call");
    return out;
  }

  async logs(filter: { fromBlock: number; toBlock: number; topics?: (string | null)[]; address?: string }, budget: ChainBudget): Promise<LogInfo[]> {
    const raw = await this.rpc.call<RawLog[]>(
      "eth_getLogs",
      [{ fromBlock: toHex(filter.fromBlock), toBlock: toHex(filter.toBlock), ...(filter.topics ? { topics: filter.topics } : {}), ...(filter.address ? { address: filter.address } : {}) }],
      budget,
      this.opts.stableTtlMs,
    );
    if (!Array.isArray(raw)) throw new VeyraError("invalid_output", SOURCE, "Malformed RPC response: logs");
    return raw.map(normalizeLog);
  }
}

function normalizeBlock(b: RawBlock): BlockInfo {
  if (!b || typeof b !== "object" || !Array.isArray(b.transactions)) throw new VeyraError("invalid_output", SOURCE, "Malformed RPC response: block");
  const txs = b.transactions.filter((t): t is RawTx => typeof t === "object");
  return {
    number: hexToNumber(b.number, "block.number"),
    hash: b.hash,
    timestamp: new Date(hexToNumber(b.timestamp, "block.timestamp") * 1000).toISOString(),
    txCount: b.transactions.length,
    gasUsed: hexToBigInt(b.gasUsed, "gasUsed"),
    gasLimit: hexToBigInt(b.gasLimit, "gasLimit"),
    ...(b.baseFeePerGas ? { baseFeePerGas: hexToBigInt(b.baseFeePerGas, "baseFee") } : {}),
    ...(txs.length ? { transactions: txs.map(normalizeTx) } : {}),
  };
}

function normalizeTx(t: RawTx): TxInfo {
  if (!t || typeof t !== "object" || typeof t.hash !== "string" || typeof t.from !== "string") throw new VeyraError("invalid_output", SOURCE, "Malformed RPC response: transaction");
  return {
    hash: t.hash,
    blockNumber: t.blockNumber ? hexToNumber(t.blockNumber, "tx.blockNumber") : null,
    from: toChecksumAddress(t.from),
    to: t.to ? toChecksumAddress(t.to) : null,
    value: hexToBigInt(t.value, "tx.value"),
    nonce: hexToNumber(t.nonce, "tx.nonce"),
    gas: hexToBigInt(t.gas, "tx.gas"),
    ...(t.gasPrice ? { gasPrice: hexToBigInt(t.gasPrice, "gasPrice") } : {}),
    ...(t.maxFeePerGas ? { maxFeePerGas: hexToBigInt(t.maxFeePerGas, "maxFeePerGas") } : {}),
    input: typeof t.input === "string" ? t.input : "0x",
    type: t.type ? hexToNumber(t.type, "tx.type") : 0,
  };
}

function normalizeLog(l: RawLog): LogInfo {
  if (!l || typeof l.address !== "string" || !Array.isArray(l.topics)) throw new VeyraError("invalid_output", SOURCE, "Malformed RPC response: log");
  return {
    address: toChecksumAddress(l.address),
    topics: l.topics,
    data: l.data,
    logIndex: hexToNumber(l.logIndex, "logIndex"),
    blockNumber: hexToNumber(l.blockNumber, "log.blockNumber"),
    txHash: l.transactionHash,
  };
}
