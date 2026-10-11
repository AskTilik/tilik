import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { CONTENT_SECURITY_POLICY } from "../src/api/http-guards.js";
import { configStatus, productionProblems, rateLimitEnabled, secretValues } from "../src/config/env.js";
import { createContainer } from "../src/container.js";
import { publicErrorMessage } from "../src/core/errors.js";
import { httpRequest } from "../src/core/http.js";
import { createLogger, redactLogLine, silentLogger, type Logger } from "../src/core/logger.js";
import { BaseLLMProvider } from "../src/providers/llm/base.js";
import { ProviderRegistry } from "../src/providers/llm/registry.js";
import type { GenerateRequest, GenerateResult, StreamEvent } from "../src/providers/llm/types.js";
import { ClientRateLimiter } from "../src/security/rate-limit.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { FakeProvider, fakeTool, testEnv } from "./helpers.js";

/** A provider that streams `chunks` slowly and stops as soon as its signal aborts; records how far it got. */
class SlowProvider extends BaseLLMProvider {
  readonly label = "slow";
  emitted = 0;
  aborted = false;
  constructor(
    readonly id: string,
    private readonly chunks = 200,
    private readonly delayMs = 20,
    readonly defaultModel = "slow-model",
  ) {
    super();
  }
  isConfigured() {
    return true;
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, this.chunks * this.delayMs);
      req.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        this.aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
    return { text: "x".repeat(this.chunks), provider: this.id, model: req.model };
  }
  async *stream(req: GenerateRequest): AsyncGenerator<StreamEvent> {
    for (let i = 0; i < this.chunks; i++) {
      if (req.signal?.aborted) {
        this.aborted = true;
        throw Object.assign(new Error("aborted"), { name: "AbortError" }); // like fetch() does
      }
      await new Promise((r) => setTimeout(r, this.delayMs));
      this.emitted++;
      yield { type: "delta", text: `chunk${i} ` };
    }
    yield { type: "done" };
  }
}

function make(env: Record<string, string> = {}, opts: { providers?: BaseLLMProvider[]; tools?: ToolRegistry; logger?: Logger } = {}) {
  const providers = new ProviderRegistry();
  for (const p of opts.providers ?? [new FakeProvider("groq")]) providers.register(p);
  const container = createContainer(testEnv(env), { logger: opts.logger ?? silentLogger, providers, tools: opts.tools ?? new ToolRegistry() });
  return { app: createApp(container), container };
}
const post = (app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request("/chat", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const captureLogger = () => {
  const lines: string[] = [];
  return { lines, logger: createLogger("debug", { secrets: ["sk-or-v1-supersecretvalue0000"], write: (_l, line) => lines.push(line) }) };
};

describe("missing configuration", () => {
  it("starts without any provider and answers /chat with a clean 503", async () => {
    const { app } = make({}, { providers: [new FakeProvider("groq", { configured: false })] });
    const res = await post(app, { message: "hello" });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { message: string } };
    assert.doesNotMatch(JSON.stringify(body), /stack|\\src\\|\/src\//);
  });

  it("production 503s carry no details at all", async () => {
    const { app } = make({ NODE_ENV: "production" }, { providers: [new FakeProvider("groq", { fail: "auth" })] });
    const body = (await (await post(app, { message: "hello" })).json()) as { error: { message: string; details?: unknown } };
    assert.equal(body.error.details, undefined);
    assert.equal(body.error.message, "The AI service is temporarily unavailable. Please try again shortly.");
  });

  it("the configuration report says configured/missing, never a value", () => {
    const env = testEnv({ OPENROUTER_API_KEY: "sk-or-v1-abcdefabcdefabcdefabcdef", GITHUB_TOKEN: "ghp_123456789012345678901234567890123456" });
    const report = configStatus(env);
    const text = JSON.stringify(report);
    assert.ok(!text.includes("sk-or-v1-abcdef") && !text.includes("ghp_1234"));
    assert.equal(report.find((s) => s.name === "OpenRouter")!.status, "configured");
    assert.equal(report.find((s) => s.name === "Gemini")!.status, "missing");
  });

  it("refuses unsafe production configuration: mock LLM or CORS '*'", () => {
    assert.deepEqual(productionProblems(testEnv({ NODE_ENV: "production" })), []);
    assert.equal(productionProblems(testEnv({ NODE_ENV: "production", VEYRA_DEV_MOCK_LLM: "true" })).length, 1);
    assert.equal(productionProblems(testEnv({ NODE_ENV: "production", CORS_ORIGIN: "*" })).length, 1);
  });
});

describe("/health", () => {
  it("exposes booleans only — no keys, prefixes, env var names, models or budgets", async () => {
    const { app } = make({ GROQ_API_KEY: "gsk_supersecretsupersecret1234" });
    const body = (await (await app.request("/health")).json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["providers", "status", "tools"]);
    assert.deepEqual(body.providers, { groq: true });
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /gsk_|API_KEY|TOKEN|defaultModel|dailyBudget|requires/);
  });
});

describe("request validation and size limits", () => {
  it("malformed JSON and invalid fields are rejected without echoing input", async () => {
    const { app } = make();
    assert.equal((await post(app, "{not json")).status, 400);
    const res = await post(app, { message: 123, model: "SECRET-ECHO-CHECK" });
    assert.equal(res.status, 400);
    assert.ok(!(await res.text()).includes("SECRET-ECHO-CHECK"));
  });

  it("enforces configurable message, conversation-context and body size limits before any provider runs", async () => {
    const groq = new FakeProvider("groq");
    const { app } = make({ VEYRA_MAX_MESSAGE_CHARS: "50", VEYRA_MAX_HISTORY_CHARS: "100", VEYRA_MAX_BODY_BYTES: "2000" }, { providers: [groq] });
    assert.equal((await post(app, { message: "x".repeat(51) })).status, 400);
    assert.equal((await post(app, { message: "hi", history: [{ role: "user", content: "y".repeat(101) }] })).status, 413);
    const big = await post(app, { message: "hi", history: [{ role: "user", content: "z".repeat(3000) }] });
    assert.equal(big.status, 413);
    assert.match(big.headers.get("content-type") ?? "", /json/);
    assert.equal(groq.calls.length, 0, "no provider was called");
  });
});

describe("rate limiting", () => {
  it("returns a clean 429 with Retry-After after RATE_LIMIT_MAX_REQUESTS in a window", async () => {
    const { app } = make({ RATE_LIMIT_MAX_REQUESTS: "2", RATE_LIMIT_WINDOW_MS: "60000" });
    assert.equal((await post(app, { message: "one" })).status, 200);
    assert.equal((await post(app, { message: "two" })).status, 200);
    const third = await post(app, { message: "three" });
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get("retry-after")) >= 1);
    assert.deepEqual(await third.json(), { error: { kind: "rate_limit", message: "Too many requests. Please try again shortly." } });
    assert.equal((await app.request("/health")).status, 200, "other endpoints unaffected");
  });

  it("expensive workflows (research) have their own smaller allowance", async () => {
    const { app } = make({ RATE_LIMIT_MAX_REQUESTS: "100", RATE_LIMIT_HEAVY_MAX_REQUESTS: "1" });
    assert.equal((await post(app, { message: "hello", mode: "research" })).status, 200);
    assert.equal((await post(app, { message: "Research tokenized stocks in depth" })).status, 429);
    assert.equal((await post(app, { message: "plain question" })).status, 200, "normal questions still pass");
  });

  it("is off for local development with the mock LLM, on otherwise (and always in production)", () => {
    assert.equal(rateLimitEnabled(testEnv({ VEYRA_DEV_MOCK_LLM: "true" })), false);
    assert.equal(rateLimitEnabled(testEnv({ VEYRA_DEV_MOCK_LLM: "true", RATE_LIMIT_ENABLED: "true" })), true);
    assert.equal(rateLimitEnabled(testEnv({})), true);
    assert.equal(rateLimitEnabled(testEnv({ NODE_ENV: "production" })), true);
  });

  it("the limiter is a sliding window per client and keeps memory bounded", () => {
    let t = 0;
    const l = new ClientRateLimiter({ windowMs: 1000, now: () => t, maxKeys: 3 });
    assert.ok(l.take("chat", "a", 2).ok);
    assert.ok(l.take("chat", "a", 2).ok);
    const blocked = l.take("chat", "a", 2);
    assert.ok(!blocked.ok && blocked.retryAfterMs >= 1000);
    assert.ok(l.take("chat", "b", 2).ok, "other clients unaffected");
    t = 1001;
    assert.ok(l.take("chat", "a", 2).ok, "window slides");
    for (let i = 0; i < 10; i++) l.take("chat", `c${i}`, 2);
    assert.ok((l as unknown as { hits: Map<string, unknown> }).hits.size <= 11);
  });
});

describe("URL security", () => {
  it("never fetches localhost, private-network, metadata or non-http URLs from a message", async () => {
    const extract = fakeTool({ name: "jina", capability: "web.extract", needsUrl: true });
    const { app } = make({}, { tools: new ToolRegistry().register(extract) });
    const res = await post(app, { message: "Summarize http://169.254.169.254/latest/meta-data and http://localhost:8080/admin and http://10.0.0.5/x and http://[::1]/ and file:///etc/passwd" });
    const body = (await res.json()) as { plan: { blockedUrls: { url: string }[] } };
    assert.equal(extract.executions, 0);
    assert.ok(body.plan.blockedUrls.length >= 4, JSON.stringify(body.plan.blockedUrls));
  });

  it("redirects are re-checked: a redirect into a private network is refused before it is followed", async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:2375/containers/json" } });
    }) as typeof fetch;
    try {
      await assert.rejects(httpRequest("https://feeds.example.com/rss", { source: "test", timeoutMs: 1000 }), /Redirect blocked/);
      assert.deepEqual(seen, ["https://feeds.example.com/rss"], "the private address was never requested");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("follows ordinary public redirects, but never carries credentials to another origin", async () => {
    const original = globalThis.fetch;
    let n = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      n++;
      if (String(input).startsWith("https://a.example.com")) return new Response(null, { status: 301, headers: { location: "https://b.example.com/feed" } });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const res = await httpRequest("https://a.example.com/feed", { source: "test", timeoutMs: 1000 });
      assert.equal(await res.text(), "ok");
      await assert.rejects(httpRequest("https://a.example.com/api", { source: "test", timeoutMs: 1000, headers: { Authorization: "Bearer x" } }), /credentials refused/);
      assert.ok(n >= 3);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("timeouts, failures and fallback", () => {
  it("a hanging provider cannot hang the request: the deadline answers 504", async () => {
    const slow = new SlowProvider("groq", 1000, 50); // would take 50 s
    const { app } = make({ VEYRA_REQUEST_TIMEOUT_MS: "300" }, { providers: [slow] });
    const started = Date.now();
    const res = await post(app, { message: "hello" });
    assert.equal(res.status, 504);
    assert.ok(Date.now() - started < 5000);
    assert.equal(slow.aborted, true, "the provider call was aborted, not left running");
    assert.deepEqual(await res.json(), { error: { kind: "timeout", message: "The request took too long. Please try again." } });
  });

  it("falls back on failure, and each provider is called at most once (no loops)", async () => {
    // Primary (OpenRouter) fails → the cross-provider fallback (Gemini) answers; the primary's model is not retried.
    const openrouter = new FakeProvider("openrouter", { fail: "upstream" });
    const gemini = new FakeProvider("gemini");
    const { app } = make({}, { providers: [openrouter, gemini] });
    const body = (await (await post(app, { message: "hello" })).json()) as { model: { provider: string } };
    assert.equal(body.model.provider, "gemini");
    assert.equal(new Set(openrouter.calls.map((c) => c.model)).size, openrouter.calls.length, "no model retried");
    assert.ok(openrouter.calls.length >= 1);

    const all = ["groq", "gemini", "openrouter"].map((id) => new FakeProvider(id, { fail: "upstream" }));
    const { app: failing } = make({}, { providers: all });
    assert.equal((await post(failing, { message: "hello" })).status, 503);
    // A provider may be tried with two different models (tier model, then its default) — each model once, total bounded.
    for (const p of all) {
      const models = p.calls.map((c) => c.model);
      assert.equal(new Set(models).size, models.length, `${p.id} repeated a model: ${models.join(", ")}`);
    }
    assert.ok(all.reduce((n, p) => n + p.calls.length, 0) <= 4, "bounded by VEYRA_MAX_MODEL_ATTEMPTS (default 4)");
  });

  it("the fallback chain is capped by VEYRA_MAX_MODEL_ATTEMPTS", async () => {
    const all = ["groq", "gemini", "openrouter"].map((id) => new FakeProvider(id, { fail: "upstream" }));
    const { app } = make({ VEYRA_MAX_MODEL_ATTEMPTS: "2" }, { providers: all });
    await post(app, { message: "hello" });
    assert.equal(all.reduce((n, p) => n + p.calls.length, 0), 2);
  });

  it("a single request has a hard tool budget, including fallbacks", async () => {
    const a = fakeTool({ name: "tavily", capability: "web.search", fail: "upstream" });
    const b = fakeTool({ name: "exa", capability: "web.search", fail: "upstream" });
    const { app } = make({ VEYRA_MAX_TOOL_CALLS_PER_REQUEST: "1" }, { tools: new ToolRegistry().register(a).register(b) });
    const body = (await (await post(app, { message: "search for the latest robotics news" })).json()) as { toolRuns: { error?: { kind: string } }[] };
    assert.equal(a.executions + b.executions, 1);
    assert.ok(body.toolRuns.some((r) => r.error?.kind === "budget"));
  });
});

describe("streaming (SSE)", () => {
  it("a client that disconnects stops the work (the model stream is aborted)", async () => {
    const slow = new SlowProvider("groq", 400, 15); // ~6 s if left running
    const { app } = make({}, { providers: [slow] });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      const ctrl = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/chat`, { method: "POST", body: JSON.stringify({ message: "hello", stream: true }), headers: { "content-type": "application/json" }, signal: ctrl.signal });
      const reader = res.body!.getReader();
      let text = "";
      while (!text.includes("response.delta")) text += new TextDecoder().decode((await reader.read()).value);
      ctrl.abort();
      await new Promise((r) => setTimeout(r, 400));
      const at = slow.emitted;
      await new Promise((r) => setTimeout(r, 400));
      assert.ok(slow.emitted < 400, "did not run to completion");
      assert.ok(slow.emitted - at <= 1, `kept generating after disconnect (${at} → ${slow.emitted})`);
    } finally {
      server.close();
    }
  });

  it("a stream cannot stay open forever: the request deadline ends it with a sanitized error event", async () => {
    const slow = new SlowProvider("groq", 1000, 20);
    const { app } = make({ VEYRA_REQUEST_TIMEOUT_MS: "300" }, { providers: [slow] });
    const started = Date.now();
    const text = await (await post(app, { message: "hello", stream: true })).text();
    assert.ok(Date.now() - started < 5000);
    assert.match(text, /event: error\ndata: \{"error":\{"kind":"timeout","message":"The request took too long\. Please try again\."\}\}/);
    assert.doesNotMatch(text, /stack|at .*\.ts/);
  });

  it("streamed output is capped (VEYRA_MAX_STREAM_CHARS) and ends cleanly", async () => {
    const slow = new SlowProvider("groq", 300, 0);
    const { app } = make({ VEYRA_MAX_STREAM_CHARS: "60" }, { providers: [slow] });
    const text = await (await post(app, { message: "hello", stream: true })).text();
    const done = JSON.parse(text.split("event: response.completed\ndata: ")[1]!.split("\n")[0]!) as { response: { answer: string; warnings: string[] } };
    assert.ok(done.response.answer.length < 200, String(done.response.answer.length));
    assert.match(done.response.answer, /cut off/);
    assert.ok(done.response.warnings.some((w) => /60-character limit/.test(w)));
    assert.ok(slow.emitted < 300, "the model stream was stopped");
  });
});

describe("secrets and error sanitization", () => {
  it("log lines are scrubbed of env secret values, key formats, bearer tokens and key query params", () => {
    const line = redactLogLine(
      JSON.stringify({ a: "sk-or-v1-supersecretvalue0000", b: "Authorization: Bearer abc.def.ghi123", c: "https://rpc.example/v2?apikey=abcdef123456", d: "gsk_abcdefghijklmnopqrstuvwxyz" }),
      ["sk-or-v1-supersecretvalue0000"],
    );
    assert.doesNotMatch(line, /supersecretvalue|abc\.def\.ghi123|abcdef123456|gsk_abcdef/);
  });

  it("RPC URLs with embedded keys are treated as secrets", () => {
    const values = secretValues(testEnv({ ROBINHOOD_RPC_URL: "https://robinhood-mainnet.g.alchemy.com/v2/AbCdEf0123456789XyZ0123", GROQ_API_KEY: "gsk_1234567890abcdefghijkl" }));
    assert.ok(values.includes("AbCdEf0123456789XyZ0123"));
    assert.ok(values.includes("gsk_1234567890abcdefghijkl"));
  });

  it("access logs carry request id, endpoint, status and latency — never headers, IPs or conversation ids", async () => {
    const { lines, logger } = captureLogger();
    const { app } = make({ VEYRA_API_KEY: "veyra-bearer-secret-123" }, { logger });
    const res = await post(app, { message: "hello" }, { authorization: "Bearer veyra-bearer-secret-123" });
    assert.ok(res.headers.get("x-request-id"));
    await app.request("/chat/3f2c9a1e5b7d4e8a9c0f");
    const access = lines.filter((l) => l.includes('"http.request"')).map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.ok(access.some((a) => a.endpoint === "/chat" && a.status === 200 && typeof a.ms === "number" && a.requestId === res.headers.get("x-request-id")));
    assert.ok(access.some((a) => a.endpoint === "/chat/:id"));
    const all = lines.join("\n");
    assert.doesNotMatch(all, /veyra-bearer-secret-123|3f2c9a1e5b7d4e8a9c0f|authorization/i);
    assert.ok(lines.some((l) => l.includes('"intent.detected"') && l.includes(res.headers.get("x-request-id")!)), "pipeline logs share the request id");
  });

  it("unexpected errors return a generic 500: no stack, paths or keys", async () => {
    const { app } = make();
    app.get("/boom", () => {
      throw new Error("failed at C:\\name\\src\\secret.ts with key sk-or-v1-0123456789abcdef0123456789");
    });
    const res = await app.request("/boom");
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: { kind: "internal", message: "Internal error" } });
  });

  it("public error messages lose paths, query strings and network internals", () => {
    const m = publicErrorMessage("Network error: getaddrinfo ENOTFOUND rpc.internal.corp at C:\\app\\x.ts /home/deploy/.env https://api.x.io/v1?key=SECRET123 sk-or-v1-0123456789abcdef0123456789");
    assert.doesNotMatch(m, /rpc\.internal|C:\\app|\/home\/deploy|SECRET123|sk-or-v1-0123/);
  });
});

describe("CORS and security headers", () => {
  const preflight = (app: ReturnType<typeof createApp>, origin: string) =>
    app.request("/chat", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });

  it("development allows localhost origins only", async () => {
    const { app } = make();
    assert.equal((await preflight(app, "http://localhost:3000")).headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.equal((await preflight(app, "https://evil.example")).headers.get("access-control-allow-origin"), null);
  });

  it("production uses the explicit allow-list (CORS_ORIGIN) and nothing else", async () => {
    const { app } = make({ NODE_ENV: "production", CORS_ORIGIN: "https://veyra.example" });
    assert.equal((await preflight(app, "https://veyra.example")).headers.get("access-control-allow-origin"), "https://veyra.example");
    assert.equal((await preflight(app, "http://localhost:3000")).headers.get("access-control-allow-origin"), null);
    assert.equal((await preflight(app, "https://evil.example")).headers.get("access-control-allow-origin"), null);
  });

  it("every response carries security headers; the page CSP allows only its own scripts", async () => {
    const { app } = make();
    for (const path of ["/", "/health", "/nope"]) {
      const h = (await app.request(path)).headers;
      assert.equal(h.get("content-security-policy"), CONTENT_SECURITY_POLICY, path);
      assert.equal(h.get("x-content-type-options"), "nosniff");
      assert.equal(h.get("x-frame-options"), "DENY");
      assert.equal(h.get("referrer-policy"), "strict-origin-when-cross-origin");
      assert.match(h.get("permissions-policy") ?? "", /camera=\(\)/);
      assert.equal(h.get("strict-transport-security"), null, "no HSTS outside production");
    }
    assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'(;|$)/);
    assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
    const prod = make({ NODE_ENV: "production" }).app;
    assert.match((await prod.request("/health")).headers.get("strict-transport-security") ?? "", /max-age=/);
  });

  it("API responses are never cached", async () => {
    const { app } = make();
    assert.equal((await post(app, { message: "hello" })).headers.get("cache-control"), "no-store");
  });
});
