import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { createContainer } from "../src/container.js";
import { silentLogger } from "../src/core/logger.js";
import { createExaTool } from "../src/providers/search/exa.js";
import { createTavilyTool } from "../src/providers/search/tavily.js";
import { ProviderRegistry } from "../src/providers/llm/registry.js";
import { checkCitations } from "../src/sources/citations.js";
import { collectSources } from "../src/sources/collector.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { ChatRequestSchema } from "../src/types/api.js";
import { FakeProvider, fakeTool, hang, jsonResponse, mockFetch, testEnv } from "./helpers.js";

const TAVILY = "https://api.tavily.com/search";
const EXA = "https://api.exa.ai/search";
const KEYS = { TAVILY_API_KEY: "tvly-test", EXA_API_KEY: "exa-test", VEYRA_RESEARCH_PLANNER: "rules" };

const tavilyResults = (...items: { url: string; title?: string; content?: string; date?: string; score?: number }[]) => ({
  query: "q",
  results: items.map((i) => ({
    url: i.url,
    title: i.title ?? `Tavily ${i.url}`,
    content: i.content ?? `Tavily snippet for ${i.url}`,
    score: i.score ?? 0.9,
    ...(i.date ? { published_date: i.date } : {}),
  })),
});

const exaResults = (...items: { url: string; title?: string; highlight?: string; text?: string; date?: string }[]) => ({
  requestId: "r",
  results: items.map((i) => ({
    id: i.url,
    url: i.url,
    title: i.title ?? `Exa ${i.url}`,
    publishedDate: i.date ?? null,
    highlights: [i.highlight ?? `Exa highlight for ${i.url}`],
    ...(i.text ? { text: i.text } : {}),
  })),
});

let net: ReturnType<typeof mockFetch> | undefined;
afterEach(() => net?.restore());

function setup(env: Record<string, string> = {}, opts: { llm?: FakeProvider; extraTools?: Parameters<typeof createToolRegistry>[1] } = {}) {
  const llm = opts.llm ?? new FakeProvider("groq");
  const providers = new ProviderRegistry().register(llm);
  const e = testEnv({ ...KEYS, ...env });
  const tools = createToolRegistry(e, [createTavilyTool, createExaTool, ...(opts.extraTools ?? [])]);
  const container = createContainer(e, { logger: silentLogger, providers, tools });
  const ask = (message: string, extra: Record<string, unknown> = {}) =>
    container.engine.ask(ChatRequestSchema.parse({ message, ...extra }), new AbortController().signal);
  return { container, llm, ask };
}

const called = (host: "tavily" | "exa") => net!.calls.filter((c) => c.url === (host === "tavily" ? TAVILY : EXA));

describe("web search routing", () => {
  it("uses no external tool for a question that needs none", async () => {
    net = mockFetch(() => jsonResponse({}));
    const { ask } = setup();
    const res = await ask("What is 2+2?");
    assert.equal(net.calls.length, 0);
    assert.equal(res.type, "normal");
    assert.deepEqual(res.toolRuns, []);
  });

  it("news → Tavily only, with news topic, day window, and published dates", async () => {
    net = mockFetch((url) =>
      url === TAVILY ? jsonResponse(tavilyResults({ url: "https://news.example.com/ai?utm_source=x", date: "Mon, 05 Oct 2026 10:00:00 GMT" })) : jsonResponse({}, 500),
    );
    const { ask, llm } = setup();
    const res = await ask("What happened in AI today?");

    assert.equal(called("exa").length, 0, "one provider is enough");
    const [call] = called("tavily");
    assert.equal(call?.headers.authorization, "Bearer tvly-test");
    assert.equal(call?.body.topic, "news");
    assert.equal(call?.body.time_range, "day");
    assert.equal(call?.body.search_depth, "basic");
    assert.equal(call?.body.include_published_date, true);
    assert.equal(call?.body.include_answer, false);

    const s = res.sources[0]!;
    assert.equal(s.domain, "news.example.com");
    assert.equal(s.type, "news");
    assert.equal(s.evidence, "search_result");
    assert.equal(s.publishedAt, "2026-10-05T10:00:00.000Z");
    assert.match(s.snippet ?? "", /Tavily snippet/);
    assert.equal(res.grounded, true);
    // The model receives the normalized source, not Tavily's raw format.
    const prompt = llm.calls[0]!.messages.at(-1)!.content;
    assert.match(prompt, /<<<SOURCE 1 [0-9a-f]{12}>>>\nTitle: Tavily https:\/\/news\.example\.com/);
    assert.ok(!prompt.includes("published_date"));
  });

  it("semantic query → Exa first, with domain filter and highlights only", async () => {
    net = mockFetch((url) => (url === EXA ? jsonResponse(exaResults({ url: "https://arxiv.org/abs/1", date: "2026-09-01T00:00:00.000Z" })) : jsonResponse({}, 500)));
    const { ask } = setup();
    const res = await ask("search for papers comparing retrieval augmented generation approaches site:arxiv.org");

    assert.equal(called("tavily").length, 0);
    const [call] = called("exa");
    assert.equal(call?.headers["x-api-key"], "exa-test");
    assert.equal(call?.body.type, "auto");
    assert.deepEqual(call?.body.includeDomains, ["arxiv.org"]);
    assert.ok(!call?.body.query.includes("site:"));
    assert.ok(call?.body.contents.highlights);
    assert.equal(call?.body.contents.text, undefined, "no full text outside research mode");
    assert.equal(res.sources[0]?.type, "research");
    assert.match(res.sources[0]?.snippet ?? "", /Exa highlight/);
  });

  it("Exa maps recency to startPublishedDate and news category", async () => {
    net = mockFetch((url) => (url === TAVILY ? jsonResponse({}, 503) : jsonResponse(exaResults({ url: "https://e.com/a" }))));
    const { ask } = setup();
    await ask("latest news about open source LLMs this week");
    const [call] = called("exa");
    assert.equal(call?.body.category, "news");
    const start = Date.parse(call?.body.startPublishedDate);
    assert.ok(Date.now() - start > 6 * 86_400_000 && Date.now() - start < 8 * 86_400_000);
  });

  it("GitHub question → web search only as a fallback while no GitHub tool exists", async () => {
    net = mockFetch(() => jsonResponse(tavilyResults({ url: "https://github.com/honojs/hono" })));
    const { ask } = setup();
    const res = await ask("What is this GitHub repository? https://github.com/honojs/hono");
    assert.match(res.plan.unavailable.find((u) => u.capability === "github.repo")?.reason ?? "", /using web\.search as a fallback/);
    assert.equal(res.plan.tools[0]?.capability, "web.search");
    assert.equal(res.sources[0]?.type, "github");
  });

  it("GitHub question with a GitHub tool → no web search", async () => {
    net = mockFetch(() => jsonResponse({}));
    const { ask } = setup({}, { extraTools: [() => fakeTool({ name: "github", capability: "github.repo" })] });
    const res = await ask("What is this GitHub repository? https://github.com/honojs/hono");
    assert.equal(net.calls.length, 0);
    assert.deepEqual(res.plan.tools.map((t) => t.capability), ["github.repo"]);
  });

  it("Robinhood Chain with a chain tool → chain data is primary, web search skipped", async () => {
    net = mockFetch(() => jsonResponse({}));
    const { ask } = setup({}, { extraTools: [() => fakeTool({ name: "rh-rpc", capability: "chain.data" })] });
    const res = await ask("What happened on Robinhood Chain today?");
    assert.equal(net.calls.length, 0);
    assert.ok(res.plan.tools.some((t) => t.capability === "chain.data"));
    assert.ok(!res.plan.tools.some((t) => t.capability === "web.search"));
    assert.ok(res.plan.skipped.some((s) => s.capability === "web.search" && /chain\.data is the primary source/.test(s.reason)));
  });

  it("Robinhood Chain without a chain tool → web search fills in, chain data reported missing", async () => {
    net = mockFetch(() => jsonResponse(tavilyResults({ url: "https://news.example.com/rh" })));
    const { ask } = setup();
    const res = await ask("What happened on Robinhood Chain today?");
    assert.ok(res.plan.tools.some((t) => t.capability === "web.search"));
    assert.ok(res.warnings.some((w) => w.includes("chain.data")));
    assert.equal(net.calls.length, 1);
  });
});

describe("research mode", () => {
  it("main query uses both providers; same URL is merged, not duplicated", async () => {
    net = mockFetch((url) =>
      url === TAVILY
        ? jsonResponse(tavilyResults({ url: "https://www.shared.com/report/" }, { url: "https://t-only.com/x" }))
        : jsonResponse(exaResults({ url: "https://shared.com/report", text: "Full report text. ".repeat(50) }, { url: "https://e-only.com/y" })),
    );
    const { ask } = setup({ VEYRA_RESEARCH_MAX_QUERIES: "1" });
    const res = await ask("Research the latest developments around tokenized assets");

    assert.equal(res.type, "research");
    assert.equal(res.plan.tier, "reasoning");
    assert.equal(res.plan.tools[0]?.strategy, "all");
    assert.equal(called("tavily")[0]?.body.search_depth, "advanced");
    assert.ok(called("exa")[0]?.body.contents.text, "research fetches page text");
    assert.equal(res.retrieval.resultsFound, 4);
    assert.equal(res.retrieval.duplicatesRemoved, 1);
    assert.equal(res.sources.length, 3);
    const shared = res.sources.find((s) => s.domain === "shared.com")!;
    assert.equal(shared.evidence, "retrieved_content", "the richer copy wins");
    assert.ok(shared.provider === "exa" && shared.alsoFoundBy?.includes("tavily"));
  });

  it("plans bounded sub-queries and spreads them across providers", async () => {
    let n = 0;
    net = mockFetch((url) => jsonResponse(url === TAVILY ? tavilyResults({ url: `https://t.com/${n++}` }) : exaResults({ url: `https://e.com/${n++}` })));
    const { ask } = setup({ VEYRA_RESEARCH_MAX_QUERIES: "3", VEYRA_RESEARCH_MAX_SOURCES: "3" });
    const res = await ask("Deep research this company: Robinhood Markets");

    assert.equal(res.plan.searchQueries?.method, "rules");
    assert.deepEqual(res.plan.searchQueries?.queries, [
      "Deep research this company: Robinhood Markets",
      "Robinhood Markets latest developments",
      "Robinhood Markets risks and criticism",
    ]);
    assert.deepEqual(res.plan.tools.map((t) => t.strategy), ["all", "first", "first"]);
    assert.equal(net.calls.length, 4, "2 for the main query + 1 per sub-query");
    assert.notEqual(res.plan.tools[1]?.candidates[0], res.plan.tools[2]?.candidates[0], "sub-queries alternate providers");
    assert.equal(res.sources.length, 3);
    assert.equal(res.retrieval.droppedByLimit, 1);
  });

  it("uses the cheap model to plan queries when VEYRA_RESEARCH_PLANNER=llm", async () => {
    net = mockFetch((url) => jsonResponse(url === TAVILY ? tavilyResults({ url: "https://t.com/a" }) : exaResults({ url: "https://e.com/b" })));
    const llm = new FakeProvider("groq", { reply: '{"queries":["Robinhood Markets business model","Robinhood Markets 2026 news"]}' });
    const { ask } = setup({ VEYRA_RESEARCH_PLANNER: "llm" }, { llm });
    const res = await ask("Deep research this company: Robinhood Markets");
    assert.equal(res.plan.searchQueries?.method, "llm");
    assert.deepEqual(res.plan.searchQueries?.queries, ["Robinhood Markets business model", "Robinhood Markets 2026 news"]);
    assert.equal(llm.calls[0]?.model, "openai/gpt-oss-20b", "planning runs on the cheap tier (Groq's cheap model)");
  });
});

describe("fallback and failure handling", () => {
  it("Exa fails → Tavily answers", async () => {
    net = mockFetch((url) => (url === EXA ? jsonResponse({ error: "boom" }, 500) : jsonResponse(tavilyResults({ url: "https://t.com/a" }))));
    const { ask } = setup();
    const res = await ask("search for papers about protein folding");
    assert.deepEqual(res.toolRuns.map((r) => [r.tool, r.status, r.error?.kind]), [["exa", "error", "upstream"], ["tavily", "ok", undefined]]);
    assert.equal(res.grounded, true);
  });

  it("Tavily out of credits (432) → Exa answers", async () => {
    net = mockFetch((url) => (url === TAVILY ? jsonResponse({ detail: "plan limit" }, 432) : jsonResponse(exaResults({ url: "https://e.com/a" }))));
    const { ask } = setup();
    const res = await ask("What happened in AI today?");
    assert.equal(res.toolRuns[0]?.error?.kind, "quota");
    assert.equal(res.toolRuns[1]?.tool, "exa");
    assert.equal(res.sources.length, 1);
  });

  it("both fail → degraded but successful response that says so", async () => {
    net = mockFetch(() => jsonResponse({ error: "down" }, 503));
    const { container, llm } = setup();
    const res = await createApp(container).request("/chat", { method: "POST", body: JSON.stringify({ message: "What happened in AI today?" }) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { grounded: boolean; warnings: string[]; sources: unknown[] };
    assert.equal(body.grounded, false);
    assert.deepEqual(body.sources, []);
    assert.ok(body.warnings.some((w) => /web\.search: all tools failed: tavily \(upstream\), exa \(upstream\)/.test(w)));
    assert.match(llm.calls[0]!.messages[0]!.content, /LIVE DATA UNAVAILABLE[\s\S]*web\.search/);
  });

  it("timeout → classified as timeout (not a cancellation) and falls back", async () => {
    net = mockFetch((url, _b, init) => (url === TAVILY ? hang(init) : jsonResponse(exaResults({ url: "https://e.com/a" }))));
    const { ask } = setup({ VEYRA_TOOL_TIMEOUT_MS: "50" });
    const res = await ask("What happened in AI today?");
    assert.equal(res.toolRuns.find((r) => r.tool === "tavily")?.error?.kind, "timeout");
    assert.equal(res.toolRuns.find((r) => r.tool === "exa")?.status, "ok");
  });

  it("missing API keys → reported, never called", async () => {
    net = mockFetch(() => jsonResponse({}));
    const { ask } = setup({ TAVILY_API_KEY: "", EXA_API_KEY: "" });
    const res = await ask("What happened in AI today?");
    assert.equal(net.calls.length, 0);
    assert.match(res.plan.unavailable[0]?.reason ?? "", /TAVILY_API_KEY or EXA_API_KEY/);
    assert.equal(res.grounded, false);
  });

  it("only one key set → that provider is used alone", async () => {
    net = mockFetch(() => jsonResponse(exaResults({ url: "https://e.com/a" })));
    const { ask } = setup({ TAVILY_API_KEY: "" });
    const res = await ask("What happened in AI today?");
    assert.deepEqual(res.plan.tools[0]?.candidates, ["exa"]);
    assert.equal(called("exa").length, 1);
  });
});

describe("cost control", () => {
  it("caches identical searches", async () => {
    net = mockFetch(() => jsonResponse(tavilyResults({ url: "https://t.com/a" })));
    const { ask } = setup();
    await ask("What happened in AI today?");
    const second = await ask("What happened in AI today?");
    assert.equal(net.calls.length, 1);
    assert.equal(second.toolRuns[0]?.cached, true);
  });

  it("enforces per-tool daily limits, then falls back", async () => {
    net = mockFetch((url) => jsonResponse(url === TAVILY ? tavilyResults({ url: "https://t.com/a" }) : exaResults({ url: "https://e.com/a" })));
    const { ask } = setup({ TAVILY_DAILY_REQUEST_LIMIT: "1" });
    await ask("What happened in AI today?");
    const second = await ask("What happened in crypto today?");
    assert.equal(second.toolRuns[0]?.error?.kind, "budget");
    assert.equal(second.toolRuns[1]?.tool, "exa");
  });

  it("respects VEYRA_SEARCH_MAX_RESULTS", async () => {
    net = mockFetch(() => jsonResponse(tavilyResults({ url: "https://t.com/a" })));
    const { ask } = setup({ VEYRA_SEARCH_MAX_RESULTS: "3" });
    await ask("What happened in AI today?");
    assert.equal(called("tavily")[0]?.body.max_results, 3);
  });
});

describe("dev mock mode", () => {
  it("runs the full web pipeline without LLM keys, clearly labelled", async () => {
    net = mockFetch(() => jsonResponse(tavilyResults({ url: "https://t.com/a", title: "AI headline" })));
    const e = testEnv({ ...KEYS, VEYRA_DEV_MOCK_LLM: "true" });
    const { engine } = createContainer(e, { logger: silentLogger }); // real provider registry: no LLM keys → only the mock
    const res = await engine.ask(ChatRequestSchema.parse({ message: "What happened in AI today?" }), new AbortController().signal);
    assert.equal(res.model.provider, "dev-mock");
    assert.match(res.answer, /^\[DEV MOCK/);
    assert.match(res.answer, /AI headline \[1\]/);
    assert.deepEqual(res.citations.used, [1]);
    assert.ok(res.warnings.some((w) => w.includes("DEVELOPMENT MOCK")));
  });
});

describe("source dedupe", () => {
  it("collapses near-identical content published under different URLs", () => {
    const body = "Robinhood launched tokenized stock trading for European customers on its own layer two network built on Arbitrum technology today.";
    const { sources, duplicatesRemoved } = collectSources(
      [
        { provider: "tavily", sources: [{ title: "Story A", url: "https://a.com/1", type: "news", evidence: "search_result", snippet: body, relevance: 0.6 }] },
        { provider: "exa", sources: [{ title: "Story B", url: "https://b.com/2", type: "news", evidence: "search_result", snippet: `${body} More.`, relevance: 0.9 }] },
      ],
      { maxContextChars: 5000 },
    );
    assert.equal(duplicatesRemoved, 1);
    assert.equal(sources[0]?.url, "https://b.com/2");
    assert.deepEqual(sources[0]?.alsoFoundBy, ["tavily"]);
  });

  it("keeps genuinely different short results", () => {
    const { sources } = collectSources(
      [{ provider: "exa", sources: [
        { title: "One", url: "https://a.com/1", type: "web", evidence: "search_result", snippet: "short" },
        { title: "Two", url: "https://a.com/2", type: "web", evidence: "search_result", snippet: "short" },
      ] }],
      { maxContextChars: 5000 },
    );
    assert.equal(sources.length, 2);
  });
});

describe("citations", () => {
  const sources = [{ id: 1 }, { id: 2 }];

  it("strips citations to non-existent sources and maps statements", () => {
    const r = checkCitations("Robinhood runs an L2 [1]. It launched in 2025 [2, 7]. Pure speculation [9].\nAnalysis: likely growth.", sources);
    assert.equal(r.answer, "Robinhood runs an L2 [1]. It launched in 2025 [2]. Pure speculation.\nAnalysis: likely growth.");
    assert.deepEqual(r.used, [1, 2]);
    assert.deepEqual(r.invalid.sort(), [7, 9]);
    assert.deepEqual(r.statements, [
      { text: "Robinhood runs an L2.", sourceIds: [1] },
      { text: "It launched in 2025.", sourceIds: [2] },
    ]);
  });

  it("leaves answers without citations untouched", () => {
    const text = "2 + 2 = 4 . Done";
    assert.equal(checkCitations(text, []).answer, text);
  });

  it("ignores markdown links", () => {
    assert.deepEqual(checkCitations("See [1](https://x.com).", sources).used, []);
  });

  it("recognizes gpt-oss style citations (【1】, 【1†source】, 【1, 2】, ［1］, [1†L3-L7]) as [n]", () => {
    const r = checkCitations("USDG trades at $1.00【1】. Liquidity is deep【2†source】. Both agree【1, 2】. Full-width［1］. Lines [2†L3-L7].", sources);
    assert.equal(r.answer, "USDG trades at $1.00[1]. Liquidity is deep[2]. Both agree[1, 2]. Full-width[1]. Lines [2].");
    assert.deepEqual(r.used, [1, 2]);
    assert.deepEqual(r.invalid, []);
  });

  it("alternative forms get the same verification: no source → removed, never a fake citation", () => {
    const r = checkCitations("Real【1】. Invented【8】. Mixed【2, 9†source】.", sources);
    assert.equal(r.answer, "Real[1]. Invented. Mixed[2].");
    assert.deepEqual(r.used, [1, 2]);
    assert.deepEqual(r.invalid.sort(), [8, 9]);
  });

  it("does not touch bracketed text that is not a citation", () => {
    const text = "Use 【note】 and [x] and 【】 as written; see [1](https://x.com).";
    assert.equal(checkCitations(text, sources).answer, text);
  });
});
