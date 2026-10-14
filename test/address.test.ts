import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { createContainer } from "../src/container.js";
import { toChecksumAddress } from "../src/providers/blockchain/evm.js";
import { jsonResponse, mockFetch, testEnv } from "./helpers.js";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const BS = "https://explorer.example/api/v2";
const WALLET = toChecksumAddress(`0x${"a1".repeat(20)}`);
const OTHER = toChecksumAddress(`0x${"b2".repeat(20)}`);
const TOKEN = toChecksumAddress(`0x${"c3".repeat(20)}`);
const TX = `0x${"ab".repeat(32)}`;

const hex = (n: number | bigint) => `0x${n.toString(16)}`;
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const abiString = (s: string) => {
  const b = Buffer.from(s, "utf8");
  return `0x${word(32)}${word(b.length)}${b.toString("hex").padEnd(Math.ceil(b.length / 32) * 64, "0")}`;
};

function rpc(body: any) {
  const { method, params = [], id } = body;
  const ok = (result: unknown) => jsonResponse({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "eth_chainId":
      return ok(hex(4663));
    case "eth_getBalance":
      return ok(hex(2_250_000_000_000_000_000n));
    case "eth_getTransactionByHash":
      return ok(params[0] === TX ? { hash: TX, blockNumber: hex(100), from: WALLET.toLowerCase(), to: OTHER.toLowerCase(), value: hex(10_000_000_000_000_000n), nonce: "0x1", gas: hex(90_000), gasPrice: hex(1_000_000), input: "0x39ecce49", type: "0x2" } : null);
    case "eth_getTransactionReceipt":
      return ok(params[0] === TX ? { status: "0x1", gasUsed: hex(60_000), effectiveGasPrice: hex(1_000_000_000), contractAddress: null, logs: [] } : null);
    case "eth_getBlockByNumber":
      return ok({ number: hex(100), hash: `0x${"0".repeat(64)}`, timestamp: hex(1_760_000_000), gasUsed: "0x0", gasLimit: "0x1", transactions: [] });
    case "eth_getTransactionCount":
      return ok(hex(42));
    case "eth_getCode":
      return ok(params[0].toLowerCase() === TOKEN.toLowerCase() ? "0x6080604052" : "0x");
    case "eth_call": {
      const sel = params[0].data.slice(0, 10);
      if (sel === "0x06fdde03") return ok(abiString("Tilik"));
      if (sel === "0x95d89b41") return ok(abiString("TILIK"));
      if (sel === "0x313ce567") return ok(`0x${word(18)}`);
      if (sel === "0x18160ddd") return ok(`0x${word(1_000_000_000n * 10n ** 18n)}`);
      return ok("0x");
    }
    default:
      return jsonResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: "not available" } });
  }
}

const ref = (hash: string, extra: Record<string, unknown> = {}) => ({ hash, name: null, is_contract: false, public_tags: [], ...extra });
const bsToken = { address_hash: TOKEN, name: "Tilik", symbol: "TILIK", decimals: "18", total_supply: "1000000000000000000000000000", holders_count: "321", type: "ERC-20" };

function explorer(path: string): Response {
  const p = path.replace(/\?.*$/, "").toLowerCase();
  const w = WALLET.toLowerCase();
  if (p === `/addresses/${w}`) return jsonResponse({ hash: WALLET, name: null, is_contract: false, is_verified: null, coin_balance: "2250000000000000000", public_tags: [{ display_name: "Active <b>trader</b>" }] });
  if (p === `/addresses/${w}/counters`) return jsonResponse({ transactions_count: "13949", token_transfers_count: "29" });
  if (p === `/addresses/${w}/transactions`)
    return jsonResponse({ items: [{ hash: TX, block_number: 1, timestamp: "2026-10-06T07:59:00Z", from: ref(WALLET), to: ref(OTHER, { name: "SwapRouter", is_contract: true }), value: "1500000000000000000", status: "ok", method: "swap" }] });
  if (p === `/addresses/${w}/token-transfers`)
    return jsonResponse({ items: [{ transaction_hash: TX, timestamp: "2026-10-06T07:59:00Z", from: ref(OTHER), to: ref(WALLET), token: bsToken, total: { value: "250000000000000000000", decimals: "18" }, type: "token_transfer" }] });
  if (p === `/addresses/${w}/tokens`) return jsonResponse({ items: [{ token: bsToken, value: "42000000000000000000" }] });
  if (p === `/transactions/${TX}`) return jsonResponse({ hash: TX, block_number: 100, timestamp: "2026-10-14T21:47:38Z", from: ref(WALLET), to: ref(OTHER, { name: "PonsRouter", is_contract: true }), value: "10000000000000000", status: "ok", method: "buy", fee: { value: "60000000000000" } });
  if (p === `/transactions/${TX}/token-transfers`) return jsonResponse({ items: [{ transaction_hash: TX, timestamp: null, from: ref(OTHER), to: ref(WALLET), token: bsToken, total: { value: "1692561430800000000000000", decimals: "18" }, type: "token_transfer" }] });
  return new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
}

let net: ReturnType<typeof mockFetch> | undefined;
afterEach(() => net?.restore());

function setup(env: Record<string, string> = {}) {
  net = mockFetch((url, body) => {
    if (url === RPC) return rpc(body);
    if (url.startsWith(BS)) return explorer(decodeURIComponent(url.slice(BS.length)));
    return new Response("unexpected", { status: 500 });
  });
  const app = createApp(createContainer(testEnv({ ONCHAIN_ENABLED: "true", ONCHAIN_RPC_RETRIES: "0", ...env })));
  return (addr: string) => app.request(`/api/address/${addr}`);
}

describe("address lookup API", () => {
  it("rejects malformed addresses without touching the chain", async () => {
    const get = setup();
    const res = await get("0x1234");
    assert.equal(res.status, 400);
    assert.equal(net!.calls.length, 0);
  });

  it("reads a token contract from the RPC alone when no explorer is configured", async () => {
    const get = setup({ ROBINHOOD_EXPLORER_API_URL: "none" });
    const res = await get(TOKEN.toLowerCase());
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.address, TOKEN);
    assert.equal(body.kind, "token");
    assert.deepEqual(body.token, { name: "Tilik", symbol: "TILIK", decimals: 18, totalSupply: "1,000,000,000" });
    assert.equal(body.chain.chainId, 4663);
    assert.equal(body.history.available, false);
    assert.match(body.history.reason, /explorer API/);
    assert.equal(body.transactions, undefined);
  });

  it("adds history, holdings and transfers from the explorer, with cleaned labels and explorer links", async () => {
    const get = setup({ ROBINHOOD_EXPLORER_API_URL: BS, ROBINHOOD_EXPLORER_URL: "https://explorer.example" });
    const res = await get(WALLET);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.kind, "wallet");
    assert.deepEqual(body.balance, { value: "2.25", symbol: "ETH" });
    assert.equal(body.sent, 42);
    assert.deepEqual(body.counters, { transactions: 13949, tokenTransfers: 29 });
    assert.equal(body.label, "Active <b>trader</b>"); // plain text: the UI renders it with textContent
    assert.equal(body.history.available, true);
    assert.equal(body.transactions[0].direction, "out");
    assert.equal(body.transactions[0].value, "1.5");
    assert.equal(body.transactions[0].counterpartyLabel, "SwapRouter");
    assert.equal(body.transactions[0].url, `https://explorer.example/tx/${TX}`);
    assert.equal(body.transfers[0].direction, "in");
    assert.equal(body.transfers[0].amount, "250");
    assert.equal(body.transfers[0].token.symbol, "TILIK");
    assert.deepEqual(body.holdings[0], { address: TOKEN, symbol: "TILIK", name: "Tilik", balance: "42", url: `https://explorer.example/token/${TOKEN}` });
  });

  it("caches a lookup so repeated requests don't hit the chain again", async () => {
    const get = setup({ ROBINHOOD_EXPLORER_API_URL: "none" });
    await get(WALLET);
    const calls = net!.calls.length;
    const again = await get(WALLET.toLowerCase());
    assert.equal(again.status, 200);
    assert.equal(net!.calls.length, calls);
  });

  it("limits lookups per client", async () => {
    const get = setup({ ROBINHOOD_EXPLORER_API_URL: "none", RATE_LIMIT_ENABLED: "true" });
    let last = 200;
    for (let i = 0; i < 21; i++) last = (await get(WALLET)).status;
    assert.equal(last, 429);
  });

  it("answers 502 with a friendly message when the chain cannot be read", async () => {
    net = mockFetch(() => new Response("down", { status: 503 }));
    const app = createApp(createContainer(testEnv({ ONCHAIN_ENABLED: "true", ONCHAIN_RPC_RETRIES: "0", ROBINHOOD_EXPLORER_API_URL: "none" })));
    const res = await app.request(`/api/address/${WALLET}`);
    assert.equal(res.status, 502);
    const body: any = await res.json();
    assert.match(body.error.message, /could not be read/);
    assert.doesNotMatch(JSON.stringify(body), /rpc\.mainnet|503/);
  });

  it("describes a transaction: status, value, fee, parties and token transfers", async () => {
    setup({ ROBINHOOD_EXPLORER_API_URL: BS });
    const app = createApp(createContainer(testEnv({ ONCHAIN_ENABLED: "true", ONCHAIN_RPC_RETRIES: "0", ROBINHOOD_EXPLORER_API_URL: BS, ROBINHOOD_EXPLORER_URL: "https://explorer.example" })));
    const r = await app.request(`/api/tx/${TX}`);
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.equal(body.status, "success");
    assert.equal(body.block, 100);
    assert.equal(body.time, "2026-10-14T21:47:38Z");
    assert.deepEqual(body.value, { value: "0.01", symbol: "ETH" });
    assert.deepEqual(body.fee, { value: "0.00006", symbol: "ETH" });
    assert.equal(body.from, WALLET);
    assert.equal(body.to, OTHER);
    assert.equal(body.toLabel, "PonsRouter");
    assert.equal(body.method, "buy");
    assert.equal(body.transfers[0].amount, "1,692,561.4308");
    assert.equal(body.transfers[0].token.symbol, "TILIK");
    assert.equal(body.url, `https://explorer.example/tx/${TX}`);
  });

  it("answers 404 for an unknown transaction and 400 for a malformed hash", async () => {
    setup({ ROBINHOOD_EXPLORER_API_URL: "none" });
    const app = createApp(createContainer(testEnv({ ONCHAIN_ENABLED: "true", ONCHAIN_RPC_RETRIES: "0", ROBINHOOD_EXPLORER_API_URL: "none" })));
    assert.equal((await app.request(`/api/tx/0x${"12".repeat(32)}`)).status, 404);
    assert.equal((await app.request("/api/tx/0x1234")).status, 400);
  });

  it("is off when on-chain data is disabled", async () => {
    const get = setup({ ONCHAIN_ENABLED: "false" });
    assert.equal((await get(WALLET)).status, 503);
  });
});
