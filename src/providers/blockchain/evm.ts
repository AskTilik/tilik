import { VeyraError } from "../../core/errors.js";
import { keccak256 } from "./keccak.js";

// ── Validation ───────────────────────────────────────────────────────────────

export type AddressCheck = { ok: true; address: string; checksum: "valid" | "unchecked" } | { ok: false; reason: string };

/** EIP-55: all-lowercase/uppercase addresses are accepted unchecked; mixed case must match the checksum. */
export function validateAddress(input: string): AddressCheck {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input)) {
    const len = input.replace(/^0x/i, "").length;
    return { ok: false, reason: `"${input.slice(0, 16)}${input.length > 16 ? "…" : ""}" is not a valid address (expected 0x + 40 hex characters, got ${len})` };
  }
  const body = input.slice(2);
  const checksummed = toChecksumAddress(input);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return { ok: true, address: checksummed, checksum: "unchecked" };
  if (checksummed !== input) return { ok: false, reason: `${input} has an invalid EIP-55 checksum (possible typo)` };
  return { ok: true, address: checksummed, checksum: "valid" };
}

export function toChecksumAddress(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const hash = keccak256(lower);
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  return out;
}

export function isTxHash(s: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(s);
}

/** Hex strings that look like an attempted address/hash but have the wrong length. */
export function malformedHexTokens(text: string): string[] {
  return [...text.matchAll(/(?<![0-9a-zA-Z])0x[0-9a-fA-F]{8,}(?![0-9a-zA-Z])/g)]
    .map((m) => m[0])
    .filter((h) => h.length !== 42 && h.length !== 66);
}

// ── Hex / units ──────────────────────────────────────────────────────────────

const SOURCE = "rpc";

export function hexToBigInt(v: unknown, field = "value"): bigint {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v)) throw new VeyraError("invalid_output", SOURCE, `Malformed RPC response: ${field} is not hex`);
  return v === "0x" ? 0n : BigInt(v);
}

export function hexToNumber(v: unknown, field = "value"): number {
  const n = hexToBigInt(v, field);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new VeyraError("invalid_output", SOURCE, `Malformed RPC response: ${field} out of range`);
  return Number(n);
}

export function toHex(n: number | bigint): string {
  return `0x${n.toString(16)}`;
}

/** 1234500000000000000n, 18 → "1.2345" (no float rounding; trailing zeros trimmed). */
export function formatUnits(value: bigint, decimals: number, maxFraction = 6): string {
  const sign = value < 0n ? "-" : "";
  const v = value < 0n ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  // Non-zero but below display precision: say so instead of printing "0".
  if (whole === 0n && !frac && v > 0n) return `${sign}<0.${"0".repeat(Math.max(0, maxFraction - 1))}1`;
  return `${sign}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// ── ABI (just what's needed: ERC-20 metadata/balances, string decoding) ─────

export const ERC20 = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
  balanceOf: "0x70a08231",
} as const;

export function encodeAddressArg(selector: string, address: string): string {
  return `${selector}${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

export function decodeUint(hex: string): bigint | undefined {
  if (!/^0x[0-9a-fA-F]+$/.test(hex) || hex.length < 66) return undefined;
  return BigInt(`0x${hex.slice(2, 66)}`);
}

/** ABI-encoded `string`, or a `bytes32` string (some old tokens). Control characters stripped, length capped. */
export function decodeString(hex: string): string | undefined {
  if (!/^0x[0-9a-fA-F]*$/.test(hex) || hex.length < 66) return undefined;
  const body = hex.slice(2);
  const bytes = (h: string) => new Uint8Array(h.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
  let raw: Uint8Array;
  if (body.length >= 128 && BigInt(`0x${body.slice(0, 64)}`) === 32n) {
    const len = Number(BigInt(`0x${body.slice(64, 128)}`));
    if (len > 1000 || body.length < 128 + len * 2) return undefined;
    raw = bytes(body.slice(128, 128 + len * 2));
  } else {
    raw = bytes(body.slice(0, 64)).filter((b) => b !== 0);
  }
  const s = new TextDecoder("utf-8", { fatal: false }).decode(raw).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return s ? s.slice(0, 100) : undefined;
}

export function topicToAddress(topic: string | undefined): string | undefined {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return undefined;
  return toChecksumAddress(`0x${topic.slice(26)}`);
}

// ── Known signatures (hashed at startup — no hand-typed hashes) ──────────────

const EVENT_SIGNATURES = [
  "Transfer(address,address,uint256)",
  "Approval(address,address,uint256)",
  "ApprovalForAll(address,address,bool)",
  "TransferSingle(address,address,address,uint256,uint256)",
  "TransferBatch(address,address,address,uint256[],uint256[])",
  "Swap(address,uint256,uint256,uint256,uint256,address)",
  "Swap(address,address,int256,int256,uint160,uint128,int24)",
  "Sync(uint112,uint112)",
  "Mint(address,uint256,uint256)",
  "Burn(address,uint256,uint256,address)",
  "Deposit(address,uint256)",
  "Withdrawal(address,uint256)",
  "OwnershipTransferred(address,address)",
  "Upgraded(address)",
  "Initialized(uint8)",
  "Paused(address)",
  "Unpaused(address)",
];
const FUNCTION_SIGNATURES = [
  "transfer(address,uint256)",
  "transferFrom(address,address,uint256)",
  "approve(address,uint256)",
  "setApprovalForAll(address,bool)",
  "safeTransferFrom(address,address,uint256)",
  "safeTransferFrom(address,address,uint256,bytes)",
  "deposit()",
  "withdraw(uint256)",
  "mint(address,uint256)",
  "burn(uint256)",
  "multicall(bytes[])",
  "multicall(uint256,bytes[])",
  "execute(bytes,bytes[],uint256)",
  "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
  "swapExactETHForTokens(uint256,address[],address,uint256)",
  "swapExactTokensForETH(uint256,uint256,address[],address,uint256)",
  "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
  "exactInput((bytes,address,uint256,uint256))",
];

export const TRANSFER_TOPIC = `0x${keccak256(EVENT_SIGNATURES[0]!)}`;
export const KNOWN_EVENTS: Record<string, string> = Object.fromEntries(EVENT_SIGNATURES.map((s) => [`0x${keccak256(s)}`, s]));
export const KNOWN_FUNCTIONS: Record<string, string> = Object.fromEntries(FUNCTION_SIGNATURES.map((s) => [`0x${keccak256(s).slice(0, 8)}`, s]));
