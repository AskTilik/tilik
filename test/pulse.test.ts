import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createPulse, PULSE_MIN_LIQUIDITY_USD } from "../src/api/pulse.js";
import { silentLogger } from "../src/core/logger.js";
import { jsonResponse, mockFetch, testEnv } from "./helpers.js";

const RPC = "https://rpc.example-provider.com/v2/SECRETKEYSECRETKEY1234";
const pool = (name: string, address: string, liquidity: number, extra: Record<string, unknown> = {}) => ({
  attributes: { name, address, base_token_price_usd: "1.0001", reserve_in_usd: String(liquidity), volume_usd: { h24: "5000000" }, price_change_percentage: { h24: "0.12" }, ...extra },
});
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

let net: ReturnType<typeof mockFetch> | undefined;
afterEach(() => net?.restore());

function world(opts: { rpcDown?: boolean; geckoDown?: boolean } = {}) {
  return mockFetch((url, body) => {
    if (url.startsWith("https://rpc.example-provider.com")) {
      if (opts.rpcDown) throw new TypeError("fetch failed");
      if (body.method === "eth_chainId") return jsonResponse({ jsonrpc: "2.0", id: body.id, result: "0x1237" }); // 4663
      if (body.method === "eth_getBlockByNumber")
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { number: "0x4dcf2a6", hash: `0x${"ab".repeat(32)}`, timestamp: "0x6700a000", transactions: ["0x1", "0x2", "0x3"], gasUsed: "0x5f5e100", gasLimit: "0x2faf0800", parentHash: `0x${"cd".repeat(32)}`, miner: addr(1) } });
    }
    if (url.includes("api.geckoterminal.com")) {
      if (opts.geckoDown) return jsonResponse({ errors: ["down"] }, 500);
      return jsonResponse({
        data: [
          pool("SCAM / WETH", addr(10), 3_000, { volume_usd: { h24: "18000000" }, price_change_percentage: { h24: "-99.9" } }),
          pool("USDG / WETH 0.01%", addr(11), 22_000_000),
          pool("NVDA / USDG", addr(12), 1_200_000),
          pool("THIN / WETH", addr(13), PULSE_MIN_LIQUIDITY_USD - 1),
          pool("WETH / USDG", addr(14), 780_000),
          pool("BAD ADDRESS", "not-an-address", 9_000_000),
        ],
      });
    }
    return new Response("<rss></rss>", { status: 200, headers: { "content-type": "application/rss+xml" } });
  });
}

const pulseFor = (opts: Parameters<typeof world>[0] = {}, now = () => Date.now()) => {
  net = world(opts);
  return createPulse(testEnv({ ROBINHOOD_RPC_URL: RPC, ONCHAIN_ENABLED: "true", MARKET_ENABLED: "true", RSS_ENABLED: "false" }), silentLogger, { now });
};

describe("/api/pulse", () => {
  it("returns the latest block and only pools with real liquidity, ranked by liquidity", async () => {
    const p = await pulseFor().get();
    assert.equal(p.chain.ok, true);
    assert.equal(p.chain.chainId, 4663);
    assert.equal(p.chain.txCount, 3);
    assert.ok(p.chain.blockNumber! > 0);
    assert.deepEqual(p.market.pools.map((x) => x.name), ["USDG / WETH 0.01%", "NVDA / USDG", "WETH / USDG"]);
    assert.ok(p.market.pools.every((x) => (x.liquidityUsd ?? 0) >= PULSE_MIN_LIQUIDITY_USD), "thin / wash-traded pools never shown");
  });

  it("never returns the RPC URL (it can embed a provider key) or error details", async () => {
    const json = JSON.stringify(await pulseFor().get());
    assert.ok(!json.includes("SECRETKEY") && !json.includes("rpc.example-provider.com"));
    const down = JSON.stringify(await pulseFor({ rpcDown: true, geckoDown: true }).get());
    assert.doesNotMatch(down, /fetch failed|SECRETKEY|stack|status/);
  });

  it("each part fails on its own", async () => {
    const p = await pulseFor({ rpcDown: true }).get();
    assert.equal(p.chain.ok, false);
    assert.equal(p.market.ok, true);
    assert.ok(p.market.pools.length > 0);
  });

  it("is cached: many visitors cause one round of upstream calls per minute", async () => {
    let t = 1_000_000;
    const pulse = pulseFor({}, () => t);
    const [a, b, c] = await Promise.all([pulse.get(), pulse.get(), pulse.get()]);
    assert.equal(a, b, "concurrent visitors share one refresh");
    assert.equal(b, c);
    const first = net!.calls.length;
    assert.equal(await pulse.get(), a, "served from cache");
    assert.equal(net!.calls.length, first, "no upstream calls while cached");
    t += 61_000;
    const later = await pulse.get();
    assert.notEqual(later.generatedAt, a.generatedAt, "a new snapshot after the TTL");
  });
});
