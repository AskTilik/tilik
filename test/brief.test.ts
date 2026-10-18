import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { briefFacts, briefRoutes, createBrief } from "../src/api/brief.js";
import type { TokenIntel } from "../src/api/token.js";
import { testEnv } from "./helpers.js";

const TOKEN = `0x${"c3".repeat(20)}`;
const env = testEnv();
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as any;
const intel: TokenIntel = {
  address: TOKEN,
  chain: { name: "Robinhood Chain", chainId: 4663 },
  token: { name: "Tilik", symbol: "TILIK", holders: 129 },
  market: { priceUsd: 0.0000051, liquidityUsd: 37000, volume24hUsd: 4100 },
  pools: [{ name: "TILIK / WETH", dex: "pons-v2-dex", address: "0x1", main: true, change24hPct: -31.6, url: "" }],
  checks: [{ id: "fees", level: "warn", title: "6 pools with a very high fee", detail: "" }],
  liquidityLock: { locked: true, locker: "0x1", lockerName: "PonsV2LaunchLocker", positionId: "3820500", held: true, hasLiquidity: true, mainPool: true, permanent: true, note: "" },
  dev: { address: "0x648eCc353e78cA4c0ccb9086685846C31378038d", holdsPct: 0, received: 5, burned: 5, sentOut: 0 },
  snipers: { windowSec: 60, buyers: 25, boughtPct: 21.16, stillHoldPct: 2.15, checked: 15, soldAll: 14, top: [] },
  sells: { buys: 31, sells: 53, buyers: 28, sellers: 43 },
  sources: [],
  generatedAt: "",
};
const models = (reply: unknown) => {
  const calls: any[] = [];
  return {
    calls,
    plan: () => ({ tier: "fast", candidates: [], skipped: [] }) as any,
    structured: async (_plan: unknown, messages: any) => {
      calls.push(messages);
      return { value: { data: reply }, attempts: [], candidate: { provider: { id: "fake" }, model: "m" } } as any;
    },
  };
};

describe("AI token brief", () => {
  it("gives the model only numbered facts read by the token check", () => {
    const f = briefFacts(intel);
    assert.ok(f.some((x) => /locked permanently/.test(x)));
    assert.ok(f.some((x) => /dev wallet holds 0%/i.test(x)));
    assert.ok(f.some((x) => /53 sells by 43 wallets/.test(x)));
    assert.ok(f.some((x) => /Flag \(warn\): 6 pools with a very high fee/.test(x)));
    assert.ok(f.some((x) => /−31\.6% in 24 hours/.test(x)));
  });

  it("keeps only sentences that cite real facts and drops advice or hype", async () => {
    const m = models({
      headline: "TILIK at a glance",
      points: [
        { text: "Liquidity is locked permanently.", facts: [4] },
        { text: "The dev wallet holds none of the supply.", facts: [6] },
        { text: "This one cites a fact that does not exist.", facts: [99] },
        { text: "It will pump soon, buy now.", facts: [1] },
      ],
    });
    const b = createBrief(env, quiet, { intel: { get: async () => intel }, models: m });
    const r = await b.get(TOKEN);
    assert.deepEqual(r.points.map((p) => p.text), ["Liquidity is locked permanently.", "The dev wallet holds none of the supply."]);
    assert.match(m.calls[0][1].content, /\[4\] The main pool's liquidity position/);
    assert.match(m.calls[0][0].content, /Use ONLY the numbered FACTS/);
    // same facts again: served from cache, no second model call
    await b.get(TOKEN);
    assert.equal(m.calls.length, 1);
  });

  it("refuses a brief that has nothing valid left, and validates the address", async () => {
    const bad = createBrief(env, quiet, { intel: { get: async () => intel }, models: models({ headline: "x y z", points: [{ text: "Moon soon", facts: [99] }] }) });
    await assert.rejects(bad.get(TOKEN));
    const app = new Hono().route("/", briefRoutes(env, { take: () => ({ ok: true }) } as any, bad));
    assert.equal((await app.request("/api/token/0x12/brief")).status, 400);
    assert.equal((await app.request(`/api/token/${TOKEN}/brief`)).status, 502);
  });
});
