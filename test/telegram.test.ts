import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { checkMessage, createTelegramBot, telegramRoutes, type TgUpdate } from "../src/api/telegram.js";
import { TILIK_TOKEN } from "../src/api/token-check-tool.js";
import type { TokenIntel, Trades } from "../src/api/token.js";
import { MemoryKv } from "../src/providers/kv/upstash.js";
import { testEnv } from "./helpers.js";

const TOKEN = `0x${"c3".repeat(20)}`;
const env = testEnv({ TELEGRAM_BOT_TOKEN: "123:abc-token-test", TELEGRAM_WEBHOOK_SECRET: "hook-secret-1", CRON_SECRET: "cron-secret-1" });
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as any;
const intelOf = (price = 1, extra: Partial<TokenIntel> = {}): TokenIntel => ({
  address: TOKEN,
  chain: { name: "Robinhood Chain", chainId: 4663 },
  token: { name: "Tilik", symbol: "TILIK", holders: 149 },
  market: { priceUsd: price, liquidityUsd: 32600, volume24hUsd: 4000 },
  pools: [{ name: "TILIK / WETH", dex: "pons", address: "0x1", main: true, change24hPct: -3.2, url: "" }],
  checks: [{ id: "lp-lock", level: "ok", title: "Liquidity locked forever", detail: "" }],
  liquidityLock: { locked: true, locker: "0x1", lockerName: "PonsV2LaunchLocker", positionId: "3820500", held: true, hasLiquidity: true, mainPool: true, permanent: true, note: "" },
  dev: { address: "0x648eCc353e78cA4c0ccb9086685846C31378038d", holdsPct: 0, received: 4, burned: 4, sentOut: 0 },
  snipers: { windowSec: 60, buyers: 25, boughtPct: 21.16, stillHoldPct: 1.42, checked: 15, soldAll: 14, top: [] },
  sources: [],
  generatedAt: "",
  ...extra,
});
const tradesOf = (list: { time: string; whale?: boolean; usd?: number }[]): Trades => ({
  pool: { name: "", address: "", dex: "", url: "" },
  trades: list.map((x) => ({ kind: "buy", usd: x.usd ?? 50, amount: 1, wallet: `0x${"ab".repeat(20)}`, time: x.time, tx: "0x", ...(x.whale ? { whale: true } : {}) })),
  summary: { buys: 0, sells: 0, buyUsd: 0, sellUsd: 0, wallets: 0, buyers: 0, sellers: 0, whaleUsd: 600 },
  generatedAt: "",
});

function setup(state: { intel: TokenIntel; trades: Trades; admins?: number[] }) {
  let now = Date.parse("2026-10-18T00:00:00Z");
  const sent: { chat: number; text: string }[] = [];
  const api = async (method: string, body: any) => {
    if (method === "getMe") return { username: "asktilik_bot" };
    if (method === "getChatMember") return { status: (state.admins ?? []).includes(body.user_id) ? "administrator" : "member" };
    if (method === "sendMessage") sent.push({ chat: body.chat_id, text: body.text });
    return {};
  };
  const kv = new MemoryKv(() => now);
  const bot = createTelegramBot(env, quiet, { intel: { get: async () => state.intel, trades: async () => state.trades }, kv, api, now: () => now });
  let id = 0;
  const say = (text: string, chat: { id: number; type: "private" | "supergroup" } = { id: -100, type: "supergroup" }, from = 7) =>
    bot.handle({ update_id: ++id, message: { message_id: id, chat, from: { id: from }, text } } as TgUpdate);
  return { bot, sent, say, kv, tick: (ms: number) => (now += ms) };
}

describe("telegram bot", () => {
  it("/check answers with the website's facts; commands for other bots are ignored", async () => {
    const { sent, say } = setup({ intel: intelOf(), trades: tradesOf([]) });
    await say(`/check@asktilik_bot ${TOKEN}`);
    await say(`/check@someotherbot ${TOKEN}`);
    await say(TOKEN, { id: 5, type: "private" }); // a pasted address in a private chat is a check
    await say(TOKEN); // ...but not in a group
    assert.equal(sent.length, 2);
    const t = sent[0]!.text;
    for (const re of [/LOCKED FOREVER/, /Dev <code>0x648e…038d<\/code> · holds 0% · bought 4× · burned 4× · sold 0×/, /25 wallets bought 21.16% · still hold 1.42%/, /149 holders/, /asktilik\.com\/token\//]) assert.match(t, re);
  });

  it("only group admins change the watchlist; /watchlist and /unwatch work", async () => {
    const { sent, say } = setup({ intel: intelOf(), trades: tradesOf([]), admins: [1] });
    await say(`/watch ${TOKEN}`, undefined, 7);
    assert.match(sent.at(-1)!.text, /Only group admins/);
    await say(`/watch ${TOKEN}`, undefined, 1);
    assert.match(sent.at(-1)!.text, /Watching <b>\$TILIK<\/b>/);
    await say("/watchlist");
    assert.match(sent.at(-1)!.text, /0xC3C3/i);
    await say(`/unwatch ${TOKEN}`, undefined, 1);
    assert.match(sent.at(-1)!.text, /Stopped watching/);
  });

  it("alerts once on a big price move, a new whale trade and a new red flag", async () => {
    const state = { intel: intelOf(1), trades: tradesOf([{ time: "2026-10-18T00:00:00Z" }]), admins: [1] };
    const { bot, sent, say, tick } = setup(state);
    await say(`/watch ${TOKEN}`, undefined, 1);
    sent.length = 0;
    assert.deepEqual(await bot.alerts(), { tokens: 1, sent: 0 }); // first look: snapshot only
    tick(10 * 60_000);
    state.intel = intelOf(1.3, { checks: [{ id: "dev-holds", level: "warn", title: "Dev wallet holds 25% of supply", detail: "" }] });
    state.trades = tradesOf([{ time: "2026-10-18T00:00:00Z" }, { time: "2026-10-18T00:09:00Z", whale: true, usd: 1200 }]);
    assert.deepEqual(await bot.alerts(), { tokens: 1, sent: 1 });
    const a = sent[0]!.text;
    assert.match(a, /📈 Price \+30\.0% in 10 min/);
    assert.match(a, /🐋 Whale BUY \$1\.2K/);
    assert.match(a, /New flag: Dev wallet holds 25% of supply/);
    tick(5 * 60_000);
    assert.deepEqual(await bot.alerts(), { tokens: 1, sent: 0 }, "nothing new: no repeat");
  });

  it("daily report goes to chats that turned it on", async () => {
    const { bot, sent, say } = setup({ intel: intelOf(), trades: tradesOf([]), admins: [1] });
    await say("/daily on", undefined, 1);
    sent.length = 0;
    assert.deepEqual(await bot.daily(), { chats: 1, sent: 1 });
    assert.match(sent[0]!.text, /GM, TILIK fam/);
    assert.equal(TILIK_TOKEN.length, 42);
  });

  it("webhook and cron routes refuse callers without the secrets", async () => {
    const { bot } = setup({ intel: intelOf(), trades: tradesOf([]) });
    const app = new Hono().route("/", telegramRoutes(env, bot));
    const post = (h: Record<string, string>) => app.request("/api/telegram/webhook", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ update_id: 1 }) });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ "x-telegram-bot-api-secret-token": "wrong" })).status, 401);
    assert.equal((await post({ "x-telegram-bot-api-secret-token": "hook-secret-1" })).status, 200);
    assert.equal((await app.request("/api/cron/alerts")).status, 401);
    assert.equal((await app.request("/api/cron/alerts", { headers: { authorization: "Bearer cron-secret-1" } })).status, 200);
  });

  it("formats a token with no dev or lock facts without inventing them", () => {
    const m = checkMessage(intelOf(1, { dev: undefined, liquidityLock: undefined, snipers: undefined }));
    assert.doesNotMatch(m, /LOCKED|Dev |First minute/);
  });
});
