import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { WETH } from "../src/api/portfolio.js";
import { createContainer } from "../src/container.js";
import { toChecksumAddress } from "../src/providers/blockchain/evm.js";
import { jsonResponse, mockFetch, testEnv } from "./helpers.js";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const BS = "https://explorer.example/api/v2";
const GT = "https://api.geckoterminal.com/api/v2";
const WALLET = toChecksumAddress(`0x${"a1".repeat(20)}`);
const TILIK = `0x${"c3".repeat(20)}`;
const THIN = `0x${"d4".repeat(20)}`;
const DUST = `0x${"e5".repeat(20)}`;
const hex = (n: bigint) => `0x${n.toString(16)}`;
const tok = (address_hash: string, symbol: string) => ({ address_hash, symbol, name: symbol, decimals: "18", total_supply: null, holders_count: null, type: "ERC-20" });

let net: ReturnType<typeof mockFetch> | undefined;
let priceCalls: string[] = [];
afterEach(() => net?.restore());

function app(env: Record<string, string> = {}) {
  priceCalls = [];
  net = mockFetch((url, body) => {
    if (url === RPC) {
      const ok = (result: unknown) => jsonResponse({ jsonrpc: "2.0", id: body.id, result });
      if (body.method === "eth_chainId") return ok("0x1237");
      if (body.method === "eth_getBalance") return ok(hex(2n * 10n ** 18n)); // 2 ETH
      return ok("0x0");
    }
    if (url.startsWith(BS)) {
      return jsonResponse({
        items: [
          { token: tok(TILIK, "TILIK"), value: (1_000_000n * 10n ** 18n).toString() },
          { token: tok(THIN, "THIN"), value: (500n * 10n ** 18n).toString() },
          { token: tok(DUST, "DUST"), value: (7n * 10n ** 18n).toString() },
          { token: tok(DUST, "ZERO"), value: "0" },
        ],
      });
    }
    if (url.startsWith(`${GT}/simple/networks/robinhood/token_price/`)) {
      priceCalls.push(url);
      return jsonResponse({
        data: {
          attributes: {
            token_prices: { [WETH]: "2000", [TILIK]: "0.0001", [THIN]: "10" },
            h24_price_change_percentage: { [WETH]: "0", [TILIK]: "-50" },
            total_reserve_in_usd: { [WETH]: "70000000", [TILIK]: "23000", [THIN]: "200" },
          },
        },
      });
    }
    return new Response("unexpected " + url, { status: 500 });
  });
  return createApp(createContainer(testEnv({ ONCHAIN_ENABLED: "true", MARKET_ENABLED: "true", ONCHAIN_RPC_RETRIES: "0", ROBINHOOD_EXPLORER_API_URL: BS, ...env })));
}

describe("portfolio API", () => {
  it("prices native ETH and tokens in one call, skips zero balances and leaves thin markets out of the total", async () => {
    const res = await app().request(`/api/portfolio/${WALLET}`);
    assert.equal(res.status, 200);
    const p: any = await res.json();
    assert.equal(priceCalls.length, 1);
    // 2 ETH × $2000 + 1,000,000 TILIK × $0.0001 = $4,100; THIN ($5,000 on a $200 pool) is not counted.
    assert.equal(p.totalUsd, 4100);
    // TILIK was $0.0002 yesterday (-50%): $100 now vs $200 then; ETH unchanged.
    assert.equal(p.change24hUsd, -100);
    assert.equal(p.change24hPct, -2.38);
    assert.deepEqual(p.holdings.map((h: any) => h.symbol), ["ETH", "TILIK", "DUST", "THIN"]);
    assert.equal(p.holdings.find((h: any) => h.symbol === "THIN").thin, true);
    assert.equal(p.unpriced, 1);
    assert.match(res.headers.get("cache-control") ?? "", /s-maxage/);
  });

  it("rejects malformed wallets", async () => {
    assert.equal((await app().request("/api/portfolio/0x12")).status, 400);
  });
});

describe("watchlist prices API", () => {
  it("prices up to 30 tokens in one call", async () => {
    const res = await app().request(`/api/prices?tokens=${TILIK},${WETH}`);
    assert.equal(res.status, 200);
    const d: any = await res.json();
    assert.deepEqual(d.prices[TILIK], { priceUsd: 0.0001, change24hPct: -50, liquidityUsd: 23000 });
    assert.equal(d.prices[WETH].priceUsd, 2000);
  });

  it("validates the token list", async () => {
    const a = app();
    assert.equal((await a.request("/api/prices")).status, 400);
    assert.equal((await a.request("/api/prices?tokens=0x12")).status, 400);
    const many = Array.from({ length: 31 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`).join(",");
    assert.equal((await a.request(`/api/prices?tokens=${many}`)).status, 400);
  });
});
