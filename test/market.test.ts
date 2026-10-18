import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { createContainer } from "../src/container.js";
import { silentLogger } from "../src/core/logger.js";
import { toChecksumAddress } from "../src/providers/blockchain/evm.js";
import type { LLMProvider } from "../src/providers/llm/types.js";
import { ProviderRegistry } from "../src/providers/llm/registry.js";
import { planMarketQuery, Validator } from "../src/providers/market/analysis.js";
import { GeckoTerminalClient } from "../src/providers/market/geckoterminal.js";
import { classifyIntent } from "../src/router/intent.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { ChatRequestSchema } from "../src/types/api.js";
import { FakeProvider, hang, jsonResponse, mockFetch, testEnv } from "./helpers.js";

const GT = "https://api.geckoterminal.com/api/v2";
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const EXPLORER = "https://robinhoodchain.blockscout.com";
const TOKEN = toChecksumAddress(`0x${"5f".repeat(20)}`);
const WETH = toChecksumAddress(`0x${"0b".repeat(20)}`);
const POOL = toChecksumAddress(`0x${"52".repeat(20)}`);
const POOL2 = toChecksumAddress(`0x${"53".repeat(20)}`);
const UNKNOWN = toChecksumAddress(`0x${"99".repeat(20)}`);
const TX = `0x${"7a".repeat(32)}`;
const NOW_S = Math.floor(Date.now() / 1000);
const iso = (secondsAgo: number) => new Date((NOW_S - secondsAgo) * 1000).toISOString();

const poolResource = (addr: string, over: Record<string, unknown> = {}) => ({
  id: `robinhood_${addr.toLowerCase()}`,
  type: "pool",
  attributes: {
    address: addr.toLowerCase(),
    name: addr === POOL ? "USDX / WETH 0.01%" : "USDX / USDC",
    pool_created_at: "2026-07-02T20:51:08Z",
    base_token_price_usd: "0.9997",
    quote_token_price_usd: "2713.64",
    base_token_price_quote_token: "0.000368",
    reserve_in_usd: addr === POOL ? "24398965.9" : "150000.5",
    fdv_usd: null,
    market_cap_usd: null,
    volume_usd: { m5: "3664104.2", h1: "17199844.5", h6: "41319208.8", h24: "227579347.9" },
    price_change_percentage: { m5: "-0.047", h1: "0.046", h6: "-0.003", h24: "-0.022" },
    transactions: { h1: { buys: 3513, sells: 3944, buyers: 1137, sellers: 1111 }, h24: { buys: 83947, sells: 88398, buyers: 13315, sellers: 13180 } },
    ...over,
  },
  relationships: {
    base_token: { data: { id: `robinhood_${TOKEN.toLowerCase()}`, type: "token" } },
    quote_token: { data: { id: `robinhood_${WETH.toLowerCase()}`, type: "token" } },
    dex: { data: { id: "uniswap-v3-robinhood", type: "dex" } },
  },
});

const tokenResource = (over: Record<string, unknown> = {}) => ({
  id: `robinhood_${TOKEN.toLowerCase()}`,
  type: "token",
  attributes: {
    address: TOKEN.toLowerCase(),
    name: "Example Dollar",
    symbol: "USDX",
    decimals: 6,
    price_usd: "0.9997070428",
    fdv_usd: "1580000000.5",
    market_cap_usd: null,
    total_reserve_in_usd: "31000000.25",
    volume_usd: { h24: "250000000.1" },
    ...over,
  },
  relationships: { top_pools: { data: [{ id: `robinhood_${POOL.toLowerCase()}`, type: "pool" }] } },
});

interface GtFixture {
  networks?: string[];
  token?: Record<string, unknown> | null;
  override?: (path: string, init: RequestInit) => Response | Promise<Response> | undefined;
}

function gtHandler(fx: GtFixture = {}) {
  return (path: string, init: RequestInit): Response | Promise<Response> => {
    const o = fx.override?.(path, init);
    if (o) return o;
    const p = path.replace(/\?.*$/, "").toLowerCase();
    const notFound = () => jsonResponse({ errors: [{ status: "404", title: "Not Found" }] }, 404);
    if (p === "/networks") {
      const page = Number(new URLSearchParams(path.split("?")[1]).get("page") ?? 1);
      const ids = page === 1 ? (fx.networks ?? ["eth", "base", "robinhood"]) : [];
      return jsonResponse({ data: ids.map((id) => ({ id, type: "network", attributes: { name: id } })) });
    }
    if (!(fx.networks ?? ["robinhood"]).includes("robinhood") && p.startsWith("/networks/robinhood")) return notFound();
    if (p === `/networks/robinhood/tokens/${TOKEN.toLowerCase()}`) {
      if (fx.token === null) return notFound();
      return jsonResponse({ data: tokenResource(fx.token ?? {}), included: [poolResource(POOL), poolResource(POOL2)] });
    }
    if (p === `/networks/robinhood/pools/${POOL.toLowerCase()}`) return jsonResponse({ data: poolResource(POOL) });
    if (p === `/networks/robinhood/pools/${POOL.toLowerCase()}/ohlcv/day` || p === `/networks/robinhood/pools/${POOL.toLowerCase()}/ohlcv/hour`) {
      const step = p.endsWith("hour") ? 3600 : 86400;
      return jsonResponse({
        data: { attributes: { ohlcv_list: [0, 1, 2].map((i) => [NOW_S - i * step, 1.0 - i * 0.01, 1.02, 0.97, 1.001 - i * 0.01, 1_000_000 + i]) } },
        meta: { base: { symbol: "USDX" }, quote: { symbol: "WETH" } },
      });
    }
    if (p === `/networks/robinhood/pools/${POOL.toLowerCase()}/trades`) {
      return jsonResponse({
        data: [
          { id: "t1", type: "trade", attributes: { block_number: 1, block_timestamp: iso(30), tx_hash: TX, tx_from_address: TOKEN.toLowerCase(), kind: "buy", volume_in_usd: "125000.5" } },
          { id: "t2", type: "trade", attributes: { block_number: 2, block_timestamp: iso(20), tx_hash: `0x${"7b".repeat(32)}`, tx_from_address: WETH.toLowerCase(), kind: "sell", volume_in_usd: "300.25" } },
          { id: "t3", type: "trade", attributes: { block_number: 3, block_timestamp: "garbage", tx_hash: "0xnothex", kind: "buy", volume_in_usd: "1" } },
        ],
      });
    }
    if (p === "/networks/robinhood/pools") return jsonResponse({ data: [poolResource(POOL), poolResource(POOL2)] });
    if (p === "/search/pools") {
      const other = toChecksumAddress(`0x${"ee".repeat(20)}`);
      return jsonResponse({
        data: [poolResource(POOL), { ...poolResource(POOL2), relationships: { ...poolResource(POOL2).relationships, base_token: { data: { id: `robinhood_${other.toLowerCase()}` } } } }],
        included: [
          { id: `robinhood_${TOKEN.toLowerCase()}`, type: "token", attributes: { address: TOKEN.toLowerCase(), symbol: "USDX", name: "Example Dollar" } },
          { id: `robinhood_${other.toLowerCase()}`, type: "token", attributes: { address: other.toLowerCase(), symbol: "USDX", name: "Totally Real USDX" } },
        ],
      });
    }
    return notFound();
  };
}

// Minimal Robinhood RPC for the combined workflow.
function rpcHandler(body: any) {
  const ok = (result: unknown) => jsonResponse({ jsonrpc: "2.0", id: body.id, result });
  const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
  const str = (s: string) => `0x${word(32)}${word(s.length)}${Buffer.from(s).toString("hex").padEnd(64, "0")}`;
  switch (body.method) {
    case "eth_chainId":
      return ok("0x1237");
    case "eth_blockNumber":
      return ok("0x100");
    case "eth_getBalance":
      return ok("0x0");
    case "eth_getTransactionCount":
      return ok("0x1");
    case "eth_getCode":
      return ok("0x6080");
    case "eth_call": {
      const sel = body.params[0].data.slice(0, 10);
      return ok(sel === "0x95d89b41" ? str("USDX") : sel === "0x06fdde03" ? str("Example Dollar") : sel === "0x313ce567" ? `0x${word(6)}` : `0x${word(1_000_000_000_000n)}`);
    }
    default:
      return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "not supported" } });
  }
}

let net: ReturnType<typeof mockFetch> | undefined;
afterEach(() => net?.restore());

function serve(fx: GtFixture = {}, other?: (url: string, body: any, init: RequestInit) => Response | Promise<Response>) {
  const gt = gtHandler(fx);
  return mockFetch((url, body, init) => {
    if (url.startsWith(GT)) return gt(url.slice(GT.length), init);
    if (url === RPC) return rpcHandler(body);
    if (other) return other(url, body, init);
    return jsonResponse({}, 500);
  });
}

function setup(env: Record<string, string> = {}, llm: LLMProvider = new FakeProvider("groq")) {
  const e = testEnv({ MARKET_ENABLED: "true", GECKOTERMINAL_RETRIES: "0", ...env });
  const container = createContainer(e, { logger: silentLogger, providers: new ProviderRegistry().register(llm), tools: createToolRegistry(e) });
  const ask = (message: string, extra: Record<string, unknown> = {}) =>
    container.engine.ask(ChatRequestSchema.parse({ message, ...extra }), new AbortController().signal);
  return { container, ask };
}

const gtCalls = (fragment = "") => net!.calls.filter((c) => c.url.startsWith(GT) && c.url.includes(fragment));
const promptOf = (llm: FakeProvider) => llm.calls[0]!.messages.at(-1)!.content;
const systemOf = (llm: FakeProvider) => llm.calls[0]!.messages[0]!.content;
const mData = (res: { data: Record<string, { data: unknown }[]> }) => res.data["market.data"]?.[0]?.data as Record<string, any>;

describe("market intent detection", () => {
  const market = [
    `What is the price of this token? ${TOKEN}`,
    "Show me the liquidity.",
    "What is the volume?",
    "Which pools are most active?",
    `Analyze this token on Robinhood Chain ${TOKEN}`,
    "What happened to this token today?",
  ];
  for (const q of market) it(`"${q.slice(0, 40)}" → market`, () => assert.ok(classifyIntent(q).intents.includes("market"), classifyIntent(q).signals.join("; ")));

  it("token analysis on Robinhood Chain → on-chain + market", () => {
    const r = classifyIntent(`Analyze this token on Robinhood Chain ${TOKEN}`);
    assert.ok(r.intents.includes("onchain") && r.intents.includes("market"));
  });

  it("plans address / symbol / overview queries; symbols are never assumed unique", () => {
    const plan = (q: string) => planMarketQuery(q, classifyIntent(q).entities, 3);
    assert.equal(plan(`price of ${TOKEN}`).kind, "address");
    assert.equal(plan("What is the price of USDX?").symbol, "USDX");
    assert.equal(plan("price of $USDX").symbol, "USDX");
    assert.equal(plan("Which pools are most active?").kind, "overview");
    assert.equal(plan(`chart for ${TOKEN} today`).timeframe, "hour");
    assert.ok(plan(`recent trades of ${TOKEN}`).wants.trades);
  });
});

describe("validation", () => {
  it("rejects malformed numbers, timestamps and addresses", () => {
    const v = new Validator();
    assert.equal(v.usd("1.5"), 1.5);
    assert.equal(v.usd("NaN"), undefined);
    assert.equal(v.usd("-3"), undefined);
    assert.equal(v.usd("1e20"), undefined);
    assert.equal(v.usd(null), undefined);
    assert.equal(v.pct("-150"), undefined);
    assert.equal(v.time("not a date"), undefined);
    assert.equal(v.time(NOW_S + 7200), undefined, "future timestamps rejected");
    assert.equal(v.address("robinhood_0x123"), undefined);
    assert.equal(v.address(`robinhood_${TOKEN.toLowerCase()}`), TOKEN);
    assert.equal(v.dropped, 7);
    // Uniswap v4 pools are identified by a 32-byte pool id, not a contract address.
    const v4 = `0x${"f4".repeat(32)}`;
    assert.equal(v.poolId(`robinhood_${v4}`), v4);
    assert.equal(v.poolId(`robinhood_${POOL.toLowerCase()}`), POOL);
    assert.equal(v.address(v4), undefined, "token addresses stay strictly 20 bytes");
  });
});

describe("GeckoTerminal lookups", () => {
  it("token lookup: price, liquidity, volume, pools — one API call, versioned Accept header", async () => {
    net = serve();
    const llm = new FakeProvider("groq");
    const { ask } = setup({}, llm);
    const res = await ask(`What is the price of this token? ${TOKEN}`);
    assert.equal(gtCalls().length, 1, "token + top pools in one call (include=top_pools)");
    assert.equal(gtCalls()[0]!.headers.accept, "application/json;version=20230302");
    assert.match(gtCalls()[0]!.url, /\/networks\/robinhood\/tokens\/0x5f5f.*\?include=top_pools$/);

    const prompt = promptOf(llm);
    assert.match(prompt, /Price: \$0\.9997 \(GeckoTerminal's DEX-derived price/);
    assert.match(prompt, /Liquidity across its pools: \$31,000,000 · 24h volume: \$250,000,000/);
    assert.match(prompt, /Market cap: not reported · FDV: \$1,580,000,001/);
    assert.match(prompt, /USDX \/ WETH 0\.01% \(uniswap-v3-robinhood\) pool .*: liquidity \$24,398,966, volume 1h \$17,199,845 \/ 24h \$227,579,348, price change 1h \+0\.05% \/ 24h -0\.02%, 24h trades 83947 buys \/ 88398 sells/);
    assert.match(prompt, /data fetched .*\(\d+s ago\)/);
    const src = res.sources[0]!;
    assert.equal(src.type, "market");
    assert.equal(src.evidence, "live_data");
    assert.ok(src.url?.startsWith(`${GT}/networks/robinhood/tokens/`), "traceable API reference");
    assert.equal(res.type, "market");
    assert.equal(mData(res).status, "ok");
  });

  it("pool lookup: an address that is a pool, not a token", async () => {
    net = serve();
    const llm = new FakeProvider("groq");
    const { ask } = setup({}, llm);
    await ask(`Show me the liquidity of pool ${POOL}`);
    const prompt = promptOf(llm);
    assert.match(prompt, /DEX pool USDX \/ WETH 0\.01% \(uniswap-v3-robinhood\)/);
    assert.match(prompt, /Volume: m5 \$3,664,104 · h1 \$17,199,845 · h6 \$41,319,209 · h24 \$227,579,348/);
    assert.match(prompt, /Trades: m5 n\/a · h1 3513 buys \/ 3944 sells/);
  });

  it("OHLCV: daily for 'this week', hourly for 'today'", async () => {
    net = serve();
    const llm = new FakeProvider("groq");
    const { ask } = setup({ MARKET_OHLCV_DAYS: "7" }, llm);
    await ask(`Show me the price chart for ${TOKEN} this week`);
    assert.match(gtCalls("/ohlcv/")[0]!.url, /\/ohlcv\/day\?limit=7&currency=usd$/);
    assert.match(promptOf(llm), /OHLCV \(USD, 1-day candles, UTC\)/);
    assert.match(promptOf(llm), /Over these 3 candles: open \$0\.98 → latest close \$1 \(\+2\.14%\)/);

    net.restore();
    net = serve();
    const { ask: ask2 } = setup();
    await ask2(`What happened to this token today? ${TOKEN}`);
    assert.match(gtCalls("/ohlcv/")[0]!.url, /\/ohlcv\/hour\?limit=24/);
  });

  it("recent trades link to on-chain transactions; malformed trades are dropped", async () => {
    net = serve();
    const llm = new FakeProvider("groq", { reply: `A large buy happened [1] (${EXPLORER}/tx/${TX}).` });
    const { ask } = setup({}, llm);
    const res = await ask(`Show recent trades for token ${TOKEN}`);
    const prompt = promptOf(llm);
    assert.match(prompt, /Buys: 1 · Sells: 1 · Largest in sample: \$125,001 \(buy, tx 0x7a7a/);
    assert.ok(prompt.includes(`${EXPLORER}/tx/${TX}`));
    assert.ok(res.answer.includes(`${EXPLORER}/tx/${TX}`), "explorer link for a real trade is citable");
    assert.ok(mData(res).droppedFields >= 1);
    assert.ok(res.warnings.some((w) => /malformed market value\(s\) from GeckoTerminal were discarded/.test(w)));
  });

  it("symbol lookup: ambiguous symbols are listed by contract address, never silently picked", async () => {
    net = serve();
    const llm = new FakeProvider("groq");
    const { ask } = setup({}, llm);
    await ask("What is the price of USDX?");
    assert.match(gtCalls("/search/pools")[0]!.url, /query=USDX&network=robinhood/);
    const prompt = promptOf(llm);
    assert.match(prompt, /⚠ 2 different tokens use the symbol USDX/);
    assert.ok(prompt.includes(TOKEN) && prompt.includes("Totally Real USDX"));
    assert.match(systemOf(llm), /A symbol does not identify a token/);
  });

  it("most active pools overview", async () => {
    net = serve();
    const llm = new FakeProvider("groq");
    const { ask } = setup({}, llm);
    await ask("Which pools are most active?");
    assert.match(promptOf(llm), /1\. USDX \/ WETH 0\.01% \(uniswap-v3-robinhood\) pool .*24h volume \$227,579,348/);
  });
});

describe("unavailable states", () => {
  it("invalid address: reported, not queried", async () => {
    net = serve();
    const llm = new FakeProvider("groq");
    const { ask } = setup({}, llm);
    // Flip the case of the first letter: same hex, broken EIP-55 checksum.
    const i = TOKEN.slice(2).search(/[a-fA-F]/) + 2;
    const ch = TOKEN[i]!;
    const bad = `${TOKEN.slice(0, i)}${ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()}${TOKEN.slice(i + 1)}`;
    await ask(`What is the price of ${bad}?`);
    assert.equal(gtCalls("/tokens/").length, 0);
    assert.match(promptOf(llm), /invalid EIP-55 checksum/);
  });

  it("unsupported token: no token, no pool → clear 'market data unavailable'", async () => {
    net = serve();
    const llm = new FakeProvider("groq");
    const { ask } = setup({}, llm);
    const res = await ask(`What is the price of this token? ${UNKNOWN}`);
    assert.match(promptOf(llm), /GeckoTerminal has no token or pool at .* on network "robinhood".*do not estimate it/);
    assert.equal(mData(res).status, "unavailable");
    assert.ok(res.warnings.some((w) => /Market data unavailable from GeckoTerminal/.test(w)));
  });

  it("unsupported network → explicit unsupported-network state", async () => {
    net = serve({ networks: ["eth", "base"] });
    const llm = new FakeProvider("groq");
    const { ask } = setup({}, llm);
    const res = await ask(`What is the price of this token? ${TOKEN}`);
    assert.match(promptOf(llm), /GeckoTerminal does not support the network "robinhood"/);
    assert.equal(mData(res).status, "unavailable");
  });
});

describe("failures, freshness and cost control", () => {
  it("API failure → market data reported unavailable (no guesses), chain data still answers", async () => {
    net = serve({ override: () => new Response("boom", { status: 500 }) });
    const llm = new FakeProvider("groq");
    const { ask } = setup({ ONCHAIN_ENABLED: "true", ONCHAIN_RPC_RETRIES: "0", ROBINHOOD_EXPLORER_API_URL: "none" }, llm);
    const res = await ask(`Analyze this token on Robinhood Chain ${TOKEN}`);
    assert.equal(res.toolRuns.find((r) => r.tool === "geckoterminal")?.error?.kind, "upstream");
    assert.equal(res.toolRuns.find((r) => r.tool === "robinhood-chain")?.status, "ok");
    assert.match(systemOf(llm), /LIVE DATA UNAVAILABLE[\s\S]*market\.data: all tools failed: geckoterminal \(upstream\)/);
    assert.ok(res.sources.some((s) => s.type === "onchain"));
    assert.ok(!res.sources.some((s) => s.type === "market"));
    assert.equal(res.grounded, true);
  });

  it("timeout", async () => {
    net = serve({ override: (_p, init) => hang(init) });
    const { ask } = setup({ GECKOTERMINAL_TIMEOUT_MS: "50" });
    const res = await ask(`What is the price of this token? ${TOKEN}`);
    assert.equal(res.toolRuns[0]?.error?.kind, "timeout");
  });

  it("rate limit: one bounded retry on 429, then the local limiter protects the public quota", async () => {
    let first = true;
    net = serve({
      override: (p) => {
        if (first && p.includes("/tokens/")) {
          first = false;
          return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
        }
        return undefined;
      },
    });
    const { ask } = setup({ GECKOTERMINAL_RETRIES: "1" });
    const res = await ask(`What is the price of this token? ${TOKEN}`);
    assert.equal(res.toolRuns[0]?.status, "ok");
    assert.equal(gtCalls("/tokens/").length, 2);

    net.restore();
    net = serve();
    const { ask: ask2 } = setup({ GECKOTERMINAL_RATE_LIMIT_PER_MINUTE: "1" });
    await ask2(`What is the price of this token? ${TOKEN}`);
    const second = await ask2("Which pools are most active?");
    assert.equal(second.toolRuns[0]?.error?.kind, "rate_limit");
    assert.equal(gtCalls().length, 1, "the second request never reached GeckoTerminal");
  });

  it("stale cache: during an outage, last-known data is shown — labelled STALE, never as current", async () => {
    let down = false;
    net = serve({ override: () => (down ? new Response("down", { status: 503 }) : undefined) });
    const llm = new FakeProvider("groq");
    const { ask } = setup({ MARKET_CACHE_TTL: "0", MARKET_STALE_MAX_SECONDS: "900" }, llm);
    await ask(`What is the price of this token? ${TOKEN}`);
    down = true;
    const res = await ask(`Price of token ${TOKEN} right now?`);
    assert.equal(mData(res).status, "stale");
    assert.match(llm.calls.at(-1)!.messages.at(-1)!.content, /⚠ STALE DATA: last-known values from .* because GeckoTerminal is currently unavailable \(upstream\); not current/);
    assert.ok(res.warnings.some((w) => /marked STALE/.test(w)));
    assert.match(systemOf(llm), /Values marked STALE must be called stale and dated/);
  });

  it("stale data disabled → error instead of old prices", async () => {
    let down = false;
    net = serve({ override: () => (down ? new Response("down", { status: 503 }) : undefined) });
    const { ask } = setup({ MARKET_CACHE_TTL: "0", MARKET_STALE_MAX_SECONDS: "0" });
    await ask(`What is the price of this token? ${TOKEN}`);
    down = true;
    const res = await ask(`Price of token ${TOKEN} right now?`);
    assert.equal(res.toolRuns[0]?.error?.kind, "upstream");
  });

  it("caching and de-duplication: the same market data is not requested twice", async () => {
    net = serve();
    const { ask } = setup({ MARKET_CACHE_TTL: "30" });
    await ask(`What is the price of this token? ${TOKEN}`);
    await ask(`How much is token ${TOKEN} worth?`); // different wording → answer-cache miss, API cache hit
    assert.equal(gtCalls("/tokens/").length, 1);

    const client = new GeckoTerminalClient({ baseUrl: GT, timeoutMs: 1000, retries: 0, ratePerMinute: 100, ttlSeconds: { live: 30, pools: 60, meta: 3600 }, staleMaxSeconds: 0 });
    const budget = { signal: new AbortController().signal, calls: 0, maxCalls: 10 };
    const before = gtCalls("/networks/robinhood/pools").length;
    await Promise.all([client.get("/networks/robinhood/pools", "pools", budget), client.get("/networks/robinhood/pools", "pools", budget)]);
    assert.equal(gtCalls("/networks/robinhood/pools").length - before, 1, "concurrent identical requests share one call");
  });

  it("malformed market response never becomes a confident statement", async () => {
    net = serve({ token: { price_usd: "NaN", total_reserve_in_usd: "-5", volume_usd: { h24: "lots" }, fdv_usd: "1e30" } });
    const llm = new FakeProvider("groq");
    const { ask } = setup({}, llm);
    const res = await ask(`What is the price of this token? ${TOKEN}`);
    const prompt = promptOf(llm);
    assert.match(prompt, /Price: not reported/);
    assert.match(prompt, /Liquidity across its pools: not reported · 24h volume: not reported/);
    assert.ok(mData(res).droppedFields >= 4);

    net.restore();
    net = serve({ override: (p) => (p.includes("/tokens/") ? jsonResponse({ data: { id: "x", attributes: { address: "not-an-address" } } }) : undefined) });
    const { ask: ask2 } = setup();
    const res2 = await ask2(`What is the price of this token? ${TOKEN}`);
    assert.equal(res2.toolRuns[0]?.error?.kind, "invalid_output");
  });
});

describe("market + on-chain combined analysis", () => {
  it("Analyze this token on Robinhood Chain → chain facts + market data, kept apart", async () => {
    net = serve();
    const llm = new FakeProvider("groq");
    const { ask } = setup({ ONCHAIN_ENABLED: "true", ONCHAIN_RPC_RETRIES: "0", ROBINHOOD_EXPLORER_API_URL: "none" }, llm);
    const res = await ask(`Analyze this token on Robinhood Chain ${TOKEN}`);
    const caps = res.plan.tools.map((t) => t.capability).sort();
    assert.deepEqual(caps, ["chain.data", "market.data", "token.check"]);
    assert.ok(!res.plan.tools.some((t) => t.capability === "web.search"));
    const prompt = promptOf(llm);
    assert.match(prompt, /Type: token contract/, "on-chain facts");
    assert.match(prompt, /Name: Example Dollar · Symbol: USDX · Decimals: 6/);
    assert.match(prompt, /Price: \$0\.9997/, "market data");
    assert.ok(res.sources.some((s) => s.type === "onchain") && res.sources.some((s) => s.type === "market"));
    assert.match(systemOf(llm), /'On-chain facts'.*'Market data'.*'From the web'.*'Analysis'/);
    assert.match(systemOf(llm), /do not infer a price from on-chain transfers/);
    assert.equal(res.type, "combined", "on-chain + market data → combined response");
    assert.ok(res.plan.unifiedIntents.includes("ONCHAIN_MARKET"));
  });

  it("What's happening on Robinhood Chain today? now includes market activity", async () => {
    net = serve();
    const { ask } = setup({ ONCHAIN_ENABLED: "true", ONCHAIN_RPC_RETRIES: "0", ROBINHOOD_EXPLORER_API_URL: "none" });
    const res = await ask("What's happening on Robinhood Chain today?");
    assert.ok(!res.plan.unavailable.some((u) => u.capability === "market.data"), "market data is no longer missing");
    assert.ok(res.sources.some((s) => /most active DEX pools/.test(s.title)));
  });

  it("follow-up 'What is the price of this token?' reuses the token from the conversation", async () => {
    net = serve();
    const { ask } = setup();
    const res = await ask("What is the price of this token?", { history: [{ role: "user", content: `Tell me about ${TOKEN}` }] });
    assert.equal(mData(res).kind, "address");
    assert.equal(gtCalls("/tokens/").length, 1);
  });

  it("no keys or secrets in market responses", async () => {
    net = serve();
    const { container } = setup({ GROQ_API_KEY: "gsk_marketsecret123456789" });
    const text = await (await createApp(container).request("/chat", { method: "POST", body: JSON.stringify({ message: `price of token ${TOKEN}` }) })).text();
    assert.ok(!text.includes("gsk_marketsecret123456789"));
  });
});
