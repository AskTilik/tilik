import { Hono } from "hono";
import { robinhoodChain, type ChainConfig } from "../config/chains.js";
import { rateLimitEnabled, type Env } from "../config/env.js";
import type { Logger } from "../core/logger.js";
import { validateAddress, toChecksumAddress } from "../providers/blockchain/evm.js";
import { BlockscoutExplorer } from "../providers/blockchain/explorer.js";
import { keccak256 } from "../providers/blockchain/keccak.js";
import { EvmRpcProvider, JsonRpcClient } from "../providers/blockchain/rpc.js";
import type { BlockchainProvider, ChainBudget, LogInfo } from "../providers/blockchain/types.js";
import { UpstashKv, type Kv } from "../providers/kv/upstash.js";
import type { ClientRateLimiter } from "../security/rate-limit.js";
import { clientKey, tooManyRequests, type AppVariables } from "./http-guards.js";
import { again } from "./launch-safety.js";

/**
 * Holder growth: holder counts over time, stored in Redis.
 *
 * - History: the first time a token is asked for, its holder count is rebuilt
 *   from every Transfer event since launch (balances replayed, addresses above
 *   zero counted) at evenly spaced blocks with their real timestamps.
 * - Tracking: every token check records the explorer's current count (at most
 *   hourly), and a daily cron refreshes every token seen.
 */
const TRANSFER = `0x${keccak256("Transfer(address,address,uint256)").replace(/^0x/, "")}`;
const ZERO = "0x0000000000000000000000000000000000000000";
const MAX_TRANSFERS = 30_000; // rebuilding beyond this is too slow for one request
const MAX_POINTS = 2_000;
const RECORD_EVERY_S = 3_300;
const PER_MINUTE = 20;

export interface HolderPoint {
  t: string;
  holders: number;
  /** "history": rebuilt from transfer events; "tracked": the explorer's count when recorded. */
  source: "history" | "tracked";
}
export interface HolderHistory {
  address: string;
  points: HolderPoint[];
  /** True when the launch history was rebuilt from transfer events. */
  rebuilt: boolean;
  change24h?: number;
  change7d?: number;
  generatedAt: string;
}

export function createHolderTracker(
  env: Env,
  logger: Logger,
  deps: { kv?: Kv | null; chain?: ChainConfig; provider?: BlockchainProvider; explorer?: BlockscoutExplorer | null; now?: () => number } = {},
) {
  const now = deps.now ?? Date.now;
  const chain = deps.chain ?? robinhoodChain(env);
  const kv = deps.kv === null ? undefined : (deps.kv ?? (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN ? new UpstashKv(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN) : undefined));
  const rpcOpts = { timeoutMs: env.ONCHAIN_RPC_TIMEOUT_MS, retries: 1, stableTtlMs: 300_000, liveTtlMs: 15_000 };
  const provider = deps.provider ?? new EvmRpcProvider(chain, new JsonRpcClient(chain.rpcUrls, rpcOpts), rpcOpts);
  const explorer =
    deps.explorer === null
      ? undefined
      : (deps.explorer ??
        (chain.explorerApiUrl
          ? new BlockscoutExplorer(chain.explorerApiUrl, { timeoutMs: env.ONCHAIN_RPC_TIMEOUT_MS, liveTtlMs: 60_000, stableTtlMs: 300_000, ...(chain.explorerApiKey ? { apiKey: chain.explorerApiKey } : {}) })
          : undefined));
  const inflight = new Map<string, Promise<HolderHistory>>();
  const key = (t: string) => `hg:${t}`;

  /** Store the explorer's current count (at most once per ~hour per token). */
  async function record(token: string, holders: number | undefined): Promise<void> {
    if (!kv || holders === undefined || !Number.isFinite(holders)) return;
    const t = token.toLowerCase();
    if ((await kv.cmd("SET", `hg:lock:${t}`, "1", "NX", "EX", RECORD_EVERY_S)) !== "OK") return;
    const ts = now();
    await kv.pipeline([
      ["ZADD", key(t), ts, `${ts}:${holders}:t`],
      ["SADD", "hg:tokens", t],
      ["ZREMRANGEBYRANK", key(t), 0, -(MAX_POINTS + 1)],
    ]);
  }

  /** Logs in [from, to], splitting the range whenever the RPC caps or refuses it. */
  async function allLogs(token: string, from: number, to: number, budget: ChainBudget): Promise<LogInfo[]> {
    const out: LogInfo[] = [];
    const walk = async (a: number, b: number): Promise<void> => {
      let logs: LogInfo[] | undefined;
      try {
        logs = await again(() => provider.logs({ address: token, topics: [TRANSFER], fromBlock: a, toBlock: b }, budget));
      } catch (err) {
        if (b <= a) throw err;
      }
      if (logs && logs.length < 1000) return void out.push(...logs);
      if (b <= a) throw new Error("too many logs in one block");
      const m = Math.floor((a + b) / 2);
      await walk(a, m);
      await walk(m + 1, b);
    };
    await walk(from, to);
    return out.sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
  }

  /** Holder count since launch at evenly spaced blocks, from every Transfer event. */
  async function rebuild(token: string): Promise<HolderPoint[] | "skip"> {
    if (!explorer) return "skip";
    const eb = { signal: AbortSignal.timeout(20_000), rpcCalls: 0, maxRpcCalls: 0, explorerCalls: 0, maxExplorerCalls: 6 };
    const [addr, counters] = await Promise.all([
      again(() => explorer.address(token, eb)),
      again(() => explorer.get<{ transfers_count?: string }>(`/tokens/${token}/counters`, eb)).catch(() => null),
    ]);
    const n = Number(counters?.transfers_count ?? NaN);
    if (!addr?.creation_transaction_hash || !Number.isFinite(n) || n > MAX_TRANSFERS) return "skip";
    const created = await again(() => explorer.transaction(addr.creation_transaction_hash!, eb));
    const launch = created?.block_number;
    if (!launch) return "skip";

    const budget = { signal: AbortSignal.timeout(120_000), rpcCalls: 0, maxRpcCalls: 400, explorerCalls: 0, maxExplorerCalls: 0 };
    const latest = await again(() => provider.latestBlockNumber(budget));
    const [b0, b1] = await Promise.all([again(() => provider.block(launch, budget)), again(() => provider.block(latest, budget))]);
    if (!b0 || !b1) return "skip";
    const days = (Date.parse(b1.timestamp) - Date.parse(b0.timestamp)) / 86_400_000;
    const k = Math.min(48, Math.max(8, Math.ceil(days * 6)));
    const samples = Array.from({ length: k }, (_, i) => launch + Math.round(((i + 1) * (latest - launch)) / k));
    const logs = await allLogs(token, launch, latest, budget);
    const times: string[] = [];
    for (let i = 0; i < samples.length; i += 4) {
      const blocks = await Promise.all(samples.slice(i, i + 4).map((b) => again(() => provider.block(b, budget))));
      times.push(...blocks.map((b) => b?.timestamp ?? ""));
    }

    // Replay balances; keep a running count of addresses above zero.
    const bal = new Map<string, bigint>();
    let holders = 0, li = 0;
    const move = (a: string, d: bigint) => {
      if (a === ZERO) return;
      const before = bal.get(a) ?? 0n, after = before + d;
      bal.set(a, after);
      if (before <= 0n && after > 0n) holders++;
      else if (before > 0n && after <= 0n) holders--;
    };
    const points: HolderPoint[] = [{ t: b0.timestamp, holders: 0, source: "history" }];
    samples.forEach((b, i) => {
      for (; li < logs.length && logs[li]!.blockNumber <= b; li++) {
        const l = logs[li]!;
        const v = BigInt(l.data.length > 2 ? l.data.slice(0, 66) : "0x0");
        move(`0x${(l.topics[1] ?? "").slice(-40)}`.toLowerCase(), -v);
        move(`0x${(l.topics[2] ?? "").slice(-40)}`.toLowerCase(), v);
      }
      if (times[i]) points.push({ t: times[i]!, holders, source: "history" });
    });
    return points;
  }

  async function load(token: string): Promise<HolderHistory> {
    if (!kv) throw Object.assign(new Error("no storage"), { name: "NoStorage" });
    const t = token.toLowerCase();
    let rebuilt = (await kv.cmd<string | null>("GET", `hg:bf:${t}`)) === "1";
    if (!rebuilt && (await kv.cmd<string | null>("GET", `hg:bf:${t}`)) !== "skip" && (await kv.cmd("SET", `hg:bflock:${t}`, "1", "NX", "EX", 300)) === "OK") {
      const pts = await rebuild(t).catch((err) => {
        logger.warn("holder history rebuild failed", { error: err instanceof Error ? err.name : "error" });
        return null;
      });
      if (pts === "skip") await kv.cmd("SET", `hg:bf:${t}`, "skip");
      else if (pts) {
        await kv.pipeline([["ZADD", key(t), ...pts.flatMap((p) => [Date.parse(p.t), `${Date.parse(p.t)}:${p.holders}:h`])], ["SADD", "hg:tokens", t], ["SET", `hg:bf:${t}`, "1"]]);
        rebuilt = true;
      }
      await kv.cmd("DEL", `hg:bflock:${t}`);
    }
    const members = (await kv.cmd<string[]>("ZRANGE", key(t), 0, -1)) ?? [];
    const points = members
      .map((m) => m.split(":"))
      .filter((p) => p.length === 3 && /^\d+$/.test(p[0]!) && /^\d+$/.test(p[1]!))
      .map((p) => ({ t: new Date(Number(p[0])).toISOString(), holders: Number(p[1]), source: (p[2] === "h" ? "history" : "tracked") as HolderPoint["source"] }))
      .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    const last = points.at(-1);
    const at = (ms: number) => [...points].reverse().find((p) => Date.parse(p.t) <= now() - ms);
    const d1 = at(86_400_000), d7 = at(7 * 86_400_000);
    return {
      address: toChecksumAddress(t),
      points,
      rebuilt,
      ...(last && d1 ? { change24h: last.holders - d1.holders } : {}),
      ...(last && d7 ? { change7d: last.holders - d7.holders } : {}),
      generatedAt: new Date(now()).toISOString(),
    };
  }

  /** Daily: refresh the count of every token seen. */
  async function cron(): Promise<{ tokens: number; recorded: number }> {
    if (!kv || !explorer) return { tokens: 0, recorded: 0 };
    const tokens = ((await kv.cmd<string[]>("SMEMBERS", "hg:tokens")) ?? []).filter((t) => /^0x[0-9a-f]{40}$/.test(t)).slice(0, 300);
    let recorded = 0;
    for (let i = 0; i < tokens.length; i += 4) {
      await Promise.all(
        tokens.slice(i, i + 4).map(async (t) => {
          const eb = { signal: AbortSignal.timeout(15_000), rpcCalls: 0, maxRpcCalls: 0, explorerCalls: 0, maxExplorerCalls: 2 };
          const tk = await again(() => explorer.token(t, eb)).catch(() => null);
          const n = tk?.holders_count && /^\d+$/.test(tk.holders_count) ? Number(tk.holders_count) : undefined;
          if (n === undefined) return;
          await kv.cmd("DEL", `hg:lock:${t}`);
          await record(t, n);
          recorded++;
        }),
      );
    }
    return { tokens: tokens.length, recorded };
  }

  return {
    enabled: Boolean(kv),
    record: (token: string, holders: number | undefined) => record(token, holders).catch((err) => logger.warn("holder record failed", { error: err instanceof Error ? err.name : "error" })),
    history(token: string): Promise<HolderHistory> {
      const t = token.toLowerCase();
      let p = inflight.get(t);
      if (!p) {
        p = load(t).finally(() => inflight.delete(t));
        inflight.set(t, p);
      }
      return p;
    },
    cron,
    logger,
  };
}

export function holderRoutes(env: Env, limiter: ClientRateLimiter, tracker: ReturnType<typeof createHolderTracker>): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.get("/api/token/:address/holders-history", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!tracker.enabled) return c.json({ error: { kind: "unavailable", message: "Holder history is not set up on this server." } }, 503);
    const check = validateAddress(c.req.param("address").trim());
    if (!check.ok) return c.json({ error: { kind: "validation", message: "That is not a valid token address." } }, 400);
    if (rateLimitEnabled(env)) {
      const v = limiter.take("holders", clientKey(c, env), PER_MINUTE);
      if (!v.ok) return tooManyRequests(c, v.retryAfterMs);
    }
    try {
      const body = await tracker.history(check.address);
      c.header("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=1200");
      return c.json(body);
    } catch (err) {
      tracker.logger.warn("holder history failed", { error: err instanceof Error ? err.name : "error" });
      return c.json({ error: { kind: "upstream", message: "Holder history could not be read right now. Try again in a moment." } }, 502);
    }
  });
  // Vercel Cron calls this daily with "Authorization: Bearer $CRON_SECRET".
  app.get("/api/cron/holders", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!env.CRON_SECRET || c.req.header("authorization") !== `Bearer ${env.CRON_SECRET}`) return c.json({ error: { kind: "auth", message: "Not allowed." } }, 401);
    return c.json(await tracker.cron());
  });
  return app;
}
