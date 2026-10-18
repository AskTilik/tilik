import { createHash } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { rateLimitEnabled, type Env } from "../config/env.js";
import type { Logger } from "../core/logger.js";
import { validateAddress } from "../providers/blockchain/evm.js";
import type { ModelRouter } from "../router/model-router.js";
import type { ClientRateLimiter } from "../security/rate-limit.js";
import type { HolderHistory } from "./holders.js";
import { clientKey, tooManyRequests, type AppVariables } from "./http-guards.js";
import type { TokenIntel } from "./token.js";

/**
 * AI Token Brief: the token check explained in a few plain sentences.
 *
 * The model only sees a numbered list of facts taken from the token check
 * (chain, explorer and DEX data). Every sentence must cite fact numbers; a
 * sentence without a valid citation, or with advice / predictions, is dropped.
 */
const TTL_MS = 15 * 60_000;
const PER_MINUTE = 6;
const BANNED = /\b(buy now|sell now|you should (buy|sell)|moon|to the moon|guarantee[ds]?|will (go|pump|rise|dump|moon)|price target|100x|1000x|not financial advice|safe investment|can'?t lose|rug ?proof)\b/i;

export interface Brief {
  address: string;
  symbol?: string;
  headline: string;
  points: { text: string; facts: number[] }[];
  facts: string[];
  model?: string;
  generatedAt: string;
}

const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`;
const usd = (n: number | undefined) => (n === undefined ? "unknown" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toPrecision(3)}`);

/** The numbered facts the model may use. Only what the token check actually read. */
export function briefFacts(t: TokenIntel, h?: HolderHistory): string[] {
  const f: string[] = [];
  const name = t.token.symbol ? `$${t.token.symbol}` : "The token";
  const m = t.market, main = t.pools.find((p) => p.main);
  if (m?.priceUsd !== undefined) f.push(`${name} trades at ${usd(m.priceUsd)}${main?.change24hPct !== undefined ? `, ${pct(main.change24hPct)} in 24 hours` : ""}.`);
  if (m?.liquidityUsd !== undefined) f.push(`Liquidity across its pools: ${usd(m.liquidityUsd)}${main ? `; the main pool is ${main.name} on ${main.dex.replace(/-/g, " ")}` : ""}.`);
  if (m?.volume24hUsd !== undefined) f.push(`24-hour trading volume: ${usd(m.volume24hUsd)}.`);
  if (m?.graduated) f.push(`It graduated from its launchpad${m.graduated.at ? ` on ${m.graduated.at.slice(0, 10)}` : ""} and trades on a DEX pool.`);
  const lk = t.liquidityLock;
  if (lk) f.push(lk.held && lk.hasLiquidity ? `The main pool's liquidity position (#${lk.positionId}) is held by ${lk.lockerName}, a verified contract with no withdraw function: it is locked permanently.` : `The locked liquidity position #${lk.positionId} is empty or no longer held by the locker.`);
  const d = t.dev;
  if (d) {
    f.push(`The launcher (dev) wallet is ${d.address.slice(0, 6)}…${d.address.slice(-4)}${d.launchedVia ? `, launched via ${d.launchedVia}` : ""}.`);
    if (d.holdsPct !== undefined) f.push(`The dev wallet holds ${d.holdsPct}% of the supply.`);
    f.push(`The dev wallet's moves of this token: bought or received ${d.received} times, burned ${d.burned} times, sent or sold ${d.sentOut} times.`);
  }
  const s = t.snipers;
  if (s) f.push(s.buyers ? `${s.buyers} wallets bought ${s.boughtPct}% of the supply in the first ${s.windowSec} seconds${s.stillHoldPct !== undefined ? `; the ${s.checked} largest of them now hold ${s.stillHoldPct}% and ${s.soldAll} sold or moved everything` : ""}.` : "Nobody bought in the first minute after launch.");
  if (t.token.holders !== undefined) f.push(`${t.token.holders} addresses hold the token.`);
  const pts = h?.points ?? [];
  if (pts.length >= 2) {
    const peak = pts.reduce((a, p) => (p.holders > a.holders ? p : a), pts[0]!);
    f.push(`Holder count peaked at ${peak.holders} on ${peak.t.slice(0, 10)}${h?.change24h !== undefined ? `; it changed by ${h.change24h >= 0 ? "+" : ""}${h.change24h} in the last 24 hours` : ""}.`);
  }
  if (t.holders) f.push(`The top 10 holders (excluding pools, lockers and burn addresses) own ${t.holders.top10Pct}% of the supply.`);
  const sl = t.sells;
  if (sl) f.push(`In the main pool's last ${sl.buys + sl.sells} trades: ${sl.buys} buys by ${sl.buyers} wallets and ${sl.sells} sells by ${sl.sellers} wallets.`);
  if (t.verified !== undefined) f.push(t.verified ? "The contract's source code is verified on the explorer." : "The contract's source code is not verified.");
  for (const c of t.checks.filter((c) => c.level === "risk" || c.level === "warn")) f.push(`Flag (${c.level}): ${c.title}.`);
  return f;
}

const Schema = z.object({
  headline: z.string().min(3).max(120),
  points: z.array(z.object({ text: z.string().min(3).max(260), facts: z.array(z.number().int()).min(1).max(6) })).min(1).max(7),
});

export function createBrief(
  env: Env,
  logger: Logger,
  deps: { intel: { get(a: string): Promise<TokenIntel> }; holders?: { enabled: boolean; history(a: string): Promise<HolderHistory> }; models: Pick<ModelRouter, "plan" | "structured">; now?: () => number },
) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; v: Brief }>();
  const inflight = new Map<string, Promise<Brief>>();

  async function build(address: string): Promise<Brief> {
    const t = await deps.intel.get(address);
    const h = deps.holders?.enabled ? await Promise.race([deps.holders.history(address).catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), 4000))]) : undefined;
    const facts = briefFacts(t, h);
    if (facts.length < 3) throw Object.assign(new Error("not enough data"), { name: "NoData" });
    const key = `${t.address}:${createHash("sha256").update(facts.join("\n")).digest("hex").slice(0, 16)}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < TTL_MS) return hit.v;
    const messages = [
      {
        role: "system" as const,
        content: [
          "You explain a crypto token check to an ordinary person in plain, calm English.",
          "Use ONLY the numbered FACTS. Do not add any other information, numbers or names.",
          "Write a short headline (max 12 words) and 4 to 6 short sentences. Each sentence must list the fact numbers it relies on.",
          "Start with what matters most for safety (liquidity lock, dev wallet, early buyers, selling, flags), then the market and holders.",
          "No advice, no predictions, no opinions on whether to buy or sell, no hype words, no emojis.",
          'Answer as JSON: {"headline": string, "points": [{"text": string, "facts": [number]}]}.',
        ].join("\n"),
      },
      { role: "user" as const, content: `FACTS about ${t.token.symbol ? "$" + t.token.symbol : t.address}:\n${facts.map((x, i) => `[${i + 1}] ${x}`).join("\n")}` },
    ];
    const plan = deps.models.plan("fast", { kind: "auto" });
    const { value: res, candidate } = await deps.models.structured(plan, messages, Schema, AbortSignal.timeout(45_000));
    const value = res.data;
    const points = value.points
      .map((p) => ({ text: p.text.replace(/\s+/g, " ").trim(), facts: [...new Set(p.facts)].filter((n) => n >= 1 && n <= facts.length) }))
      .filter((p) => p.facts.length > 0 && !BANNED.test(p.text));
    if (points.length < 2) throw Object.assign(new Error("brief failed validation"), { name: "BadBrief" });
    const headline = BANNED.test(value.headline) ? `${t.token.symbol ? "$" + t.token.symbol : "Token"} at a glance` : value.headline.trim();
    const v: Brief = { address: t.address, ...(t.token.symbol ? { symbol: t.token.symbol } : {}), headline, points, facts, model: `${candidate.provider.id} · ${candidate.model}`, generatedAt: new Date(now()).toISOString() };
    cache.set(key, { at: now(), v });
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
    return v;
  }

  return {
    get(address: string): Promise<Brief> {
      const k = address.toLowerCase();
      let p = inflight.get(k);
      if (!p) {
        p = build(address).finally(() => inflight.delete(k));
        inflight.set(k, p);
      }
      return p;
    },
    logger,
  };
}

export function briefRoutes(env: Env, limiter: ClientRateLimiter, brief: ReturnType<typeof createBrief>): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.get("/api/token/:address/brief", async (c) => {
    c.header("Cache-Control", "no-store");
    const check = validateAddress(c.req.param("address").trim());
    if (!check.ok) return c.json({ error: { kind: "validation", message: "That is not a valid token address." } }, 400);
    if (rateLimitEnabled(env)) {
      const v = limiter.take("brief", clientKey(c, env), PER_MINUTE);
      if (!v.ok) return tooManyRequests(c, v.retryAfterMs);
    }
    try {
      const body = await brief.get(check.address);
      c.header("Cache-Control", "public, max-age=120, s-maxage=600, stale-while-revalidate=1200");
      return c.json(body);
    } catch (err) {
      const name = err instanceof Error ? err.name : "error";
      if (name === "NotAToken") return c.json({ error: { kind: "validation", message: "This address is not a token." } }, 400);
      if (name === "NoData") return c.json({ error: { kind: "not_found", message: "Not enough data on this token for a brief yet." } }, 404);
      brief.logger.warn("brief failed", { error: name });
      return c.json({ error: { kind: "upstream", message: "The AI brief could not be written right now. Try again in a moment." } }, 502);
    }
  });
  return app;
}
