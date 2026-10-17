import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KNOWN_LOCKERS, readLiquidityLock, readSnipers } from "../src/api/launch-safety.js";
import { keccak256 } from "../src/providers/blockchain/keccak.js";
import type { BlockchainProvider, LogInfo } from "../src/providers/blockchain/types.js";

const TOKEN = `0x${"c3".repeat(20)}`;
const CURVE = `0x${"b4".repeat(20)}`;
const ROUTER = `0x${"b1".repeat(20)}`;
const A = `0x${"a1".repeat(20)}`, B = `0x${"a2".repeat(20)}`, C = `0x${"a3".repeat(20)}`;
const ZERO = `0x${"0".repeat(40)}`;
const LOCKER = KNOWN_LOCKERS[0]!;
const sel = (s: string) => `0x${keccak256(s).replace(/^0x/, "").slice(0, 8)}`;
const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const topic = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const TRANSFER = `0x${keccak256("Transfer(address,address,uint256)").replace(/^0x/, "")}`;
const budget = () => ({ signal: AbortSignal.timeout(5000), rpcCalls: 0, maxRpcCalls: 50, explorerCalls: 0, maxExplorerCalls: 0 });
const SUPPLY = 1000n;

function fake(over: Partial<BlockchainProvider>): BlockchainProvider {
  return {
    chain: {} as any,
    ensureChain: async () => {},
    latestBlockNumber: async () => 0,
    block: async () => null,
    transaction: async () => null,
    receipt: async () => null,
    balance: async () => 0n,
    transactionCount: async () => 0,
    code: async () => "0x",
    call: async () => "0x",
    logs: async () => [],
    ...over,
  };
}

describe("liquidity lock", () => {
  const key = `${w(1)}${w(2)}${w(3000)}${w(60)}${w(4)}`;
  const poolId = `0x${keccak256(Buffer.from(key, "hex")).replace(/^0x/, "")}`;
  const lockerChain = (owner: string, liquidity: number) =>
    fake({
      call: async (to, data) => {
        const s = data.slice(0, 10);
        if (to === LOCKER.address && s === sel("isLocked(address)")) return `0x${w(data.endsWith(TOKEN.slice(2)) ? 1 : 0)}`;
        if (to === LOCKER.address && s === sel("lockedPositions(address)")) return `0x${w(3820500)}`;
        if (to === LOCKER.positionManager && s === sel("ownerOf(uint256)")) return topic(owner);
        if (to === LOCKER.positionManager && s === sel("getPositionLiquidity(uint256)")) return `0x${w(liquidity)}`;
        if (to === LOCKER.positionManager && s === sel("getPoolAndPositionInfo(uint256)")) return `0x${key}${w(99)}`;
        return "0x";
      },
    });

  it("confirms a position held by the locker, with liquidity, in the main pool", async () => {
    const r = await readLiquidityLock(lockerChain(LOCKER.address, 5), TOKEN, poolId, budget());
    assert.equal(r?.locked, true);
    assert.equal(r?.positionId, "3820500");
    assert.equal(r?.held, true);
    assert.equal(r?.hasLiquidity, true);
    assert.equal(r?.mainPool, true);
    assert.equal(r?.permanent, true);
  });

  it("reports a moved or empty position instead of calling it locked", async () => {
    const r = await readLiquidityLock(lockerChain(A, 0), TOKEN, `0x${"d4".repeat(32)}`, budget());
    assert.equal(r?.held, false);
    assert.equal(r?.hasLiquidity, false);
    assert.equal(r?.mainPool, false);
  });

  it("says nothing for tokens no known locker holds", async () => {
    assert.equal(await readLiquidityLock(lockerChain(LOCKER.address, 5), `0x${"99".repeat(20)}`, poolId, budget()), undefined);
  });
});

describe("first-minute buyers", () => {
  let n = 0;
  const log = (block: number, tx: string, from: string, to: string, v: bigint): LogInfo => ({ address: TOKEN, topics: [TRANSFER, topic(from), topic(to)], data: `0x${w(v)}`, logIndex: n++, blockNumber: block, txHash: tx });
  const chain = (balances: Record<string, bigint>) =>
    fake({
      block: async (id) => ({ number: Number(id), hash: "0x", timestamp: new Date(1_000_000 + (Number(id) - 100) * 100).toISOString(), txCount: 0, gasUsed: 0n, gasLimit: 0n }),
      logs: async (f) => {
        assert.equal(f.fromBlock, 100);
        assert.equal(f.toBlock, 700); // 600 blocks took 60s, so the first minute is 600 blocks
        return [
          log(100, "0x01", ZERO, CURVE, 1000n), // mint to the launch curve
          log(110, "0x02", CURVE, A, 50n), // direct buy
          log(150, "0x03", CURVE, ROUTER, 30n), // buy through a router
          log(150, "0x03", ROUTER, B, 30n),
          log(160, "0x04", CURVE, C, 20n),
          log(170, "0x05", C, A, 5n), // wallet-to-wallet, not a buy
        ];
      },
      call: async (_to, data) => {
        const who = `0x${data.slice(-40)}`;
        return `0x${w(balances[who] ?? 0n)}`;
      },
    });

  it("counts the final buyer behind routers, and reads what they still hold", async () => {
    const s = await readSnipers(chain({ [A]: 40n, [B]: 0n, [C]: 15n }), { token: TOKEN, launchBlock: 100, supply: SUPPLY, pools: new Set(), dev: C }, budget());
    assert.equal(s.windowSec, 60);
    assert.equal(s.buyers, 3); // A, B, C — not the router, not the curve
    assert.equal(s.boughtPct, 10); // 50 + 30 + 20 of 1000
    assert.deepEqual(s.top.map((t) => [t.address.toLowerCase(), t.boughtPct, t.holdsPct, t.sold]), [
      [A, 5, 4, false],
      [B, 3, 0, true],
      [C, 2, 1.5, false],
    ]);
    assert.equal(s.top[2]!.dev, true);
    assert.equal(s.stillHoldPct, 5.5);
    assert.equal(s.soldAll, 1);
  });
});
