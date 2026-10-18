import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTokenCheckTool, TILIK_TOKEN } from "../src/api/token-check-tool.js";
import type { TokenIntel } from "../src/api/token.js";
import { testEnv } from "./helpers.js";

const TOKEN = `0x${"c3".repeat(20)}`, WALLET = `0x${"a1".repeat(20)}`;
const env = testEnv({ ONCHAIN_ENABLED: "true" });
const intelOf = (over: Partial<TokenIntel> = {}): TokenIntel => ({
  address: TOKEN,
  chain: { name: "Robinhood Chain", chainId: 4663 },
  token: { name: "Tilik", symbol: "TILIK", holders: 149 },
  market: { priceUsd: 0.0000075, liquidityUsd: 32600, volume24hUsd: 4000 },
  pools: [],
  checks: [{ id: "lp-lock", level: "ok", title: "Liquidity locked forever", detail: "held by PonsV2LaunchLocker" }],
  liquidityLock: { locked: true, locker: "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952", lockerName: "PonsV2LaunchLocker", positionId: "3820500", held: true, hasLiquidity: true, mainPool: true, permanent: true, note: "No withdraw function." },
  dev: { address: "0x648eCc353e78cA4c0ccb9086685846C31378038d", launchedVia: "PonsV2LaunchFactory", holdsPct: 0, received: 3, burned: 3, sentOut: 0 },
  snipers: { windowSec: 60, buyers: 25, boughtPct: 21.16, stillHoldPct: 1.42, checked: 15, soldAll: 14, top: [] },
  sources: [],
  generatedAt: "2026-10-18T00:00:00Z",
  ...over,
});
const decimals = (who: string[]) => ({ call: async (to: string) => (who.includes(to.toLowerCase()) ? `0x${(18).toString(16).padStart(64, "0")}` : "0x") }) as any;
const holders = { enabled: false } as any;

describe("TILIK token check in answers", () => {
  it("plans for token addresses and for $TILIK by name, only on chain or market questions", () => {
    const tool = createTokenCheckTool(env, { intel: {} as any, holders, provider: decimals([]) });
    const base = { entities: { urls: [], githubRepos: [], addresses: [TOKEN], txHashes: [], tickers: [] }, mode: "standard" as const };
    assert.deepEqual(tool.planInput({ ...base, query: `check ${TOKEN}`, intents: ["onchain"] }), { addresses: [TOKEN] });
    assert.deepEqual(tool.planInput({ ...base, entities: { ...base.entities, addresses: [] }, query: "is TILIK safe?", intents: ["market"] }), { addresses: [TILIK_TOKEN] });
    assert.equal(tool.planInput({ ...base, query: "hello", intents: ["general"] }), null);
  });

  it("gives the answer the same lock, dev wallet and early-buyer facts as the website", async () => {
    let calls = 0;
    const tool = createTokenCheckTool(env, { intel: { get: async () => (calls++, intelOf()) } as any, holders, provider: decimals([TOKEN]) });
    const r = await tool.execute({ addresses: [TOKEN] }, { query: "", entities: {} as any, signal: AbortSignal.timeout(5000) });
    const text = r.sources.map((s) => `${s.title}\n${s.content}`).join("\n\n");
    assert.match(text, /\[OK\] Liquidity locked forever/);
    assert.match(text, /#3820500 is held by PonsV2LaunchLocker/);
    assert.match(text, /Status: locked permanently/);
    assert.match(text, /holds 0% of the supply/);
    assert.match(text, /burned 3×/);
    assert.match(text, /25 wallets bought 21.16%/);
    assert.equal(r.sources[0]!.url, `https://asktilik.com/token/${TOKEN}`);
    assert.equal(calls, 1);
  });

  it("skips wallets with one cheap call, and treats an empty read as a failure", async () => {
    let calls = 0;
    const skip = createTokenCheckTool(env, { intel: { get: async () => (calls++, intelOf()) } as any, holders, provider: decimals([TOKEN]) });
    const r = await skip.execute({ addresses: [WALLET] }, { query: "", entities: {} as any, signal: AbortSignal.timeout(5000) });
    assert.equal(r.sources.length, 0);
    assert.equal(calls, 0, "no token check for a wallet");
    const empty = createTokenCheckTool(env, { intel: { get: async () => intelOf({ market: undefined, token: {} }) } as any, holders, provider: decimals([TOKEN]) });
    await assert.rejects(empty.execute({ addresses: [TOKEN] }, { query: "", entities: {} as any, signal: AbortSignal.timeout(5000) }));
  });
});
