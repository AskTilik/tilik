import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { createContainer } from "../src/container.js";
import { toChecksumAddress } from "../src/providers/blockchain/evm.js";
import { jsonResponse, mockFetch, testEnv } from "./helpers.js";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const BS = "https://explorer.example/api/v2";
const GT = "https://api.geckoterminal.com/api/v2";
const TOKEN = toChecksumAddress(`0x${"c3".repeat(20)}`);
const MAIN = `0x${"d4".repeat(32)}`;
const SIDE = toChecksumAddress(`0x${"e5".repeat(20)}`);
const WHALE = toChecksumAddress(`0x${"a1".repeat(20)}`);
const POOLMGR = toChecksumAddress(`0x${"b2".repeat(20)}`);
const DEV = toChecksumAddress(`0x${"de".repeat(20)}`);
const FACTORY = toChecksumAddress(`0x${"fa".repeat(20)}`);
const CREATE_TX = `0x${"cc".repeat(32)}`;
const hex = (n: number | bigint) => `0x${n.toString(16)}`;
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const abiString = (s: string) => {
  const b = Buffer.from(s, "utf8");
  return `0x${word(32)}${word(b.length)}${b.toString("hex").padEnd(Math.ceil(b.length / 32) * 64, "0")}`;
};

function rpc(body: any) {
  const { method, params = [], id } = body;
  const ok = (result: unknown) => jsonResponse({ jsonrpc: "2.0", id, result });
  if (method === "eth_chainId") return ok(hex(4663));
  if (method === "eth_getBalance") return ok("0x0");
  if (method === "eth_getTransactionCount") return ok("0x0");
  if (method === "eth_getCode") return ok(params[0].toLowerCase() === TOKEN.toLowerCase() ? "0x6080" : "0x");
  if (method === "eth_call") {
    const sel = params[0].data.slice(0, 10);
    if (sel === "0x06fdde03") return ok(abiString("Tilik"));
    if (sel === "0x95d89b41") return ok(abiString("TILIK"));
    if (sel === "0x313ce567") return ok(`0x${word(18)}`);
    if (sel === "0x18160ddd") return ok(`0x${word(1_000_000_000n * 10n ** 18n)}`);
  }
  return jsonResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: "n/a" } });
}

const gtPool = (address: string, name: string, dex: string, liq: string, created = "2026-10-15T05:38:21Z", base = TOKEN) => ({
  id: `robinhood_${address}`,
  type: "pool",
  attributes: { address, name, reserve_in_usd: liq, volume_usd: { h24: "1000" }, transactions: { h24: { buys: 10, sells: 5 } }, price_change_percentage: { h24: "-3.5" }, base_token_price_usd: "0.0000169", pool_created_at: created },
  relationships: { dex: { data: { id: dex } }, base_token: { data: { id: `robinhood_${base.toLowerCase()}` } } },
});

function gt(path: string): Response {
  const t = TOKEN.toLowerCase();
  if (path === `/networks/robinhood/tokens/${t}`)
    return jsonResponse({ data: { attributes: { name: "Tilik", symbol: "TILIK", total_supply: "1000000000000000000000000000.0", price_usd: "0.0000169", fdv_usd: "16948", total_reserve_in_usd: "23931", volume_usd: { h24: "89653" }, launchpad_details: { completed: true, completed_at: "2026-10-15T05:38:21.000Z", migrated_destination_pool_address: MAIN } } } });
  if (path.startsWith(`/networks/robinhood/tokens/${t}/pools`))
    return jsonResponse({ data: [gtPool(SIDE, "TILIK / USDG 90%", "uniswap-v4-robinhood", "14"), gtPool(MAIN, "TILIK / WETH", "pons-v2-dex", "23931")] });
  if (path.startsWith(`/networks/robinhood/pools/${MAIN}/ohlcv/minute`))
    return jsonResponse({ data: { attributes: { ohlcv_list: [[1760000900, 2, 3, 1.5, 2.5, 100], [1760000000, 1, 2, 0.9, 2, 50], [1760001800, 0, 0, 0, 0, 0]] } } });
  if (path === `/networks/robinhood/pools/${MAIN}/trades`)
    return jsonResponse({
      data: [
        { attributes: { kind: "buy", volume_in_usd: "30", block_timestamp: "2026-10-15T08:50:23Z", tx_hash: `0x${"11".repeat(32)}`, tx_from_address: WHALE.toLowerCase(), to_token_address: TOKEN.toLowerCase(), to_token_amount: "1500000", price_to_in_usd: "0.00002" } },
        { attributes: { kind: "sell", volume_in_usd: "900", block_timestamp: "2026-10-15T08:51:00Z", tx_hash: `0x${"22".repeat(32)}`, tx_from_address: SIDE.toLowerCase(), from_token_address: TOKEN.toLowerCase(), from_token_amount: "40000000", price_from_in_usd: "0.0000225" } },
        { attributes: { kind: "weird", volume_in_usd: "1" } },
      ],
    });
  if (path.startsWith("/networks/robinhood/trending_pools")) return jsonResponse({ data: [gtPool(MAIN, "TILIK / WETH", "pons-v2-dex", "23931"), gtPool(SIDE, "JUNK / WETH 90%", "uniswap-v4-robinhood", "5000")] });
  if (path.startsWith("/networks/robinhood/new_pools?page=1&include=base_token"))
    return jsonResponse({
      data: [
        gtPool(MAIN, "TILIK / WETH", "pons-v2-dex", "23931", new Date().toISOString()),
        gtPool(SIDE, "JUNK / WETH 90%", "uniswap-v4-robinhood", "12", new Date().toISOString(), WHALE),
        gtPool(`0x${"77".repeat(32)}`, "TILIK / USDG", "uniswap-v4-robinhood", "50", new Date().toISOString()), // same token again
      ],
      included: [{ id: `robinhood_${TOKEN.toLowerCase()}`, attributes: { symbol: "TILIK", name: "Tilik" } }, { id: `robinhood_${WHALE.toLowerCase()}`, attributes: { symbol: "JUNK", name: "Junk" } }],
    });
  if (path.startsWith("/networks/robinhood/new_pools")) return jsonResponse({ data: [gtPool(SIDE, "NEW / WETH", "pons-v2", "0", new Date().toISOString())] });
  return new Response("{}", { status: 404 });
}

function explorer(path: string): Response {
  const p = path.replace(/\?.*$/, "").toLowerCase();
  const t = TOKEN.toLowerCase();
  const d = DEV.toLowerCase(), ref = (hash: string) => ({ hash, public_tags: [] });
  if (p === `/addresses/${t}`) return jsonResponse({ hash: TOKEN, name: "PonsV2LauncherToken", is_contract: true, is_verified: true, public_tags: [], creation_transaction_hash: CREATE_TX });
  if (p === `/transactions/${CREATE_TX}`)
    return jsonResponse({ hash: CREATE_TX, timestamp: "2026-10-14T19:31:42.000000Z", from: ref(DEV), to: { hash: FACTORY, name: "PonsV2LaunchFactory", public_tags: [] }, method: "launchToken", value: "0", status: "ok", block_number: 1 });
  if (p === `/addresses/${d}/token-transfers`) {
    const tok = { address_hash: TOKEN, name: "Tilik", symbol: "TILIK", decimals: "18", total_supply: null, holders_count: null, type: "ERC-20" };
    const mv = (from: string, to: string) => ({ transaction_hash: "0x1", timestamp: null, from: ref(from), to: ref(to), token: tok, total: { value: "1" }, type: "token_transfer" });
    return jsonResponse({ items: [mv(POOLMGR, DEV), mv(DEV, `0x${"0".repeat(40)}`), mv(POOLMGR, DEV), mv(DEV, WHALE)] });
  }
  if (p === `/addresses/${d}/tokens`)
    return jsonResponse({ items: [{ token: { address_hash: TOKEN }, value: "250000000000000000000000000" }] }); // 25% of supply
  if (p === `/addresses/${d}/transactions`)
    return jsonResponse({ items: Array.from({ length: 6 }, () => ({ to: ref(FACTORY), method: "launchToken" })).concat([{ to: ref(WHALE), method: "transfer" }] as any) });
  if (p === `/addresses/${d}/counters`) return jsonResponse({ transactions_count: "17" });
  if (p === `/tokens/${t}`) return jsonResponse({ address_hash: TOKEN, name: "Tilik", symbol: "TILIK", decimals: "18", total_supply: "1000000000000000000000000000", holders_count: "227", type: "ERC-20" });
  if (p === `/tokens/${t}/holders`)
    return jsonResponse({
      items: [
        { address: { hash: POOLMGR, name: "PoolManager", is_contract: true, public_tags: [] }, value: "336000000000000000000000000" },
        { address: { hash: `0x${"f6".repeat(20)}`, name: "PonsV2LaunchLocker", is_contract: true, public_tags: [] }, value: "81600000000000000000000000" },
        { address: { hash: WHALE, name: null, is_contract: false, public_tags: [] }, value: "50000000000000000000000000" },
      ],
    });
  return jsonResponse({ items: [] });
}

let net: ReturnType<typeof mockFetch> | undefined;
afterEach(() => net?.restore());

function app(env: Record<string, string> = {}) {
  net = mockFetch((url, body) => {
    if (url === RPC) return rpc(body);
    if (url.startsWith(GT)) return gt(decodeURIComponent(url.slice(GT.length)));
    if (url.startsWith(BS)) return explorer(decodeURIComponent(url.slice(BS.length)));
    return new Response("unexpected", { status: 500 });
  });
  return createApp(createContainer(testEnv({ ONCHAIN_ENABLED: "true", MARKET_ENABLED: "true", ONCHAIN_RPC_RETRIES: "0", ROBINHOOD_EXPLORER_API_URL: BS, ...env })));
}

describe("token check API", () => {
  it("ranks pools by real liquidity, flags high-fee pools and computes holder concentration without pools/lockers", async () => {
    const res = await app().request(`/api/token/${TOKEN}`);
    assert.equal(res.status, 200);
    const t: any = await res.json();
    assert.equal(t.token.symbol, "TILIK");
    assert.equal(t.pools[0].name, "TILIK / WETH");
    assert.equal(t.pools[0].main, true);
    assert.equal(t.pools[1].feePct, 90);
    assert.equal(t.market.graduated.pool, MAIN);
    assert.equal(t.holders.top[0].role, "pool");
    assert.equal(t.holders.top[1].role, "locker");
    assert.equal(t.holders.top10Pct, 5); // only the plain wallet counts
    const byId = Object.fromEntries(t.checks.map((c: any) => [c.id, c]));
    assert.equal(byId.verified.level, "ok");
    assert.equal(byId.graduated.level, "ok");
    assert.equal(byId.fees.level, "warn");
    assert.equal(byId.liquidity.level, "info");
    assert.equal(byId.holders.level, "ok");
    assert.equal(t.checks[0].level, "warn"); // most important first
  });

  it("finds the dev wallet from the creation transaction and reports what it did with the token", async () => {
    const t: any = await (await app().request(`/api/token/${TOKEN}`)).json();
    assert.equal(t.dev.address, DEV);
    assert.equal(t.dev.launchedVia, "PonsV2LaunchFactory");
    assert.equal(t.dev.launches, 6);
    assert.equal(t.dev.holdsPct, 25);
    assert.deepEqual([t.dev.received, t.dev.burned, t.dev.sentOut], [2, 1, 1]);
    assert.equal(t.dev.walletTxs, 17);
    const byId = Object.fromEntries(t.checks.map((c: any) => [c.id, c]));
    assert.equal(byId["dev-holds"].level, "warn");
    assert.equal(byId["dev-launches"].level, "warn");
    assert.equal(byId["dev-burned"].level, "ok");
    assert.equal(byId["dev-sent"].level, "info");
  });

  it("rejects bad addresses and non-tokens", async () => {
    const a = app();
    assert.equal((await a.request("/api/token/0x12")).status, 400);
    net!.restore();
    net = mockFetch((url, body) => (url === RPC ? rpc(body) : url.startsWith(GT) ? new Response("{}", { status: 404 }) : jsonResponse({ items: [] })));
    const b = createApp(createContainer(testEnv({ ONCHAIN_ENABLED: "true", MARKET_ENABLED: "true", ONCHAIN_RPC_RETRIES: "0", ROBINHOOD_EXPLORER_API_URL: "none" })));
    assert.equal((await b.request(`/api/token/${WHALE}`)).status, 400);
  });

  it("radar lists trending and new pools and hides pools with a 10%+ fee", async () => {
    const res = await app().request("/api/radar");
    assert.equal(res.status, 200);
    const r: any = await res.json();
    assert.deepEqual(r.trending.map((p: any) => p.name), ["TILIK / WETH"]);
    assert.equal(r.trending[0].token.address, TOKEN);
    assert.equal(r.fresh.length, 1);
  });
});

describe("token chart and trades", () => {
  it("returns main-pool candles oldest first and drops empty ones", async () => {
    const res = await app().request(`/api/token/${TOKEN}/chart?tf=15m`);
    assert.equal(res.status, 200);
    const c: any = await res.json();
    assert.equal(c.pool.name, "TILIK / WETH");
    assert.deepEqual(c.candles.map((x: number[]) => x[0]), [1760000000, 1760000900]);
    assert.match(res.headers.get("cache-control") ?? "", /public.*s-maxage=60/); // CDN serves repeats
    const bad = await app().request(`/api/token/${TOKEN}/chart?tf=7m`);
    assert.equal(bad.headers.get("cache-control"), "no-store"); // errors are never cached
    assert.equal((await app().request(`/api/token/${TOKEN}/chart?tf=7m`)).status, 400);
  });

  it("returns the latest trades newest first with buy/sell pressure and whales (2% of liquidity)", async () => {
    const res = await app().request(`/api/token/${TOKEN}/trades`);
    assert.equal(res.status, 200);
    const d: any = await res.json();
    assert.equal(d.trades.length, 2);
    assert.equal(d.trades[0].kind, "sell");
    assert.equal(d.trades[0].whale, true); // 900 >= max(100, 2% of 23,931)
    assert.equal(d.trades[1].whale, undefined);
    assert.equal(d.trades[1].amount, 1500000);
    assert.deepEqual({ buys: d.summary.buys, sells: d.summary.sells, buyUsd: d.summary.buyUsd, sellUsd: d.summary.sellUsd, wallets: d.summary.wallets, whaleUsd: d.summary.whaleUsd }, { buys: 1, sells: 1, buyUsd: 30, sellUsd: 900, wallets: 2, whaleUsd: 479 });
  });
});

describe("new launch feed", () => {
  it("lists each new token once with plain flags, worst first", async () => {
    const res = await app().request("/api/launches");
    assert.equal(res.status, 200);
    const d: any = await res.json();
    assert.equal(d.launches.length, 2);
    const [tilik, junk] = d.launches;
    assert.equal(tilik.token.symbol, "TILIK");
    assert.equal(tilik.holders, 227);
    assert.equal(tilik.verified, true);
    assert.equal(tilik.level, "ok");
    assert.equal(junk.level, "risk");
    assert.deepEqual(junk.flags.slice(0, 2).map((f: any) => f.text), ["90% pool fee", "Very low liquidity ($12)"]);
    assert.match(res.headers.get("cache-control") ?? "", /s-maxage/);
  });
});

describe("shareable lookup pages", () => {
  it("serve the landing page with a title and preview text for the token, address or transaction", async () => {
    const a = app();
    const tok = await a.request(`/token/${TOKEN}`);
    assert.equal(tok.status, 200);
    const html = await tok.text();
    assert.match(html, /<title>\$TILIK on Robinhood Chain · TILIK<\/title>/);
    assert.match(html, /og:url" content="https:\/\/asktilik\.com\/token\//);
    assert.match(html, /227 holders/);
    const tx = await a.request(`/tx/0x${"ab".repeat(32)}`);
    assert.match(await tx.text(), /<title>Transaction 0xabab…abab on Robinhood Chain · TILIK<\/title>/);
    assert.equal((await a.request("/token/0x123")).status, 404);
    const cmp = await a.request(`/compare/${TOKEN}/${WHALE}`);
    assert.equal(cmp.status, 200);
    assert.match(await cmp.text(), /<title>\$TILIK vs /);
  });
});
