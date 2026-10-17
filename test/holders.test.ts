import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { createHolderTracker, holderRoutes } from "../src/api/holders.js";
import { keccak256 } from "../src/providers/blockchain/keccak.js";
import type { BlockchainProvider, LogInfo } from "../src/providers/blockchain/types.js";
import { MemoryKv } from "../src/providers/kv/upstash.js";
import { testEnv } from "./helpers.js";

const TOKEN = `0x${"c3".repeat(20)}`;
const ZERO = `0x${"0".repeat(40)}`;
const A = `0x${"a1".repeat(20)}`, B = `0x${"a2".repeat(20)}`, C = `0x${"a3".repeat(20)}`;
const TRANSFER = `0x${keccak256("Transfer(address,address,uint256)").replace(/^0x/, "")}`;
const topic = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const LAUNCH = 1000, LATEST = 1800, T0 = Date.parse("2026-10-14T00:00:00Z");
const env = testEnv({ ONCHAIN_ENABLED: "true" });
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as any;

let n = 0;
const log = (block: number, from: string, to: string, v: number): LogInfo => ({ address: TOKEN, topics: [TRANSFER, topic(from), topic(to)], data: `0x${v.toString(16).padStart(64, "0")}`, logIndex: n++, blockNumber: block, txHash: "0x" });
const LOGS = [
  log(1000, ZERO, A, 100), // mint
  log(1100, A, B, 40),
  log(1150, A, C, 10),
  log(1500, B, A, 40), // B leaves
  log(1700, C, ZERO, 10), // C burns out
];

function chain(maxPerCall = 1000) {
  const calls: [number, number][] = [];
  const provider = {
    latestBlockNumber: async () => LATEST,
    // one block per 100 s
    block: async (id: number | string) => ({ number: Number(id), hash: "0x", timestamp: new Date(T0 + (Number(id) - LAUNCH) * 100_000).toISOString(), txCount: 0, gasUsed: 0n, gasLimit: 0n }),
    logs: async (f: { fromBlock: number; toBlock: number }) => {
      calls.push([f.fromBlock, f.toBlock]);
      const out = LOGS.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock);
      return out.length > maxPerCall ? out.slice(0, 1000).concat(Array(1000).fill(out[0])) : out;
    },
  } as unknown as BlockchainProvider;
  const explorer = {
    address: async () => ({ creation_transaction_hash: "0xcreate" }),
    get: async () => ({ transfers_count: String(LOGS.length) }),
    transaction: async () => ({ block_number: LAUNCH }),
    token: async () => ({ holders_count: "7" }),
  } as any;
  return { provider, explorer, calls };
}

describe("holder growth", () => {
  it("rebuilds the holder count since launch from every transfer", async () => {
    const { provider, explorer } = chain();
    const kv = new MemoryKv(() => T0 + 900_000_000);
    const tr = createHolderTracker(env, quiet, { kv, provider, explorer, now: () => T0 + 900_000_000 });
    const h = await tr.history(TOKEN);
    assert.equal(h.rebuilt, true);
    const at = (block: number) => h.points.find((p) => p.t === new Date(T0 + (block - LAUNCH) * 100_000).toISOString())?.holders;
    assert.equal(h.points[0]!.holders, 0); // launch
    assert.equal(at(1100), 2); // A, B (sample at 1100)
    assert.equal(at(1200), 3); // A, B, C
    assert.equal(at(1500), 2); // B sold everything back to A
    assert.equal(at(1800), 1); // C burned out: only A left
    assert.ok(h.points.every((p) => p.source === "history"));
    // second call reads storage, does not rebuild
    const again = await tr.history(TOKEN);
    assert.equal(again.points.length, h.points.length);
  });

  it("records the explorer's count at most once an hour, and the daily cron refreshes every token seen", async () => {
    let now = T0;
    const kv = new MemoryKv(() => now);
    const { provider, explorer } = chain();
    const tr = createHolderTracker(env, quiet, { kv, provider, explorer, now: () => now });
    await tr.record(TOKEN, 5);
    now += 60_000;
    await tr.record(TOKEN, 6); // within the hour: skipped
    assert.deepEqual(await kv.cmd("ZRANGE", `hg:${TOKEN}`, 0, -1), [`${T0}:5:t`]);
    now += 3_600_000;
    assert.deepEqual(await tr.cron(), { tokens: 1, recorded: 1 });
    assert.equal(((await kv.cmd("ZRANGE", `hg:${TOKEN}`, 0, -1)) as string[]).at(-1), `${now}:7:t`);
  });

  it("serves history only with storage configured, and the cron route only to the cron secret", async () => {
    const off = new Hono().route("/", holderRoutes(env, { take: () => ({ ok: true }) } as any, createHolderTracker(env, quiet, { kv: null })));
    assert.equal((await off.request(`/api/token/${TOKEN}/holders-history`)).status, 503);
    const { provider, explorer } = chain();
    const secret = testEnv({ ONCHAIN_ENABLED: "true", CRON_SECRET: "s3cret-s3cret" });
    const on = new Hono().route("/", holderRoutes(secret, { take: () => ({ ok: true }) } as any, createHolderTracker(secret, quiet, { kv: new MemoryKv(), provider, explorer })));
    assert.equal((await on.request("/api/cron/holders")).status, 401);
    assert.equal((await on.request("/api/cron/holders", { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await on.request("/api/cron/holders", { headers: { authorization: "Bearer s3cret-s3cret" } })).status, 200);
    assert.equal((await on.request("/api/token/0x12/holders-history")).status, 400);
  });
});
