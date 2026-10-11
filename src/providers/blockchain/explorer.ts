import { cacheKey, TtlCache } from "../../cache/ttl-cache.js";
import { VeyraError } from "../../core/errors.js";
import { httpRequest } from "../../core/http.js";
import type { ChainBudget } from "./types.js";

/**
 * Blockscout v2 API client (the official Robinhood Chain explorer runs
 * Blockscout). Supplies what plain RPC can't: address history, token holdings,
 * explorer labels, decoded calls, holder counts, daily statistics.
 * Field names verified against robinhoodchain.blockscout.com on 2026-10-06.
 */

export interface BsAddressRef {
  hash: string;
  name?: string | null;
  is_contract?: boolean;
  is_verified?: boolean;
  public_tags?: { display_name?: string; label?: string }[];
}
export interface BsToken {
  address_hash: string;
  name: string | null;
  symbol: string | null;
  decimals: string | null;
  total_supply: string | null;
  holders_count: string | null;
  type: string;
}
export interface BsTransaction {
  hash: string;
  block_number: number | null;
  timestamp: string | null;
  from: BsAddressRef;
  to: BsAddressRef | null;
  value: string;
  status: string | null;
  method: string | null;
  fee?: { value?: string } | null;
  decoded_input?: { method_call?: string; parameters?: { name: string; type: string; value: unknown }[] } | null;
  transaction_types?: string[];
}
export interface BsTokenTransfer {
  transaction_hash: string;
  block_number?: number;
  timestamp: string | null;
  from: BsAddressRef;
  to: BsAddressRef;
  token: BsToken;
  total: { value?: string | null; decimals?: string | null } | null;
  type: string;
}
export interface BsAddress {
  hash: string;
  name: string | null;
  is_contract: boolean;
  is_verified: boolean | null;
  is_scam?: boolean;
  proxy_type?: string | null;
  implementations?: { address_hash?: string; address?: string; name?: string | null }[];
  creator_address_hash?: string | null;
  creation_transaction_hash?: string | null;
  coin_balance?: string | null;
  public_tags?: { display_name?: string; label?: string }[];
  token?: BsToken | null;
}
export interface BsStats {
  total_blocks?: string;
  total_transactions?: string;
  total_addresses?: string;
  transactions_today?: string;
  gas_used_today?: string;
  average_block_time?: number;
}

export class BlockscoutExplorer {
  constructor(
    private readonly baseUrl: string,
    private readonly opts: { timeoutMs: number; liveTtlMs: number; stableTtlMs: number; apiKey?: string },
    private readonly cache = new TtlCache<unknown>(1000),
  ) {}

  /** null when the explorer has no record (404). */
  async get<T>(path: string, budget: ChainBudget, stable = false): Promise<T | null> {
    const url = `${this.baseUrl}${path}${this.opts.apiKey ? `${path.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(this.opts.apiKey)}` : ""}`;
    const key = cacheKey("blockscout", path);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit as T | null;
    if (budget.explorerCalls >= budget.maxExplorerCalls) {
      throw new VeyraError("budget", "explorer", `Explorer request limit for this question (${budget.maxExplorerCalls}) reached`);
    }
    budget.explorerCalls++;
    let res: Response;
    try {
      res = await httpRequest(url, {
        source: "explorer",
        headers: { Accept: "application/json" },
        timeoutMs: this.opts.timeoutMs,
        signal: budget.signal,
        acceptStatus: [404],
        mapError: (status, body) =>
          status === 429
            ? new VeyraError("rate_limit", "explorer", "The explorer API is rate-limiting requests (429)", { status })
            : status === 402 || (status === 401 && /api key/i.test(body))
              ? new VeyraError("quota", "explorer", "The explorer API needs an API key or more credits (set ROBINHOOD_EXPLORER_API_KEY)", { status })
              : status === 403 && /just a moment|cloudflare|challenge/i.test(body)
                ? new VeyraError("auth", "explorer", "The explorer website blocks automated API access (bot protection) — use the Blockscout PRO API with ROBINHOOD_EXPLORER_API_KEY", { status })
                : new VeyraError(status >= 500 ? "upstream" : status === 401 || status === 403 ? "auth" : "bad_request", "explorer", `The explorer API returned ${status}`, { status }),
      });
    } catch (err) {
      throw err instanceof VeyraError ? err : new VeyraError("network", "explorer", "Explorer API unreachable");
    }
    if (res.status === 404) {
      this.cache.set(key, null, this.opts.liveTtlMs);
      return null;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new VeyraError("invalid_output", "explorer", "Malformed explorer API response");
    }
    this.cache.set(key, body, stable ? this.opts.stableTtlMs : this.opts.liveTtlMs);
    return body as T;
  }

  stats = (b: ChainBudget) => this.get<BsStats>("/stats", b);
  txChart = (b: ChainBudget) => this.get<{ chart_data?: { date: string; transactions_count: number }[] }>("/stats/charts/transactions", b);
  transaction = (hash: string, b: ChainBudget) => this.get<BsTransaction>(`/transactions/${hash}`, b);
  txTokenTransfers = (hash: string, b: ChainBudget) => this.get<{ items?: BsTokenTransfer[] }>(`/transactions/${hash}/token-transfers`, b);
  address = (a: string, b: ChainBudget) => this.get<BsAddress>(`/addresses/${a}`, b);
  addressCounters = (a: string, b: ChainBudget) =>
    this.get<{ transactions_count?: string; token_transfers_count?: string; gas_usage_count?: string }>(`/addresses/${a}/counters`, b);
  addressTransactions = (a: string, b: ChainBudget) => this.get<{ items?: BsTransaction[] }>(`/addresses/${a}/transactions`, b);
  addressTokenTransfers = (a: string, b: ChainBudget) => this.get<{ items?: BsTokenTransfer[] }>(`/addresses/${a}/token-transfers`, b);
  addressTokens = (a: string, b: ChainBudget) => this.get<{ items?: { token: BsToken; value: string | null }[] }>(`/addresses/${a}/tokens?type=ERC-20`, b);
  token = (a: string, b: ChainBudget) => this.get<BsToken>(`/tokens/${a}`, b, true);
  tokenTransfers = (a: string, b: ChainBudget) => this.get<{ items?: BsTokenTransfer[] }>(`/tokens/${a}/transfers`, b);
  topTokens = (b: ChainBudget) => this.get<{ items?: BsToken[] }>("/tokens?type=ERC-20", b);
  recentTransactions = (b: ChainBudget) => this.get<{ items?: BsTransaction[] }>("/transactions?filter=validated", b);
  recentTokenTransfers = (b: ChainBudget) => this.get<{ items?: BsTokenTransfer[] }>("/token-transfers", b);
}

/** Explorer labels are third-party annotations, never verified identity. */
export function explorerLabel(ref: BsAddressRef | BsAddress | null | undefined): string | undefined {
  if (!ref) return undefined;
  const tags = (ref.public_tags ?? []).map((t) => t.display_name ?? t.label).filter(Boolean);
  const parts = [ref.name ?? undefined, ...tags].filter((x): x is string => Boolean(x)).map((s) => s.replace(/[\u0000-\u001f]/g, "").slice(0, 60));
  return parts.length ? [...new Set(parts)].join(", ") : undefined;
}
