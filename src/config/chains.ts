import type { Env } from "./env.js";

/**
 * EVM network configuration. Robinhood Chain values are the official ones from
 * https://docs.robinhood.com/chain/connecting (verified 2026-10-06; the public
 * RPCs answered eth_chainId 0x1237 / 0xb626). Everything is overridable by env.
 */
export interface ChainConfig {
  key: string;
  name: string;
  chainId: number;
  /** Primary first. Never logged or returned — provider URLs often embed API keys. */
  rpcUrls: string[];
  /** Explorer UI for links (/tx/, /address/, /block/, /token/ — same routes on Blockscout and Etherscan). */
  explorerUrl?: string;
  /** Blockscout v2 API base, if available. */
  explorerApiUrl?: string;
  explorerApiKey?: string;
  nativeSymbol: string;
  nativeDecimals: number;
  /** True when using the official public RPC (rate-limited, not for production). */
  publicRpc: boolean;
}

const ROBINHOOD = {
  mainnet: {
    name: "Robinhood Chain",
    chainId: 4663,
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
  },
  testnet: {
    name: "Robinhood Chain Testnet",
    chainId: 46630,
    rpc: "https://rpc.testnet.chain.robinhood.com",
    explorer: "https://explorer.testnet.chain.robinhood.com",
  },
} as const;

export function robinhoodChain(env: Env): ChainConfig {
  const d = ROBINHOOD[env.ROBINHOOD_NETWORK];
  const primary = env.ROBINHOOD_RPC_URL ?? d.rpc;
  const fallbacks = (env.ROBINHOOD_RPC_FALLBACK_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const chainId = env.ROBINHOOD_CHAIN_ID ?? d.chainId;
  const explorer = env.ROBINHOOD_EXPLORER_URL === "none" ? undefined : (env.ROBINHOOD_EXPLORER_URL ?? d.explorer).replace(/\/+$/, "");
  // The explorer website's own API sits behind bot protection (Cloudflare challenge) for server clients,
  // so the default explorer API is Blockscout's official PRO API — used only when a key is configured.
  const api =
    env.ROBINHOOD_EXPLORER_API_URL === "none"
      ? undefined
      : (env.ROBINHOOD_EXPLORER_API_URL ?? (env.ROBINHOOD_EXPLORER_API_KEY ? `https://api.blockscout.com/${chainId}/api/v2` : undefined))?.replace(/\/+$/, "");
  return {
    key: "robinhood",
    name: d.name,
    chainId,
    rpcUrls: [...new Set([primary, ...fallbacks])],
    ...(explorer ? { explorerUrl: explorer } : {}),
    ...(api ? { explorerApiUrl: api } : {}),
    ...(env.ROBINHOOD_EXPLORER_API_KEY ? { explorerApiKey: env.ROBINHOOD_EXPLORER_API_KEY } : {}),
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    publicRpc: primary === d.rpc,
  };
}

/** Explorer page links built only from the configured explorer base — never guessed. */
export function explorerLinks(chain: ChainConfig) {
  const base = chain.explorerUrl;
  return {
    tx: (hash: string) => (base ? `${base}/tx/${hash}` : undefined),
    address: (addr: string) => (base ? `${base}/address/${addr}` : undefined),
    block: (n: number | string) => (base ? `${base}/block/${n}` : undefined),
    token: (addr: string) => (base ? `${base}/token/${addr}` : undefined),
    home: () => base,
  };
}
