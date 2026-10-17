import { decodeUint, ERC20, encodeAddressArg, toChecksumAddress } from "../providers/blockchain/evm.js";
import { keccak256 } from "../providers/blockchain/keccak.js";
import type { BlockchainProvider, ChainBudget, LogInfo } from "../providers/blockchain/types.js";

/**
 * Launch safety reads straight from the chain (eth_call / eth_getLogs):
 * whether the pool's liquidity is locked, and who bought in the first minute.
 */

const sel = (sig: string) => `0x${keccak256(sig).replace(/^0x/, "").slice(0, 8)}`;
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const TRANSFER = `0x${keccak256("Transfer(address,address,uint256)").replace(/^0x/, "")}`;
const ZERO = "0x0000000000000000000000000000000000000000";
const BURN = new Set([ZERO, "0x000000000000000000000000000000000000dead", "0xdead000000000000000000000000000000000000"]);

/**
 * Lockers whose verified source we have read. Each must hold liquidity
 * positions with no withdraw path; `isLocked(token)` and
 * `lockedPositions(token)` must be on-chain views.
 */
export const KNOWN_LOCKERS = [
  {
    address: "0x267444d099b10fb5ed7c3cc7b7c767adca574952",
    name: "PonsV2LaunchLocker",
    /** Uniswap v4 PositionManager the locker holds position NFTs of. */
    positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    note: "Verified contract with no withdraw or arbitrary-call function: the position can never be removed.",
  },
];

export interface LiquidityLock {
  locked: boolean;
  locker: string;
  lockerName: string;
  positionId: string;
  /** The position NFT is still owned by the locker. */
  held: boolean;
  /** The position still has liquidity in it. */
  hasLiquidity: boolean;
  /** The position is in the token's main (deepest) pool. */
  mainPool?: boolean;
  permanent: boolean;
  note: string;
}

export interface SniperInfo {
  address: string;
  boughtPct: number;
  holdsPct?: number;
  sold: boolean;
  dev?: boolean;
}
export interface Snipers {
  windowSec: number;
  buyers: number;
  boughtPct: number;
  /** What the first-minute buyers checked still hold, as % of supply. */
  stillHoldPct?: number;
  checked: number;
  soldAll: number;
  top: SniperInfo[];
}

const pct = (v: bigint, supply: bigint) => (supply > 0n ? Math.round(Number((v * 10_000n) / supply)) / 100 : 0);

export async function readLiquidityLock(provider: BlockchainProvider, token: string, mainPoolId: string | undefined, budget: ChainBudget): Promise<LiquidityLock | undefined> {
  const t = token.toLowerCase();
  for (const lk of KNOWN_LOCKERS) {
    const locked = decodeUint(await provider.call(lk.address, encodeAddressArg(sel("isLocked(address)"), t), budget));
    if (locked !== 1n) continue;
    const id = decodeUint(await provider.call(lk.address, encodeAddressArg(sel("lockedPositions(address)"), t), budget)) ?? 0n;
    const [owner, liq, info] = await Promise.all([
      provider.call(lk.positionManager, `${sel("ownerOf(uint256)")}${word(id)}`, budget).catch(() => "0x"),
      provider.call(lk.positionManager, `${sel("getPositionLiquidity(uint256)")}${word(id)}`, budget).catch(() => "0x"),
      provider.call(lk.positionManager, `${sel("getPoolAndPositionInfo(uint256)")}${word(id)}`, budget).catch(() => "0x"),
    ]);
    const held = owner.length >= 66 && `0x${owner.slice(-40)}`.toLowerCase() === lk.address;
    const hasLiquidity = (decodeUint(liq) ?? 0n) > 0n;
    // A v4 pool id is keccak256 of the ABI-encoded PoolKey (the first five words returned).
    const poolId = info.length >= 2 + 64 * 5 ? `0x${keccak256(hexBytes(info.slice(2, 2 + 64 * 5))).replace(/^0x/, "")}` : undefined;
    return {
      locked: true,
      locker: toChecksumAddress(lk.address),
      lockerName: lk.name,
      positionId: id.toString(),
      held,
      hasLiquidity,
      ...(poolId && mainPoolId ? { mainPool: poolId.toLowerCase() === mainPoolId.toLowerCase() } : {}),
      permanent: held,
      note: lk.note,
    };
  }
  return undefined;
}

function hexBytes(h: string): Uint8Array {
  return new Uint8Array(h.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
}

/**
 * Wallets that bought within `windowSec` of launch. A "buy" is a transaction
 * in which tokens leave a source (the launch curve, a pool) and end up, net,
 * with a wallet; routers that pass tokens straight through net to zero and are
 * skipped. Current balances come from balanceOf.
 */
export async function readSnipers(
  provider: BlockchainProvider,
  input: { token: string; launchBlock: number; supply: bigint; pools: Set<string>; dev?: string; windowSec?: number },
  budget: ChainBudget,
): Promise<Snipers> {
  const windowSec = input.windowSec ?? 60;
  const t = input.token.toLowerCase();
  // Block times vary; measure them over the first 600 blocks to turn seconds into blocks.
  const [b0, b1] = await Promise.all([provider.block(input.launchBlock, budget), provider.block(input.launchBlock + 600, budget).catch(() => null)]);
  let span = 600;
  if (b0 && b1) {
    const secs = (Date.parse(b1.timestamp) - Date.parse(b0.timestamp)) / 1000;
    if (secs > 0) span = Math.round((600 * windowSec) / secs);
  }
  span = Math.min(Math.max(span, 5), 5000);
  const logs = await provider.logs({ address: t, topics: [TRANSFER], fromBlock: input.launchBlock, toBlock: input.launchBlock + span }, budget);

  const addr = (topic: string | undefined) => (topic ? `0x${topic.slice(-40)}`.toLowerCase() : ZERO);
  const sources = new Set([...input.pools].map((p) => p.toLowerCase()));
  for (const l of logs) if (addr(l.topics[1]) === ZERO) sources.add(addr(l.topics[2])); // where the supply was minted (the launch curve)

  const byTx = new Map<string, LogInfo[]>();
  for (const l of logs) byTx.set(l.txHash, [...(byTx.get(l.txHash) ?? []), l]);
  const bought = new Map<string, bigint>();
  for (const group of byTx.values()) {
    if (!group.some((l) => sources.has(addr(l.topics[1])) && addr(l.topics[1]) !== ZERO)) continue;
    const net = new Map<string, bigint>();
    for (const l of group) {
      const v = decodeUint(l.data.length >= 66 ? l.data : `0x${l.data.slice(2).padStart(64, "0")}`) ?? 0n;
      const from = addr(l.topics[1]), to = addr(l.topics[2]);
      net.set(from, (net.get(from) ?? 0n) - v);
      net.set(to, (net.get(to) ?? 0n) + v);
    }
    for (const [a, v] of net) if (v > 0n && !sources.has(a) && !BURN.has(a)) bought.set(a, (bought.get(a) ?? 0n) + v);
  }

  const ranked = [...bought.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  const check = ranked.slice(0, 15);
  // A few at a time: public RPCs throttle bursts.
  const balances: (bigint | undefined)[] = [];
  for (let i = 0; i < check.length; i += 4)
    balances.push(
      ...(await Promise.all(
        check.slice(i, i + 4).map(([a]) =>
          provider
            .call(t, encodeAddressArg(ERC20.balanceOf, a), budget)
            .then((r) => decodeUint(r))
            .catch(() => provider.call(t, encodeAddressArg(ERC20.balanceOf, a), budget).then((r) => decodeUint(r)).catch(() => undefined)),
        ),
      )),
    );
  const total = ranked.reduce((s, [, v]) => s + v, 0n);
  const known = balances.filter((b): b is bigint => b !== undefined);
  const top: SniperInfo[] = check.map(([a, v], i) => {
    const bal = balances[i];
    return {
      address: toChecksumAddress(a),
      boughtPct: pct(v, input.supply),
      ...(bal !== undefined ? { holdsPct: pct(bal, input.supply) } : {}),
      sold: bal === 0n,
      ...(input.dev && a === input.dev.toLowerCase() ? { dev: true } : {}),
    };
  });
  return {
    windowSec,
    buyers: ranked.length,
    boughtPct: pct(total, input.supply),
    ...(known.length ? { stillHoldPct: pct(known.reduce((s, b) => s + b, 0n), input.supply) } : {}),
    checked: known.length,
    soldAll: balances.filter((b) => b === 0n).length,
    top: top.slice(0, 10),
  };
}
