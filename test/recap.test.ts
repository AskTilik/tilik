import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WETH } from "../src/api/portfolio.js";
import { createRecap } from "../src/api/recap.js";
import { testEnv } from "./helpers.js";

const W = `0x${"a1".repeat(20)}`;
const ROUTER = `0x${"b2".repeat(20)}`;
const OTHER = `0x${"c3".repeat(20)}`;
const TOK = `0x${"d4".repeat(20)}`;
const NOW = Date.parse("2026-10-17T12:00:00Z");
const at = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const ref = (hash: string, extra = {}) => ({ hash, public_tags: [], ...extra });
const tx = (hash: string, daysAgo: number, from: string, to: string, valueEth: number, status = "ok", fee = 1e15) => ({
  hash, timestamp: at(daysAgo), from: ref(from), to: ref(to, { is_contract: to === ROUTER, name: to === ROUTER ? "Router" : null }), value: BigInt(Math.round(valueEth * 1e6)) * 10n ** 12n + "", status, method: null, block_number: 1, fee: { value: String(fee) },
});
const mv = (hash: string, daysAgo: number, from: string, to: string, amount: number) => ({
  transaction_hash: hash, timestamp: at(daysAgo), from: ref(from), to: ref(to), type: "token_transfer",
  token: { address_hash: TOK, symbol: "TOK", name: "Tok", decimals: "18", total_supply: null, holders_count: null, type: "ERC-20" },
  total: { value: BigInt(amount) * 10n ** 18n + "", decimals: "18" },
});
const env = testEnv({ ONCHAIN_ENABLED: "true" });
const prices = async () => ({ [WETH]: { priceUsd: 2000, liquidityUsd: 1e6 }, [TOK]: { priceUsd: 0.5, liquidityUsd: 50_000 } });

function fakeExplorer(txPages: unknown[][], mvPages: unknown[][], failAt?: number) {
  const pager = (pages: unknown[][]) => async (_a: string, after: Record<string, unknown> | null) => {
    const i = after ? Number(after.page) : 0;
    if (failAt !== undefined && i === failAt) throw new Error("slow page");
    return { items: pages[i] ?? [], next_page_params: i + 1 < pages.length ? { page: i + 1 } : null };
  };
  return { addressTransactionsPage: pager(txPages), addressTokenTransfersPage: pager(mvPages) } as any;
}

describe("weekly recap", () => {
  it("sums a week of activity: swaps, fees, ETH and tokens in and out, valued at today's price", async () => {
    const ex = fakeExplorer(
      [[
        tx("0x1", 1, W, ROUTER, 0.5), // swap: ETH out, TOK in
        tx("0x2", 2, OTHER, W, 0.25), // ETH received
        tx("0x3", 2, W, ROUTER, 0, "error"), // failed
        tx("0x9", 9, W, ROUTER, 3), // older than 7 days: stop here
      ]],
      [[mv("0x1", 1, ROUTER, W, 1000), mv("0x4", 3, W, OTHER, 200), mv("0x8", 8, OTHER, W, 5)]],
    );
    const r = await createRecap(env, console as any, prices, { explorer: ex, now: () => NOW }).get(W);
    assert.equal(r.complete, true);
    assert.equal(r.txs, 3);
    assert.equal(r.sent, 2);
    assert.equal(r.failed, 1);
    assert.equal(r.swaps, 1);
    assert.equal(r.ethOut, 0.5);
    assert.equal(r.ethIn, 0.25);
    assert.equal(r.feesEth, 0.002);
    assert.equal(r.feesUsd, 4);
    assert.equal(r.activeDays, 2);
    assert.deepEqual(r.tokens.map((t) => [t.symbol, t.in, t.out, t.netUsd]), [["TOK", 1000, 200, 400]]);
    assert.deepEqual(r.topContracts.map((c) => [c.label, c.txs]), [["Router", 2]]);
    assert.equal(r.priced, true);
  });

  it("says how far back it reaches when a busy wallet has more pages than it reads", async () => {
    const pages = Array.from({ length: 8 }, (_, i) => [tx(`0x${i}`, i * 0.5, W, ROUTER, 0)]);
    const r = await createRecap(env, console as any, prices, { explorer: fakeExplorer(pages, [[]]), now: () => NOW }).get(W);
    assert.equal(r.complete, false);
    assert.equal(r.coveredSince, at(2.5)); // 6 pages read, the oldest item is 2.5 days old
    assert.equal(r.txs, 6);
  });

  it("keeps what it read when a later page is slow, marked partial", async () => {
    const pages = [[tx("0xa", 0.1, W, ROUTER, 0)], [tx("0xb", 0.2, W, ROUTER, 0)], [tx("0xc", 0.3, W, ROUTER, 0)]];
    const r = await createRecap(env, console as any, prices, { explorer: fakeExplorer(pages, [[]], 2), now: () => NOW }).get(W);
    assert.equal(r.complete, false);
    assert.equal(r.txs, 2);
  });
});
