import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { createShares, shareRoutes } from "../src/api/shares.js";
import { MemoryKv } from "../src/providers/kv/upstash.js";
import type { VeyraResponse } from "../src/types/api.js";
import { testEnv } from "./helpers.js";

const env = testEnv();
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as any;
const limiter = { take: () => ({ ok: true }) } as any;
const response = (id: string) =>
  ({
    id,
    type: "research",
    answer: "TILIK's liquidity is locked [1].",
    grounded: true,
    sources: [{ id: 1, title: "Locker", url: "https://robinhoodchain.blockscout.com/address/0x1", type: "onchain", evidence: "live_data", provider: "x", retrievedAt: "2026-10-17T00:00:00Z" }],
    data: {},
    plan: { unifiedIntents: ["ONCHAIN_MARKET"] },
    model: { provider: "gemini", model: "m" },
  }) as unknown as VeyraResponse;

function setup() {
  let now = Date.parse("2026-10-17T00:00:00Z");
  const kv = new MemoryKv(() => now);
  const shares = createShares(env, quiet, { kv, now: () => now });
  const app = new Hono().route("/", shareRoutes(env, limiter, shares));
  const post = (id: unknown) => app.request("/api/share", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
  return { shares, app, post, tick: (ms: number) => (now += ms) };
}

describe("shareable answers", () => {
  it("shares exactly what the server answered, and the same answer always gets the same link", async () => {
    const { shares, app, post } = setup();
    await shares.keep("Is TILIK's liquidity locked?", response("req-12345678"));
    const r1 = await post("req-12345678");
    assert.equal(r1.status, 200);
    const { id, url } = (await r1.json()) as { id: string; url: string };
    assert.match(id, /^[A-Za-z0-9]{10}$/);
    assert.equal(url, `/a/${id}`);
    assert.equal(((await (await post("req-12345678")).json()) as { id: string }).id, id);
    const got: any = await (await app.request(`/api/share/${id}`)).json();
    assert.equal(got.question, "Is TILIK's liquidity locked?");
    assert.equal(got.response.answer, "TILIK's liquidity is locked [1].");
    assert.equal(got.response.sources[0].url, "https://robinhoodchain.blockscout.com/address/0x1");
  });

  it("refuses answers it never kept, expired ones, and malformed ids", async () => {
    const { shares, app, post, tick } = setup();
    assert.equal((await post("never-answered-1")).status, 404);
    await shares.keep("q", response("req-old-0001"));
    tick(8 * 86_400_000);
    assert.equal((await post("req-old-0001")).status, 404);
    assert.equal((await post("../../etc")).status, 400);
    assert.equal((await post(42)).status, 400);
    assert.equal((await app.request("/api/share/short")).status, 400);
    assert.equal((await app.request("/api/share/AAAAAAAAAA")).status, 404);
  });

  it("is off without storage", async () => {
    const app = new Hono().route("/", shareRoutes(env, limiter, createShares(env, quiet, { kv: null })));
    assert.equal((await app.request("/api/share", { method: "POST", body: "{}" })).status, 503);
  });
});
