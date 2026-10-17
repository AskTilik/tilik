import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { rateLimitEnabled, type Env } from "../config/env.js";
import type { Logger } from "../core/logger.js";
import { UpstashKv, type Kv } from "../providers/kv/upstash.js";
import type { ClientRateLimiter } from "../security/rate-limit.js";
import type { VeyraResponse } from "../types/api.js";
import { clientKey, tooManyRequests, type AppVariables } from "./http-guards.js";

/**
 * Shareable answers. Every finished answer is kept server-side for 7 days
 * under its response id; POST /api/share copies one to a permanent short id,
 * so a shared link always shows exactly what TILIK answered — never text a
 * browser sent in.
 */
const PENDING_TTL_S = 7 * 86_400;
const MAX_DATA_BYTES = 150_000;
const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PER_MINUTE = 10;

export interface SharedAnswer {
  id: string;
  question: string;
  sharedAt: string;
  answeredAt: string;
  response: Pick<VeyraResponse, "answer" | "type" | "grounded" | "sources"> & {
    data?: VeyraResponse["data"];
    plan?: { unifiedIntents: VeyraResponse["plan"]["unifiedIntents"] };
    model?: { provider?: string; model?: string };
  };
}

const shortId = () => {
  const b = randomBytes(10);
  return Array.from(b, (x) => ID_ALPHABET[x % ID_ALPHABET.length]).join("");
};

export function createShares(env: Env, logger: Logger, deps: { kv?: Kv | null; now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  const kv = deps.kv === null ? undefined : (deps.kv ?? (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN ? new UpstashKv(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN) : undefined));

  /** Keep a finished answer for 7 days so its asker can share it. */
  async function keep(question: string, res: VeyraResponse): Promise<void> {
    if (!kv || !res?.id || !res.answer) return;
    const data = res.data && JSON.stringify(res.data).length <= MAX_DATA_BYTES ? res.data : undefined;
    const body: Omit<SharedAnswer, "id" | "sharedAt"> = {
      question: question.slice(0, 4000),
      answeredAt: new Date(now()).toISOString(),
      response: {
        answer: res.answer,
        type: res.type,
        grounded: res.grounded,
        sources: (res.sources ?? []).slice(0, 40),
        ...(data ? { data } : {}),
        ...(res.plan?.unifiedIntents ? { plan: { unifiedIntents: res.plan.unifiedIntents } } : {}),
        ...(res.model ? { model: { provider: res.model.provider, model: res.model.model } } : {}),
      },
    };
    await kv.cmd("SET", `ans:${res.id}`, JSON.stringify(body), "EX", PENDING_TTL_S);
  }

  /** Make a kept answer permanent; the same answer always gets the same link. */
  async function share(responseId: string): Promise<{ id: string } | null> {
    if (!kv) throw Object.assign(new Error("no storage"), { name: "NoStorage" });
    const existing = await kv.cmd<string | null>("GET", `ans:shared:${responseId}`);
    if (existing) return { id: existing };
    const raw = await kv.cmd<string | null>("GET", `ans:${responseId}`);
    if (!raw) return null;
    const id = shortId();
    const body: SharedAnswer = { id, sharedAt: new Date(now()).toISOString(), ...(JSON.parse(raw) as Omit<SharedAnswer, "id" | "sharedAt">) };
    await kv.pipeline([
      ["SET", `share:${id}`, JSON.stringify(body)],
      ["SET", `ans:shared:${responseId}`, id, "EX", PENDING_TTL_S],
    ]);
    return { id };
  }

  async function get(id: string): Promise<SharedAnswer | null> {
    if (!kv) throw Object.assign(new Error("no storage"), { name: "NoStorage" });
    const raw = await kv.cmd<string | null>("GET", `share:${id}`);
    return raw ? (JSON.parse(raw) as SharedAnswer) : null;
  }

  return {
    enabled: Boolean(kv),
    keep: (question: string, res: VeyraResponse) => keep(question, res).catch((err) => logger.warn("answer keep failed", { error: err instanceof Error ? err.name : "error" })),
    share,
    get,
    logger,
  };
}

export const SHARE_ID = /^[A-Za-z0-9]{10}$/;

export function shareRoutes(env: Env, limiter: ClientRateLimiter, shares: ReturnType<typeof createShares>): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.post("/api/share", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!shares.enabled) return c.json({ error: { kind: "unavailable", message: "Sharing is not set up on this server." } }, 503);
    const body = (await c.req.json().catch(() => null)) as { id?: unknown } | null;
    const rid = typeof body?.id === "string" ? body.id.trim() : "";
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(rid)) return c.json({ error: { kind: "validation", message: "Pass the answer's id." } }, 400);
    if (rateLimitEnabled(env)) {
      const v = limiter.take("share", clientKey(c, env), PER_MINUTE);
      if (!v.ok) return tooManyRequests(c, v.retryAfterMs);
    }
    try {
      const out = await shares.share(rid);
      if (!out) return c.json({ error: { kind: "not_found", message: "This answer can no longer be shared (answers can be shared for 7 days)." } }, 404);
      return c.json({ id: out.id, url: `/a/${out.id}` });
    } catch (err) {
      shares.logger.warn("share failed", { error: err instanceof Error ? err.name : "error" });
      return c.json({ error: { kind: "upstream", message: "Sharing failed. Try again in a moment." } }, 502);
    }
  });
  app.get("/api/share/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!shares.enabled) return c.json({ error: { kind: "unavailable", message: "Sharing is not set up on this server." } }, 503);
    const id = c.req.param("id");
    if (!SHARE_ID.test(id)) return c.json({ error: { kind: "validation", message: "Not a share link." } }, 400);
    try {
      const s = await shares.get(id);
      if (!s) return c.json({ error: { kind: "not_found", message: "This shared answer does not exist." } }, 404);
      c.header("Cache-Control", "public, max-age=300, s-maxage=86400");
      return c.json(s);
    } catch {
      return c.json({ error: { kind: "upstream", message: "This shared answer could not be read right now." } }, 502);
    }
  });
  return app;
}
