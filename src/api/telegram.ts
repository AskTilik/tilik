import { Hono } from "hono";
import type { Env } from "../config/env.js";
import { VeyraError } from "../core/errors.js";
import { httpRequest } from "../core/http.js";
import type { Logger } from "../core/logger.js";
import { toChecksumAddress } from "../providers/blockchain/evm.js";
import { UpstashKv, type Kv } from "../providers/kv/upstash.js";
import type { ClientRateLimiter } from "../security/rate-limit.js";
import type { HolderHistory } from "./holders.js";
import type { AppVariables } from "./http-guards.js";
import { TILIK_TOKEN } from "./token-check-tool.js";
import type { TokenIntel, Trades } from "./token.js";

/**
 * @asktilik_bot — TILIK's token check in Telegram.
 *
 * Commands: /check <token>, /tilik, /watch <token>, /unwatch <token>,
 * /watchlist, /daily on|off, /help. In groups only admins change the
 * watchlist or the daily report. Alerts (price move, whale trade, new red
 * flag) and the daily $TILIK report run from cron routes.
 */
const SITE = "https://asktilik.com";
const MAX_WATCH = 10;
const MAX_ALERT_TOKENS = 50;
const PRICE_MOVE = 0.2;
const BASE_RESET_MS = 6 * 3_600_000;
const CHECKS_PER_MINUTE = 8;
const ADDR = /0x[0-9a-fA-F]{40}/;

export interface TgMessage {
  message_id: number;
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string };
  from?: { id: number; is_bot?: boolean };
  text?: string;
  reply_to_message?: { text?: string };
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}
interface Snapshot {
  base?: number;
  baseAt?: number;
  flags: string[];
  lastTrade?: string;
}
type Api = (method: string, body: Record<string, unknown>) => Promise<unknown>;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (n: number | undefined) => {
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(3)}`;
};
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n)}`;
const pctS = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`;
const nameOf = (t: TokenIntel) => (t.token.symbol ? `$${esc(t.token.symbol)}` : short(t.address));

/** The /check reply: the same facts as asktilik.com/token/<address>, compact. */
export function checkMessage(t: TokenIntel, h?: HolderHistory): string {
  const m = t.market, main = t.pools.find((p) => p.main);
  const lines = [`<b>${nameOf(t)}</b>${t.token.name ? ` · ${esc(t.token.name)}` : ""}`, `<code>${t.address}</code>`, ""];
  if (m) lines.push(`💲 ${usd(m.priceUsd)}${main?.change24hPct !== undefined ? ` (${pctS(main.change24hPct)} 24h)` : ""} · 💧 Liq ${usd(m.liquidityUsd)} · 📊 Vol ${usd(m.volume24hUsd)}`);
  if (t.token.holders !== undefined) lines.push(`👥 ${t.token.holders} holders${h?.change24h !== undefined ? ` (${signed(h.change24h)} 24h)` : ""}`);
  const lk = t.liquidityLock;
  if (lk) lines.push(lk.held && lk.hasLiquidity ? `🔒 Liquidity <b>LOCKED FOREVER</b> · ${esc(lk.lockerName)}${lk.mainPool ? " · main pool" : ""}` : `⚠️ Locked position #${lk.positionId} is empty or moved`);
  const d = t.dev;
  if (d) lines.push(`👤 Dev <code>${short(d.address)}</code> · holds ${d.holdsPct ?? "?"}% · bought ${d.received}× · burned ${d.burned}× · sold ${d.sentOut}×`);
  const s = t.snipers;
  if (s) lines.push(s.buyers ? `⏱ First minute: ${s.buyers} wallets bought ${s.boughtPct}%${s.stillHoldPct !== undefined ? ` · still hold ${s.stillHoldPct}%` : ""}` : "⏱ No buys in the first minute");
  const flags = t.checks.filter((c) => c.level === "risk" || c.level === "warn").slice(0, 4);
  if (flags.length) lines.push("", ...flags.map((c) => `${c.level === "risk" ? "🔴" : "🟠"} ${esc(c.title)}`));
  lines.push("", `🔎 <a href="${SITE}/token/${t.address}">Full check on asktilik.com</a>`, "<i>Live on-chain data. Not financial advice.</i>");
  return lines.join("\n");
}

export const HELP = [
  "<b>TILIK bot</b> · token checks on Robinhood Chain",
  "",
  "/check <code>0x…</code> — liquidity lock, dev wallet, first-minute buyers, holders",
  "/tilik — check $TILIK",
  "/watch <code>0x…</code> — alerts for a token (big price move, whale trade, new red flag)",
  "/unwatch <code>0x…</code> · /watchlist",
  "/daily on|off — $TILIK report every morning",
  "",
  `In groups, only admins change the watchlist and the daily report. Full checks: ${SITE}`,
].join("\n");

export function createTelegramBot(
  env: Env,
  logger: Logger,
  deps: {
    intel: { get(address: string): Promise<TokenIntel>; trades(address: string): Promise<Trades> };
    holders?: { enabled: boolean; history(address: string): Promise<HolderHistory> };
    kv?: Kv | null;
    api?: Api;
    limiter?: ClientRateLimiter;
    now?: () => number;
  },
) {
  const now = deps.now ?? Date.now;
  const kv = deps.kv === null ? undefined : (deps.kv ?? (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN ? new UpstashKv(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN) : undefined));
  const api: Api =
    deps.api ??
    (async (method, body) => {
      const res = await httpRequest(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
        source: "telegram",
        method: "POST",
        body,
        timeoutMs: 15_000,
        mapError: (status) => new VeyraError(status === 429 ? "rate_limit" : status === 401 ? "auth" : "upstream", "telegram", `Telegram returned ${status}`, { status }),
      });
      return ((await res.json()) as { result?: unknown }).result;
    });
  let username: string | undefined;
  const me = async () => (username ??= ((await api("getMe", {})) as { username?: string })?.username?.toLowerCase());
  const send = (chatId: number, text: string, replyTo?: number) =>
    api("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) });

  const holdersOf = async (a: string) =>
    deps.holders?.enabled ? Promise.race([deps.holders.history(a).catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), 4000))]) : undefined;

  async function isAdmin(msg: TgMessage): Promise<boolean> {
    if (msg.chat.type === "private") return true;
    if (!msg.from) return false;
    const m = (await api("getChatMember", { chat_id: msg.chat.id, user_id: msg.from.id }).catch(() => null)) as { status?: string } | null;
    return m?.status === "creator" || m?.status === "administrator";
  }

  async function check(msg: TgMessage, address: string): Promise<void> {
    if (deps.limiter && !deps.limiter.take("telegram", `tg:${msg.chat.id}`, CHECKS_PER_MINUTE).ok) {
      await send(msg.chat.id, "Too many checks in this chat — try again in a minute.", msg.message_id);
      return;
    }
    let t: TokenIntel;
    try {
      t = await deps.intel.get(address);
    } catch (err) {
      const notToken = err instanceof Error && err.name === "NotAToken";
      await send(msg.chat.id, notToken ? "That address is not a token on Robinhood Chain." : "Token data could not be read right now. Try again in a moment.", msg.message_id);
      return;
    }
    await send(msg.chat.id, checkMessage(t, await holdersOf(address)), msg.message_id);
  }

  async function watch(msg: TgMessage, address: string, on: boolean): Promise<void> {
    if (!kv) return void (await send(msg.chat.id, "Watchlists are not set up on this server.", msg.message_id));
    if (!(await isAdmin(msg))) return void (await send(msg.chat.id, "Only group admins can change this chat's watchlist.", msg.message_id));
    const t = address.toLowerCase(), chat = String(msg.chat.id);
    if (on) {
      if ((await kv.cmd<number>("SISMEMBER", `tg:w:${chat}`, t)) === 1) return void (await send(msg.chat.id, `Already watching <code>${toChecksumAddress(t)}</code>.`, msg.message_id));
      if ((await kv.cmd<number>("SCARD", `tg:w:${chat}`)) >= MAX_WATCH) return void (await send(msg.chat.id, `This chat already watches ${MAX_WATCH} tokens. /unwatch one first.`, msg.message_id));
      const intel = await deps.intel.get(t).catch(() => null);
      if (!intel?.market) return void (await send(msg.chat.id, "No token with a market at that address.", msg.message_id));
      await kv.pipeline([["SADD", `tg:w:${chat}`, t], ["SADD", `tg:watchers:${t}`, chat], ["SADD", "tg:wtokens", t]]);
      await send(msg.chat.id, `👀 Watching <b>${nameOf(intel)}</b>. You'll get an alert on a ${PRICE_MOVE * 100}%+ price move, a whale trade or a new red flag.`, msg.message_id);
    } else {
      const removed = await kv.cmd<number>("SREM", `tg:w:${chat}`, t);
      await kv.cmd("SREM", `tg:watchers:${t}`, chat);
      if ((await kv.cmd<number>("SCARD", `tg:watchers:${t}`)) === 0) await kv.cmd("SREM", "tg:wtokens", t);
      await send(msg.chat.id, removed ? `Stopped watching <code>${toChecksumAddress(t)}</code>.` : "That token was not on this chat's watchlist.", msg.message_id);
    }
  }

  async function handle(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg?.text || msg.from?.is_bot) return;
    const text = msg.text.trim();
    const cmd = text.match(/^\/([a-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i);
    if (!cmd) {
      // In a private chat a pasted address is a check.
      const a = msg.chat.type === "private" ? text.match(ADDR)?.[0] : undefined;
      if (a) await check(msg, a);
      return;
    }
    if (cmd[2] && cmd[2].toLowerCase() !== (await me())) return; // addressed to another bot
    const arg = (cmd[3] ?? "").trim(), name = cmd[1]!.toLowerCase();
    const addr = arg.match(ADDR)?.[0] ?? msg.reply_to_message?.text?.match(ADDR)?.[0];
    switch (name) {
      case "start":
      case "help":
        return void (await send(msg.chat.id, HELP));
      case "tilik":
        return check(msg, TILIK_TOKEN);
      case "check":
        if (!addr) return void (await send(msg.chat.id, "Send a token address: /check <code>0x…</code>", msg.message_id));
        return check(msg, addr);
      case "watch":
      case "unwatch":
        if (!addr) return void (await send(msg.chat.id, `Send a token address: /${name} <code>0x…</code>`, msg.message_id));
        return watch(msg, addr, name === "watch");
      case "watchlist": {
        if (!kv) return;
        const list = (await kv.cmd<string[]>("SMEMBERS", `tg:w:${msg.chat.id}`)) ?? [];
        return void (await send(msg.chat.id, list.length ? ["👀 <b>Watching</b>", ...list.map((a) => `• <code>${toChecksumAddress(a)}</code>`)].join("\n") : "Nothing watched yet. /watch <code>0x…</code>", msg.message_id));
      }
      case "daily": {
        if (!kv) return;
        if (!(await isAdmin(msg))) return void (await send(msg.chat.id, "Only group admins can change the daily report.", msg.message_id));
        const on = !/^off$/i.test(arg);
        await kv.cmd(on ? "SADD" : "SREM", "tg:daily", String(msg.chat.id));
        return void (await send(msg.chat.id, on ? "☀️ Daily $TILIK report: on (every morning, 08:00 WIB)." : "Daily report: off.", msg.message_id));
      }
      default:
        return;
    }
  }

  /** Cron: compare each watched token with its last snapshot and alert the chats watching it. */
  async function alerts(): Promise<{ tokens: number; sent: number }> {
    if (!kv) return { tokens: 0, sent: 0 };
    const tokens = ((await kv.cmd<string[]>("SMEMBERS", "tg:wtokens")) ?? []).filter((t) => /^0x[0-9a-f]{40}$/.test(t)).slice(0, MAX_ALERT_TOKENS);
    let sent = 0;
    for (const token of tokens) {
      const t = await deps.intel.get(token).catch(() => null);
      if (!t?.market) continue;
      const raw = await kv.cmd<string | null>("GET", `tg:snap:${token}`);
      const prev: Snapshot | null = raw ? (JSON.parse(raw) as Snapshot) : null;
      const trades = await deps.intel.trades(token).catch(() => null);
      const newest = trades?.trades.map((x) => x.time).sort().at(-1);
      const flags = t.checks.filter((c) => c.level === "risk" || c.level === "warn");
      const price = t.market.priceUsd;
      const next: Snapshot = { flags: flags.map((c) => c.id), ...(newest ? { lastTrade: newest } : prev?.lastTrade ? { lastTrade: prev.lastTrade } : {}) };
      const lines: string[] = [];
      if (prev) {
        if (price !== undefined && prev.base && prev.baseAt && now() - prev.baseAt < BASE_RESET_MS) {
          const move = (price - prev.base) / prev.base;
          if (Math.abs(move) >= PRICE_MOVE) {
            lines.push(`${move > 0 ? "📈" : "📉"} Price ${pctS(move * 100)} in ${Math.max(1, Math.round((now() - prev.baseAt) / 60_000))} min · now ${usd(price)}`);
            Object.assign(next, { base: price, baseAt: now() });
          } else Object.assign(next, { base: prev.base, baseAt: prev.baseAt });
        } else if (price !== undefined) Object.assign(next, { base: price, baseAt: now() });
        for (const w of (trades?.trades ?? []).filter((x) => x.whale && (!prev.lastTrade || x.time > prev.lastTrade)).slice(0, 3))
          lines.push(`🐋 Whale ${w.kind === "buy" ? "BUY" : "SELL"} ${usd(w.usd)} · <code>${short(w.wallet)}</code>`);
        for (const c of flags.filter((c) => !prev.flags.includes(c.id))) lines.push(`${c.level === "risk" ? "🔴" : "🟠"} New flag: ${esc(c.title)}`);
      } else if (price !== undefined) Object.assign(next, { base: price, baseAt: now() });
      await kv.cmd("SET", `tg:snap:${token}`, JSON.stringify(next));
      if (!lines.length) continue;
      const text = [`🚨 <b>${nameOf(t)}</b> alert`, ...lines, "", `🔎 <a href="${SITE}/token/${t.address}">Full check</a>`].join("\n");
      for (const chat of (await kv.cmd<string[]>("SMEMBERS", `tg:watchers:${token}`)) ?? []) {
        await send(Number(chat), text).then(() => sent++).catch((err) => logger.warn("telegram alert failed", { error: err instanceof Error ? err.name : "error" }));
      }
    }
    return { tokens: tokens.length, sent };
  }

  /** Cron: the morning $TILIK report for every chat that turned it on. */
  async function daily(): Promise<{ chats: number; sent: number }> {
    if (!kv) return { chats: 0, sent: 0 };
    const chats = (await kv.cmd<string[]>("SMEMBERS", "tg:daily")) ?? [];
    if (!chats.length) return { chats: 0, sent: 0 };
    const t = await deps.intel.get(TILIK_TOKEN);
    const text = ["☀️ <b>GM, TILIK fam</b> · daily $TILIK report", "", checkMessage(t, await holdersOf(TILIK_TOKEN))].join("\n");
    let sent = 0;
    for (const chat of chats) await send(Number(chat), text).then(() => sent++).catch((err) => logger.warn("telegram daily failed", { error: err instanceof Error ? err.name : "error" }));
    return { chats: chats.length, sent };
  }

  return { enabled: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET), handle, alerts, daily, api, logger };
}

export function telegramRoutes(env: Env, bot: ReturnType<typeof createTelegramBot>, opts: { beforeDaily?: () => Promise<unknown> } = {}): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  const cronOk = (h: string | undefined) => Boolean(env.CRON_SECRET) && h === `Bearer ${env.CRON_SECRET}`;
  app.post("/api/telegram/webhook", async (c) => {
    if (!bot.enabled) return c.json({ error: { kind: "unavailable", message: "Telegram bot is not set up." } }, 503);
    if (c.req.header("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return c.json({ error: { kind: "auth", message: "Not allowed." } }, 401);
    const update = (await c.req.json().catch(() => null)) as TgUpdate | null;
    if (update) await bot.handle(update).catch((err) => bot.logger.warn("telegram update failed", { error: err instanceof Error ? err.name : "error" }));
    return c.json({ ok: true }); // always 200: Telegram would otherwise resend the same update
  });
  app.get("/api/cron/alerts", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!cronOk(c.req.header("authorization"))) return c.json({ error: { kind: "auth", message: "Not allowed." } }, 401);
    return c.json(await bot.alerts());
  });
  app.get("/api/cron/daily", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!cronOk(c.req.header("authorization"))) return c.json({ error: { kind: "auth", message: "Not allowed." } }, 401);
    const before = opts.beforeDaily ? await opts.beforeDaily().catch(() => null) : null;
    return c.json({ before, report: bot.enabled ? await bot.daily() : null });
  });
  return app;
}
