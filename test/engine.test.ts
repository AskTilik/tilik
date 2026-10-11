import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { createContainer } from "../src/container.js";
import { silentLogger } from "../src/core/logger.js";
import { ProviderRegistry } from "../src/providers/llm/registry.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ChatRequestSchema } from "../src/types/api.js";
import { FakeProvider, fakeTool, testEnv } from "./helpers.js";

function setup(opts: { tools?: ToolRegistry; providers?: FakeProvider[]; env?: Record<string, string> } = {}) {
  const providers = new ProviderRegistry();
  for (const p of opts.providers ?? [new FakeProvider("groq"), new FakeProvider("gemini"), new FakeProvider("openrouter")]) {
    providers.register(p);
  }
  return createContainer(testEnv(opts.env), { logger: silentLogger, providers, tools: opts.tools ?? new ToolRegistry() });
}

const request = (message: string, extra: Record<string, unknown> = {}) => ChatRequestSchema.parse({ message, ...extra });

describe("VeyraEngine", () => {
  it("answers a general question with no tools and is grounded", async () => {
    const groq = new FakeProvider("groq");
    const { engine } = setup({ providers: [groq] });
    const res = await engine.ask(request("Tell me a joke"), new AbortController().signal);
    assert.equal(res.type, "normal");
    assert.equal(res.grounded, true);
    assert.equal(res.model.provider, "groq");
    assert.equal(res.plan.tier, "fast");
    assert.equal(res.toolRuns.length, 0);
    assert.equal(groq.calls[0]?.model, "openai/gpt-oss-120b"); // Groq's fast-tier model
  });

  it("marks live-data questions as ungrounded and instructs the model when tools are missing", async () => {
    const groq = new FakeProvider("groq");
    const { engine } = setup({ providers: [groq] });
    const res = await engine.ask(request("What happened on Robinhood Chain today?"), new AbortController().signal);
    assert.equal(res.type, "onchain");
    assert.equal(res.grounded, false);
    assert.ok(res.warnings.some((w) => w.includes("chain.data")));
    const system = groq.calls[0]?.messages[0]?.content ?? "";
    assert.match(system, /LIVE DATA UNAVAILABLE/);
    assert.match(system, /chain\.data/);
  });

  it("passes numbered tool sources to the model and returns them", async () => {
    const groq = new FakeProvider("groq");
    const tools = new ToolRegistry().register(fakeTool({ name: "exa", capability: "web.search" }));
    const { engine } = setup({ providers: [groq], tools });
    const res = await engine.ask(request("search for who is the CEO of Robinhood"), new AbortController().signal);
    assert.equal(res.type, "research");
    assert.equal(res.grounded, true);
    assert.equal(res.sources[0]?.id, 1);
    assert.equal(res.sources[0]?.url, "https://example.com/exa");
    assert.match(groq.calls[0]?.messages.at(-1)?.content ?? "", /^CONTEXT SOURCES[\s\S]*<<<SOURCE 1 [0-9a-f]{12}>>>\nTitle: exa result/);
    assert.deepEqual(res.data, { "web.search": [{ tool: "exa", step: "web.search#1", data: { n: 1 } }] });
    assert.deepEqual(res.citations.used, []);
  });

  it("routes research to the reasoning tier", async () => {
    const openrouter = new FakeProvider("openrouter");
    const { engine } = setup({ providers: [openrouter] });
    const res = await engine.ask(request("Research the latest developments around tokenized assets"), new AbortController().signal);
    assert.equal(res.plan.tier, "reasoning");
    assert.equal(res.model.model, "deepseek/deepseek-v4-pro");
  });

  it("reports fallback when the requested provider is unavailable", async () => {
    const { engine } = setup({ providers: [new FakeProvider("gemini", { configured: false }), new FakeProvider("groq")] });
    const res = await engine.ask(request("Tell me a joke", { model: "gemini" }), new AbortController().signal);
    assert.equal(res.model.provider, "groq");
    assert.equal(res.model.fallbackUsed, true);
    assert.ok(res.warnings.some((w) => w.includes('"gemini"') && w.includes("not configured")));
  });
});

describe("HTTP API", () => {
  it("POST /chat returns a response", async () => {
    const app = createApp(setup());
    const res = await app.request("/chat", { method: "POST", body: JSON.stringify({ message: "hello" }), headers: { "content-type": "application/json" } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { answer: string };
    assert.equal(body.answer, "answer from openrouter"); // OpenRouter is the primary provider when configured
  });

  it("validates input", async () => {
    const app = createApp(setup());
    const res = await app.request("/chat", { method: "POST", body: JSON.stringify({ message: "" }) });
    assert.equal(res.status, 400);
  });

  it("returns 503 with guidance when no provider is configured", async () => {
    const app = createApp(setup({ providers: [new FakeProvider("groq", { configured: false })] }));
    const res = await app.request("/chat", { method: "POST", body: JSON.stringify({ message: "hello" }) });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /GROQ_API_KEY/);
  });

  it("503 says 'paused', not 'not configured', when configured providers are cooling down", async () => {
    const app = createApp(setup({ providers: [new FakeProvider("groq", { fail: "auth" })] }));
    const first = await app.request("/chat", { method: "POST", body: JSON.stringify({ message: "hello" }) });
    assert.match(((await first.json()) as { error: { message: string } }).error.message, /All configured providers failed/);
    const second = await app.request("/chat", { method: "POST", body: JSON.stringify({ message: "hello again" }) });
    const msg = ((await second.json()) as { error: { message: string } }).error.message;
    assert.match(msg, /temporarily paused after recent failures \(groq\)/);
    assert.doesNotMatch(msg, /Set at least one of/);
  });

  it("requires the bearer token when VEYRA_API_KEY is set", async () => {
    const app = createApp(setup({ env: { VEYRA_API_KEY: "secret" } }));
    const denied = await app.request("/chat", { method: "POST", body: JSON.stringify({ message: "hi" }) });
    assert.equal(denied.status, 401);
    const ok = await app.request("/chat", { method: "POST", body: JSON.stringify({ message: "hi" }), headers: { authorization: "Bearer secret" } });
    assert.equal(ok.status, 200);
  });

  it("streams SSE events in order (v2 default)", async () => {
    const app = createApp(setup());
    const res = await app.request("/chat", { method: "POST", body: JSON.stringify({ message: "hello there", stream: true }) });
    const text = await res.text();
    const events = [...text.matchAll(/^event: ([\w.]+)$/gm)].map((m) => m[1]);
    assert.deepEqual(events.slice(0, 4), ["request.started", "status", "intent.detected", "plan.created"]);
    assert.ok(events.indexOf("model.selected") < events.indexOf("response.delta"));
    assert.equal(events.at(-1), "response.completed");
  });

  it("legacy v1 stream format is still available", async () => {
    const app = createApp(setup());
    const res = await app.request("/chat", { method: "POST", body: JSON.stringify({ message: "hello there", stream: true, streamFormat: "v1" }) });
    const events = [...(await res.text()).matchAll(/^event: ([\w.]+)$/gm)].map((m) => m[1]);
    assert.deepEqual([events[0], events[1], events[2]], ["plan", "sources", "model"]);
    assert.equal(events.at(-1), "done");
    assert.ok(events.includes("delta"));
  });

  it("GET /health never exposes secrets", async () => {
    const app = createApp(setup({ env: { GROQ_API_KEY: "gsk_supersecret" } }));
    const text = await (await app.request("/health")).text();
    assert.ok(!text.includes("gsk_supersecret"));
  });
});
