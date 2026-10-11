import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_ROUTING, type RoutingConfig } from "../src/config/routing.js";
import { silentLogger } from "../src/core/logger.js";
import { DailyBudget } from "../src/core/guards.js";
import { ProviderRegistry } from "../src/providers/llm/registry.js";
import { AllModelsFailedError, ModelRouter, parseModelPreference } from "../src/router/model-router.js";
import { VeyraError } from "../src/core/errors.js";
import { httpJson } from "../src/core/http.js";
import type { GenerateRequest } from "../src/providers/llm/types.js";
import { FakeProvider, testEnv } from "./helpers.js";

const routing: RoutingConfig = {
  ...DEFAULT_ROUTING,
  tiers: {
    ...DEFAULT_ROUTING.tiers,
    fast: [
      { provider: "a", model: "a-fast" },
      { provider: "b", model: "b-fast" },
    ],
  },
};
const messages = [{ role: "user" as const, content: "hi" }];

function router(providers: FakeProvider[], budget?: DailyBudget) {
  const registry = new ProviderRegistry();
  for (const p of providers) registry.register(p);
  return new ModelRouter({ env: testEnv(), routing, providers: registry, logger: silentLogger, ...(budget ? { budget } : {}) });
}

describe("parseModelPreference", () => {
  it("parses auto, provider, and provider:model with colons in the id", () => {
    assert.deepEqual(parseModelPreference(undefined), { kind: "auto" });
    assert.deepEqual(parseModelPreference("Groq"), { kind: "provider", provider: "groq" });
    assert.deepEqual(parseModelPreference("openrouter:nvidia/x:free"), { kind: "model", provider: "openrouter", model: "nvidia/x:free" });
  });
});

describe("ModelRouter", () => {
  it("picks the highest-ranked tier among intents", () => {
    const r = router([]);
    assert.equal(r.selectTier(["general", "research"]), "reasoning");
    assert.equal(r.selectTier(["summarize"]), "cheap");
    assert.equal(r.selectTier(["github", "web_extract"]), "coding");
  });

  it("falls back to the next provider when one is rate-limited", async () => {
    const a = new FakeProvider("a", { fail: "rate_limit" });
    const b = new FakeProvider("b");
    const r = router([a, b]);
    const { result, attempts } = await r.generate(r.plan("fast", { kind: "auto" }), messages);
    assert.equal(result.provider, "b");
    assert.deepEqual(attempts.map((x) => [x.provider, x.ok]), [["a", false], ["b", true]]);
    // a is now cooling down and is skipped on the next plan.
    assert.ok(r.plan("fast", { kind: "auto" }).skipped.some((s) => s.provider === "a" && s.model === "a-fast"));
  });

  it("skips unconfigured providers without calling them", () => {
    const r = router([new FakeProvider("a", { configured: false }), new FakeProvider("b")]);
    const plan = r.plan("fast", { kind: "auto" });
    assert.equal(plan.candidates[0]?.provider.id, "b");
    assert.ok(plan.skipped.some((s) => s.provider === "a" && /not configured/.test(s.reason)));
  });

  it("honours an explicit model and strict mode", async () => {
    const a = new FakeProvider("a", { fail: "upstream" });
    const r = router([a, new FakeProvider("b")]);
    const strict = r.plan("fast", { kind: "model", provider: "a", model: "custom" }, true);
    assert.deepEqual(strict.candidates.map((c) => c.model), ["custom"]);
    await assert.rejects(r.generate(strict, messages), AllModelsFailedError);
    const lenient = r.plan("fast", { kind: "model", provider: "a", model: "custom" });
    assert.equal(lenient.candidates[0]?.model, "custom");
    assert.ok(lenient.candidates.length > 1);
  });

  it("enforces the daily budget", async () => {
    const r = router([new FakeProvider("a"), new FakeProvider("b")], new DailyBudget({ a: 1, b: 0 }));
    const plan = r.plan("fast", { kind: "auto" });
    await r.generate(plan, [{ role: "user", content: "one" }]);
    const second = await r.generate(plan, [{ role: "user", content: "two" }]);
    assert.equal(second.result.provider, "b");
    assert.equal(second.attempts[0]?.error?.kind, "budget");
  });

  it("serves identical prompts from cache", async () => {
    const a = new FakeProvider("a");
    const r = router([a]);
    const plan = r.plan("fast", { kind: "auto" });
    await r.generate(plan, messages);
    const again = await r.generate(plan, messages);
    assert.equal(again.cached, true);
    assert.equal(a.calls.length, 1);
  });

  it("streams with fallback before the first token", async () => {
    const r = router([new FakeProvider("a", { fail: "quota" }), new FakeProvider("b", { reply: "hello world" })]);
    let text = "";
    let model = "";
    for await (const ev of r.stream(r.plan("fast", { kind: "auto" }), messages)) {
      if (ev.type === "model") model = ev.provider;
      if (ev.type === "delta") text += ev.text;
    }
    assert.equal(model, "b");
    assert.equal(text.trim(), "hello world");
  });

  it("an empty opening chunk followed by a stall still falls back (no text was shown yet)", async () => {
    class StallsAfterEmptyChunk extends FakeProvider {
      override async *stream() {
        yield { type: "delta" as const, text: "" };
        throw new VeyraError("timeout", "a", "Timed out after 60000ms");
      }
    }
    const r = router([new StallsAfterEmptyChunk("a"), new FakeProvider("b", { reply: "hello world" })]);
    let text = "";
    let model = "";
    for await (const ev of r.stream(r.plan("fast", { kind: "auto" }), messages)) {
      if (ev.type === "model") model = ev.provider;
      if (ev.type === "delta") text += ev.text;
    }
    assert.equal(model, "b");
    assert.equal(text.trim(), "hello world");
  });
});

describe("OpenRouter-only fallback (default routing)", () => {
  /** OpenRouter stand-in that fails one specific model, like a slow/overloaded upstream route. */
  class FlakyOpenRouter extends FakeProvider {
    constructor(private readonly failing: string, private readonly kind: "timeout" | "upstream" = "timeout") {
      super("openrouter", {}, "openai/gpt-oss-120b");
    }
    override async generate(req: GenerateRequest) {
      if (req.model === this.failing) {
        this.calls.push(req);
        throw new VeyraError(this.kind, "openrouter", "Timed out after 60000ms");
      }
      return super.generate(req);
    }
  }
  const onlyOpenRouter = (p: FakeProvider) =>
    new ModelRouter({ env: testEnv(), routing: DEFAULT_ROUTING, providers: new ProviderRegistry().register(p), logger: silentLogger });

  it("the fast tier has a second OpenRouter model, so a timeout falls back instead of failing", async () => {
    const p = new FlakyOpenRouter("openai/gpt-oss-120b");
    const r = onlyOpenRouter(p);
    const plan = r.plan("fast", { kind: "auto" });
    assert.deepEqual(plan.candidates.map((c) => c.model), ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
    const { result, attempts } = await r.generate(plan, messages);
    assert.equal(result.model, "openai/gpt-oss-20b");
    assert.deepEqual(attempts.map((a) => [a.model, a.ok, a.error?.kind]), [["openai/gpt-oss-120b", false, "timeout"], ["openai/gpt-oss-20b", true, undefined]]);
  });

  it("stays bounded: every model at most once, then a clean failure", async () => {
    const p = new FakeProvider("openrouter", { fail: "upstream" }, "openai/gpt-oss-120b");
    const r = onlyOpenRouter(p);
    for (const tier of ["cheap", "fast", "coding", "reasoning"] as const) {
      p.calls = [];
      await assert.rejects(r.generate(r.plan(tier, { kind: "auto" }), messages), AllModelsFailedError);
      const models = p.calls.map((c) => c.model);
      assert.equal(new Set(models).size, models.length, `${tier}: no model repeated`);
      assert.ok(models.length <= 4, `${tier}: ${models.length} attempts`);
    }
  });

  it("streaming falls back the same way when the first model fails before its first token", async () => {
    const p = new FlakyOpenRouter("openai/gpt-oss-120b", "upstream");
    const r = onlyOpenRouter(p);
    let model = "";
    for await (const ev of r.stream(r.plan("fast", { kind: "auto" }), messages)) if (ev.type === "model") model = ev.model;
    assert.equal(model, "openai/gpt-oss-20b");
  });
});
describe("httpJson error kinds (what fallback decisions depend on)", () => {
  const body = (fail: () => unknown) =>
    new Response(new ReadableStream({ pull(c) { c.error(fail()); } }), { status: 200, headers: { "content-type": "application/json" } });
  const withFetch = async (res: () => Response, run: () => Promise<unknown>) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => res()) as typeof fetch;
    try {
      return await run().then(() => null, (e: unknown) => e as VeyraError);
    } finally {
      globalThis.fetch = original;
    }
  };

  it("a body that times out is 'timeout' (fallback continues), not 'invalid JSON'", async () => {
    const e = await withFetch(() => body(() => new DOMException("timed out", "TimeoutError")), () => httpJson("https://api.example.com/x", { source: "openrouter", timeoutMs: 60000 }));
    assert.equal((e as VeyraError).kind, "timeout");
  });

  it("a cancelled caller is 'aborted' (fallback stops)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const e = await withFetch(() => body(() => new DOMException("aborted", "AbortError")), () => httpJson("https://api.example.com/x", { source: "openrouter", timeoutMs: 60000, signal: ctrl.signal }));
    assert.equal((e as VeyraError).kind, "aborted");
  });

  it("genuinely malformed JSON is still 'upstream'", async () => {
    const e = await withFetch(() => new Response("<html>oops", { status: 200 }), () => httpJson("https://api.example.com/x", { source: "openrouter", timeoutMs: 60000 }));
    assert.equal((e as VeyraError).kind, "upstream");
    assert.match((e as VeyraError).message, /not valid JSON/);
  });
});