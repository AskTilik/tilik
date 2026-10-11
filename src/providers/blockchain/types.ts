import type { ChainConfig } from "../../config/chains.js";

/** Per-question bookkeeping: request caps and cancellation. */
export interface ChainBudget {
  signal: AbortSignal;
  rpcCalls: number;
  maxRpcCalls: number;
  explorerCalls: number;
  maxExplorerCalls: number;
}

export interface BlockInfo {
  number: number;
  hash: string;
  timestamp: string;
  txCount: number;
  gasUsed: bigint;
  gasLimit: bigint;
  baseFeePerGas?: bigint;
  /** Present when requested with full transactions. */
  transactions?: TxInfo[];
}

export interface TxInfo {
  hash: string;
  /** null while pending. */
  blockNumber: number | null;
  from: string;
  /** null for contract creation. */
  to: string | null;
  value: bigint;
  nonce: number;
  gas: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  input: string;
  type: number;
}

export interface LogInfo {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
  blockNumber: number;
  txHash: string;
}

export interface ReceiptInfo {
  status: "success" | "failed";
  gasUsed: bigint;
  effectiveGasPrice?: bigint;
  contractAddress?: string;
  logs: LogInfo[];
}

/**
 * Chain-agnostic EVM data access. The Robinhood Chain tool uses one; another
 * EVM chain only needs a different ChainConfig.
 */
export interface BlockchainProvider {
  readonly chain: ChainConfig;
  /** Verifies the RPC really serves the configured chain (cached once confirmed). */
  ensureChain(budget: ChainBudget): Promise<void>;
  latestBlockNumber(budget: ChainBudget): Promise<number>;
  block(id: number | "latest" | string, budget: ChainBudget, opts?: { full?: boolean }): Promise<BlockInfo | null>;
  transaction(hash: string, budget: ChainBudget): Promise<TxInfo | null>;
  receipt(hash: string, budget: ChainBudget): Promise<ReceiptInfo | null>;
  balance(address: string, budget: ChainBudget): Promise<bigint>;
  /** Transactions sent by the address (its nonce). */
  transactionCount(address: string, budget: ChainBudget): Promise<number>;
  code(address: string, budget: ChainBudget): Promise<string>;
  call(to: string, data: string, budget: ChainBudget, opts?: { stable?: boolean }): Promise<string>;
  logs(filter: { fromBlock: number; toBlock: number; topics?: (string | null)[]; address?: string }, budget: ChainBudget): Promise<LogInfo[]>;
}
