# TILIK — Core Intelligence Engine

> Ask anything. Intelligence from everywhere.

The backend for TILIK: one `/chat` endpoint that decides **what a question needs**, fetches only that, and answers with sources.

```
USER → TILIK INTELLIGENCE ROUTER → understand intent → select model → select tools → collect data
     → verify / normalize / rank → reason → answer + sources + citations + structured data
```

**Status:** Phases 1–10 are complete:
- core engine, LLM providers, tool abstraction;
- web search (Tavily + Exa), research mode, verified citations;
- page extraction (Jina + Firecrawl) with URL and prompt-injection protection;
- GitHub repository intelligence;
- RSS/news intelligence;
- **Robinhood Chain on-chain intelligence**;
- **GeckoTerminal market intelligence**;
- **the unified ask-anything router** (see [The intelligence router](#the-intelligence-router-phase-10)).

Next: Phase 11 (landing page + chat UI).

Whenever a data source can't be reached, the answer says so, and it comes back with `grounded: false` rather than invented data.

---

## Tech stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Node.js ≥ 20.12** (built-in `fetch`, `AbortSignal.any`, `process.loadEnvFile`) | No HTTP-client or dotenv dependencies |
| Language | **TypeScript** (strict) | Shared types for providers, tools, API |
| HTTP | **Hono** + `@hono/node-server` | Tiny, Web-standard; the same code can later run on edge or inside Next.js |
| Validation | **Zod 4** | Request validation, tool I/O schemas, JSON Schema for `structuredGenerate()` |
| Tests | `node:test` via `tsx` | No test framework dependency |

Runtime dependencies: `hono`, `@hono/node-server`, `zod`. That's it.

---

## Folder structure

```
src/
  index.ts                 Entry point: loads .env, starts the server
  app.ts                   Hono app: auth, CORS, body limit, routes
  container.ts             Composition root — the only place concrete providers/tools are wired
  api/                     HTTP layer (no business logic)
    chat.ts                POST /chat (JSON or SSE stream)
    system.ts              GET /health, GET /models
    errors.ts              Error → HTTP mapping (never leaks internals)
  core/
    engine.ts              The pipeline orchestrator (VeyraEngine)
    prompts.ts             System prompt + anti-fabrication rules + source formatting
    context-builder.ts     Rank (relevance × authority × freshness), diversity, budget → model context
    claims.ts              FACT / INFERENCE / UNKNOWN classification of the answer
    events.ts              Streaming event contract + async event queue
    errors.ts              VeyraError + error kinds (rate_limit, quota, auth, …)
    http.ts                fetch with timeout/cancel + status → error mapping
    sse.ts                 SSE parser for provider streams
    guards.ts              DailyBudget, Cooldowns, RateLimiter
    logger.ts              JSON line logger
  config/
    env.ts                 Validated environment (single source of config)
    chains.ts              EVM network config (official Robinhood Chain defaults) + explorer link builder
    routing.ts             Model tiers, intent → tier map (overridable via JSON)
  providers/
    llm/
      types.ts             LLMProvider interface
      base.ts              structuredGenerate() for all providers (JSON + schema + repair)
      openai-compatible.ts Shared OpenAI-style client
      openrouter.ts        OpenRouter
      groq.ts              Groq
      gemini.ts            Gemini (native REST API)
      dev-mock.ts          DEVELOPMENT MOCK (opt-in, clearly labelled)
      registry.ts          Provider registry
    search/
      common.ts            Shared web-search input, normalized WebResult, query → filters
      tavily.ts            Tavily tool (web.search)
      exa.ts               Exa tool (web.search)
    web/
      common.ts            Shared extraction input, normalized ExtractedPage, boundary truncation
      jina.ts              Jina Reader tool (web.extract)
      firecrawl.ts         Firecrawl tool (web.extract)
    github/
      client.ts            GitHub REST client: token/anonymous, rate-limit tracking, per-endpoint cache, ranged raw reads
      plan.ts              Question → which GitHub endpoints are needed (deterministic, free)
      files.ts             Tree summary, config/entry-point picking, relevance search by path, sensitive-file guard
      tool.ts              GitHub tool (github.repo): fetches, limits, normalizes into sources
    news/
      parser.ts            Dependency-free RSS 2.0 / RSS 1.0 (RDF) / Atom parser (tolerant of malformed feeds)
      store.ts             Feed corpus: refresh interval, ETag/304, size caps, per-feed backoff, stale fallback
      search.ts            Question → mode/subject/window; freshness filter, dedupe, story clustering
      tool.ts              RSS tool (news.feed)
    blockchain/
      types.ts             BlockchainProvider interface (chain-agnostic EVM)
      rpc.ts               JSON-RPC client (retry/backoff, failover, caps, cache) + EvmRpcProvider
      explorer.ts          Blockscout v2 API client (history, labels, holders, stats)
      evm.ts, keccak.ts    Address/hash validation (EIP-55), units, ERC-20 ABI, event/function signatures
      analysis.ts          Bounded workflows: transaction, address/contract/token, block, network
      tool.ts              Robinhood Chain tool (chain.data)
    market/
      geckoterminal.ts     GeckoTerminal client: rate limiter, cache per data class, dedupe, retry, stale fallback
      analysis.ts          Market query planning, strict validation, token/pool/symbol/overview workflows
      tool.ts              GeckoTerminal tool (market.data)
  research/
    planner.ts             Research query planning (bounded, single pass)
    extraction.ts          Picks which search results to read in full (single follow-up pass)
  security/
    url-guard.ts           Blocks private/internal/credentialed/odd-port/binary URLs; blocked domains
    untrusted.ts           Sanitizes web content; redacts and flags prompt-injection text
    output-guard.ts        Redacts secrets/credentials/system-prompt canary; removes unverified links
    credentials.ts         Credential/private-key/secret-assignment patterns (answers and retrieved content)
  router/
    intent.ts              Rule-based intent + entity extraction (zero cost)
    model-router.ts        Tier selection, candidate ordering, fallback, budget, cache
    tool-router.ts         Intent → capabilities → minimal tool plan
    unified.ts             Unified intents, plan explanation (why/phase/dependsOn), response types
  tools/
    types.ts               Tool interface
    registry.ts            Tool registry (+ TOOL_FACTORIES list for new tools)
    runner.ts              Executes plans: parallel steps, fallbacks, timeouts, cache, rate limits
  sources/
    types.ts               Source metadata model
    collector.ts           URL normalization, URL + near-duplicate dedupe, numbering, context budgeting
    citations.ts           Verifies [n] citations, strips invented ones, maps statements → sources
  cache/ttl-cache.ts       In-memory TTL/LRU cache
  types/api.ts             Request/response contract
test/                      Unit + HTTP tests (test doubles live in test/helpers.ts)
```

**Separation:** `api/` knows HTTP only. `core/engine.ts` knows the pipeline only. Providers and tools only know their upstream API. Routers decide; they never call HTTP themselves.

---

## Run locally

```bash
npm install
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
# Add at least one of GROQ_API_KEY, GEMINI_API_KEY or OPENROUTER_API_KEY
npm run dev                   # http://127.0.0.1:8787 with auto-reload
```

Other scripts:

```bash
npm test            # 310 tests, no API keys or network needed (external APIs and RPC are mocked at fetch level)
npx tsx scripts/check-feeds.ts   # live check: fetch and parse every configured RSS feed once
npm run typecheck
npm run build && npm start    # production build to dist/
```

No keys yet? Set `VEYRA_DEV_MOCK_LLM=true` to exercise the full pipeline. Every mock answer starts with `[DEV MOCK — not a real model response]`, and the response carries a warning.

Free keys: Groq (console.groq.com) and Gemini (aistudio.google.com) both have free tiers. They're the default for everyday traffic.

---

## Web intelligence (Phase 4): Tavily + Exa

### Getting API keys

| Provider | Where | Free allowance | Env var |
|---|---|---|---|
| **Tavily** | Sign up at [app.tavily.com](https://app.tavily.com). The key (`tvly-…`) is on the dashboard. | 1,000 credits/month (basic search = 1 credit, advanced = 2) | `TAVILY_API_KEY` |
| **Exa** | Sign up at [dashboard.exa.ai](https://dashboard.exa.ai), then go to **API Keys**. | Free starter credits; pay-as-you-go after | `EXA_API_KEY` |

One key is enough, since either provider can serve every web search alone. With both keys set, each provider is the fallback for the other.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TAVILY_DAILY_REQUEST_LIMIT` / `EXA_DAILY_REQUEST_LIMIT` | 30 / 30 | Upstream calls per UTC day (cache hits are free). After the limit, the other provider takes over. |
| `VEYRA_SEARCH_MAX_RESULTS` | 5 | Results per search call |
| `VEYRA_SEARCH_CACHE_TTL_SECONDS` | 900 | Identical searches within this window cost nothing |
| `VEYRA_MAX_SOURCES` | 8 | Sources passed to the model for a normal web answer |
| `VEYRA_RESEARCH_MAX_QUERIES` | 3 | Search queries per research request |
| `VEYRA_RESEARCH_MAX_SOURCES` | 12 | Sources passed to the model in research mode |
| `VEYRA_RESEARCH_PLANNER` | `llm` | `llm`: a cheap-tier model writes the sub-queries (one extra free-tier call). `rules`: deterministic, no model call. |
| `VEYRA_TOOL_TIMEOUT_MS` | 15000 | Per-call timeout. A timed-out provider falls back to the other. |

### How web routing works

| Question | What happens |
|---|---|
| "What is 2+2?" | No tool. Answered directly. |
| "What happened in AI today?" | **One** search. Tavily goes first (best for news and recency) with `topic=news` and a one-day window. Exa is used only if Tavily fails. |
| "search for papers on RAG site:arxiv.org" | **One** search. Exa goes first (semantic query), restricted to arxiv.org. Tavily is the fallback. |
| "Research this company deeply" / `"mode":"research"` | Research workflow (below). The main query goes to **both** providers. |
| "What is this GitHub repository? github.com/x/y" | GitHub tool first (Phase 6). Until that tool exists, web search is used as a **fallback**, and the response says so. |
| "What happened on Robinhood Chain today?" | Chain data first (Phase 8). Once a chain tool is configured, web search is **skipped** for this question. Until then, web search fills in and `chain.data` is reported as unavailable. |
| "Price of $TOKEN?" | Market data only (Phase 9). Web search is never used for prices, because snippets would pass off stale numbers as current. |

How the router decides:
- Each intent has **required**, **optional** and **fallback** capabilities (`INTENT_CAPABILITIES` in `router/tool-router.ts`).
- Each tool scores how well it fits a request (`suitability`), and the best fit goes first.
- Normal questions call **one** provider, with the other as fallback.
- Only the main research query calls both.

Filters are parsed from the question itself:
- `site:domain` and `-site:domain` become domain filters.
- "today", "this week" and "this month" set a time window.
- News intent sets `topic=news` for Tavily and `category=news` for Exa.

### Research mode (bounded, no recursion)

```
question → intent (research) → query planning (≤ VEYRA_RESEARCH_MAX_QUERIES)
        → query 1: Exa + Tavily in parallel  |  queries 2..n: one provider each, alternating, with fallback
        → read the top VEYRA_RESEARCH_EXTRACT_TOP snippet-only results in full (Jina → Firecrawl), one pass
        → sanitize + URL + near-duplicate dedupe → top VEYRA_RESEARCH_MAX_SOURCES sources
        → reasoning-tier synthesis → answer with [n] citations, checked against real sources
```

With the defaults, a research request makes at most **6 external calls**:
- 4 searches: 2 for the main query, 1 for each of the 2 sub-queries.
- 2 page reads (Jina is free).
- Plus 1 cheap-model call for query planning.

Pages a search provider already returned text for (Exa in research mode) are not fetched again. Failed research page reads are partial failures: the answer still uses the search snippets.

In research mode, Tavily uses `advanced` depth and Exa returns page text (up to 4,000 characters). Normal searches use snippets only.

### Normalization, dedupe, citations

- Both providers produce the same `WebResult`: `{ title, url, domain, snippet, content?, publishedAt?, sourceType, relevance }`. That becomes a numbered `Source`, so the model never sees provider-specific formats.
- **Dedupe** happens in two passes:
  - Same canonical URL: `www.`, tracking parameters, trailing slashes and fragments are ignored.
  - Near-identical content or identical long titles, such as syndicated copies.

  The strongest copy is kept, and `alsoFoundBy` records which other providers returned it.
- Every source has `evidence`, which tells the user and the model how much to trust it:
  - `search_result`: a snippet.
  - `retrieved_content`: page text.
  - `live_data`: data from a live API.

  The model's own analysis is never a source.
- **Citations**: the model must end every sourced sentence with `[n]`. TILIK then checks every citation against the real source list:
  - Citations to sources that don't exist are **removed** and reported in `citations.invalid`.
  - `citations.statements` maps each cited sentence to its source IDs.
  - URLs come only from the provider APIs; none are constructed.

### Failure behaviour

| Situation | Result |
|---|---|
| Exa fails (error, timeout, 402/429) | Tavily is tried. `toolRuns` shows both attempts. |
| Tavily fails (incl. 432/433 quota) | Exa is tried |
| Both fail | **HTTP 200** with a degraded answer: `grounded: false` and the warning `web.search: all tools failed: …`. The model is told the live data is missing and says so. |
| Key missing | That provider is never called. If both keys are missing, the response says to set `TAVILY_API_KEY or EXA_API_KEY`. |
| Auth/quota error | That provider is paused (10 min) so it isn't retried on every request |

### Example: web question

```bash
curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" \
  -d '{"message":"What happened in AI today?"}'
```

```jsonc
{
  "type": "research",
  "answer": "Two major model releases dominated today… [1] … regulators also … [2]",
  "grounded": true,
  "sources": [
    {
      "id": 1, "title": "…", "url": "https://…", "domain": "…",
      "type": "news", "evidence": "search_result", "provider": "tavily",
      "publishedAt": "2026-10-06T09:12:00.000Z", "relevance": 0.95,
      "snippet": "…", "retrievedAt": "2026-10-06T10:00:01.000Z"
    }
  ],
  "citations": {
    "used": [1, 2], "invalid": [],
    "statements": [{ "text": "Two major model releases dominated today.", "sourceIds": [1] }]
  },
  "data": { "web.search": [{ "tool": "tavily", "step": "web.search#1", "data": { "provider": "tavily", "query": "…", "results": [] } }] },
  "plan": {
    "intents": ["news"], "tier": "fast",
    "tools": [{ "step": "web.search#1", "capability": "web.search", "strategy": "first", "query": "What happened in AI today?", "candidates": ["tavily", "exa"] }],
    "unavailable": [], "skipped": [{ "capability": "news.feed", "reason": "optional: no tool installed for this capability yet" }]
  },
  "retrieval": { "resultsFound": 5, "duplicatesRemoved": 0, "droppedByLimit": 0, "sourcesUsed": 5 },
  "toolRuns": [{ "step": "web.search#1", "capability": "web.search", "tool": "tavily", "status": "ok", "ms": 840 }]
}
```

### Example: research

```bash
curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" \
  -d '{"message":"Research the latest developments around tokenized assets"}'
```

```jsonc
{
  "type": "research",
  "plan": {
    "tier": "reasoning",
    "searchQueries": { "method": "llm", "queries": ["tokenized real-world assets 2026", "tokenized stocks regulation", "tokenization risks"] },
    "tools": [
      { "step": "web.search#1", "strategy": "all",   "candidates": ["exa", "tavily"] },
      { "step": "web.search#2", "strategy": "first", "candidates": ["tavily", "exa"] },
      { "step": "web.search#3", "strategy": "first", "candidates": ["exa", "tavily"] }
    ]
  },
  "retrieval": { "resultsFound": 20, "duplicatesRemoved": 4, "droppedByLimit": 4, "sourcesUsed": 12 },
  "sources": [{ "id": 1, "provider": "exa", "alsoFoundBy": ["tavily"], "evidence": "retrieved_content", "…": "…" }]
}
```

Real answers and URLs depend on what the providers return. The values above only show the structure.

---

## Web extraction (Phase 5): Jina Reader + Firecrawl

Both tools turn a URL into clean markdown with title, description and publication date. They serve the `web.extract` capability and are interchangeable fallbacks for each other.

### API setup

| Provider | Where | Free allowance | Env var |
|---|---|---|---|
| **Jina Reader** | Works **without a key**. For a free key, go to [jina.ai/reader](https://jina.ai/reader) and use **API Key & Billing** (`jina_…`). | Keyless: 20 req/min. Free key: 500 req/min and 10M tokens. | `JINA_API_KEY` (optional) |
| **Firecrawl** | Sign up at [firecrawl.dev](https://www.firecrawl.dev), then go to **API Keys** (`fc-…`). | Free credits; 1 credit per page | `FIRECRAWL_API_KEY` |

Out of the box (no keys), TILIK can already read pages through keyless Jina. Add a Firecrawl key for a fallback that handles JavaScript-heavy and bot-protected sites. Set `JINA_ALLOW_KEYLESS=false` if you don't want keyless calls.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `JINA_API_KEY` | (none) | Optional; raises Jina rate limits |
| `JINA_ALLOW_KEYLESS` | `true` | Use Jina without a key (rate-limited per IP) |
| `FIRECRAWL_API_KEY` | (none) | Enables Firecrawl |
| `JINA_DAILY_REQUEST_LIMIT` / `FIRECRAWL_DAILY_REQUEST_LIMIT` | 200 / 30 | Upstream calls per UTC day (cache hits are free) |
| `VEYRA_EXTRACT_PRIMARY` | `jina` | Which extractor goes first (`jina` \| `firecrawl`) |
| `VEYRA_EXTRACT_MAX_URLS` | 3 | Direct URLs read per request |
| `VEYRA_EXTRACT_MAX_CHARS` | 20000 | Characters kept per page (cut at a paragraph boundary) |
| `VEYRA_EXTRACT_CACHE_TTL_SECONDS` | 3600 | Re-reading the same page within this window costs nothing |
| `VEYRA_RESEARCH_EXTRACT_TOP` | 2 | Research: top snippet-only search results read in full (0 = off) |
| `VEYRA_BLOCKED_DOMAINS` | (none) | Comma-separated domains never fetched or cited |

### Extraction workflow

```
URL in question ─► URL guard (blocks private/internal/credentialed/odd-port/binary/blocked-domain URLs)
                ─► de-dupe (www., tracking params, trailing slash) ─► cap at VEYRA_EXTRACT_MAX_URLS
                ─► one web.extract step per URL: primary extractor → fallback extractor
                ─► normalize (title, final URL, date) ─► truncate long pages at a boundary
                ─► sanitize + prompt-injection redaction ─► fenced source for the model ─► cited answer
```

- **Direct URLs:** "What is this website about? https://…", "Summarize https://…", or any message containing a URL.
- **GitHub URLs:** until the GitHub tool (Phase 6) exists, a GitHub URL is read as a web page. That beats searching *about* the repo; web search is used only if there's no URL.
- **Research:** after searching, the most relevant snippet-only results are read in full (see Research mode).

### Fallback behaviour

| Situation | Result |
|---|---|
| Jina fails (error, timeout, 402/429, empty page) | Firecrawl is tried. `toolRuns` shows both attempts. |
| Firecrawl fails (incl. 402 out of credits) | Jina is tried |
| A page yields < 80 characters of text (JS-only shell, blocked) | Counts as a failure, so the other extractor gets a try |
| Both fail on a direct URL | **HTTP 200**, `grounded: false`, warning `web.extract: all tools failed: …`; the model says it couldn't read the page |
| Both fail on a research page read | Partial failure: a warning only; the answer uses search snippets |
| No extractor configured (`JINA_ALLOW_KEYLESS=false`, no keys) | Never called; reported as `set JINA_API_KEY or FIRECRAWL_API_KEY` |
| Auth/quota errors | That provider is paused for 10 min instead of being retried on every request |

### Example: URL question

```bash
curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" \
  -d '{"message":"What is this website about? https://example.com"}'
```

```jsonc
{
  "type": "research",
  "answer": "It's a reserved domain for use in documentation examples [1].",
  "grounded": true,
  "sources": [{
    "id": 1, "title": "Example Domain", "url": "https://example.com/", "domain": "example.com",
    "type": "web", "evidence": "retrieved_content", "provider": "jina",
    "snippet": "This domain is for use in documentation examples without needing permission…"
  }],
  "plan": {
    "tools": [{ "step": "web.extract#1", "capability": "web.extract", "stage": "primary", "optional": false,
                "url": "https://example.com", "candidates": ["jina", "firecrawl"] }],
    "blockedUrls": []
  },
  "toolRuns": [{ "step": "web.extract#1", "tool": "jina", "status": "ok", "ms": 1099 }],
  "security": { "flaggedSources": [], "blockedUrls": [], "removedLinks": [], "redactions": [] }
}
```

(The source, tool run and timing above come from a real keyless Jina call. The answer text is illustrative.)

### Example: research question

```bash
curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" \
  -d '{"message":"Research the latest developments around tokenized assets"}'
```

```jsonc
{
  "plan": {
    "tools": [
      { "step": "web.search#1",  "stage": "primary",  "strategy": "all",   "candidates": ["exa", "tavily"] },
      { "step": "web.search#2",  "stage": "primary",  "strategy": "first", "candidates": ["tavily", "exa"] },
      { "step": "web.search#3",  "stage": "primary",  "strategy": "first", "candidates": ["exa", "tavily"] },
      { "step": "web.extract#r1", "stage": "followup", "optional": true, "url": "https://…", "candidates": ["jina", "firecrawl"] },
      { "step": "web.extract#r2", "stage": "followup", "optional": true, "url": "https://…", "candidates": ["jina", "firecrawl"] }
    ]
  },
  "sources": [{ "id": 1, "provider": "jina", "alsoFoundBy": ["tavily"], "evidence": "retrieved_content", "…": "…" }]
}
```

---

## GitHub intelligence (Phase 6)

Ask about any GitHub repository: paste a link, write `owner/repo repository`, or follow up on a repo mentioned earlier in the conversation. TILIK reads the **official GitHub REST API** and fetches only what the question needs.

### Setup: `GITHUB_TOKEN` (optional)

| Mode | How | Limits |
|---|---|---|
| **No token** (default) | Nothing to do (`GITHUB_ALLOW_UNAUTHENTICATED=true`) | Public repos only, **60 API requests/hour** per IP |
| **Token** | Create a fine-grained token at [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens) with **read-only** *Metadata*, *Contents*, *Issues* and *Pull requests* (all repos, or only the private ones you want). Put it in `.env` as `GITHUB_TOKEN=github_pat_…`. | **5,000 requests/hour**, plus the private repos the token can read |

The token only needs read access; never give it write scopes. If GitHub rejects the token (401), TILIK retries without it for public repos and adds a warning.

### Supported questions → GitHub calls

| Question | Data fetched | API calls |
|---|---|---|
| "What language is it written in?" | metadata, languages | 2 |
| "What does this project do?" / "Summarize the README" | metadata, README | 2 |
| "What are the latest releases?" | metadata, releases | 2 |
| "Who contributes to this project?" | metadata, contributors | 2 |
| "Are there any recent issues?" | metadata, open issues (PRs filtered out) | 2 |
| "What changed recently?" | metadata, recent commits | 2 |
| "How active is this repository?" | metadata, commits, releases, PRs, issues; computes an activity summary | 5 |
| "Show me the important files" | metadata, tree → structure summary + manifests/entry points | 2 + file reads |
| "Explain the architecture" | metadata, README, tree, manifests + files matching the question | 3 + file reads |
| "Explain src/router.ts" (or a `/blob/` link) | metadata + that one file | 1 + 1 file read |
| "Explain the authentication system" | metadata, tree → files whose **names** match auth/login/jwt/session/… → read the best few | 2 + file reads |
| "Analyze this repo" | full analysis (below) | 7 + file reads |

File reads use `raw.githubusercontent.com` with a byte `Range`, so they **don't count against the API quota**. A loosely named file (`` `router.ts` ``) is resolved against the tree (`src/router.ts`).

### Repository analysis workflow

```
Detect repo (URL / owner/repo / conversation) → metadata (required; 404/private/rate limit fail fast)
  → in parallel: languages, README, tree, recent commits, releases, open issues   (trimmed to quota and caps)
  → choose files: requested → matching the question → manifests/config/entry points   (never the whole repo)
  → ranged reads within GITHUB_MAX_FILE_SIZE / GITHUB_MAX_TOTAL_CONTENT
  → sources: overview · README · structure · activity summary · commits · releases · issues · files
  → coding-tier model: Overview · Architecture · Technology Stack · Important Files · Activity · Recent Changes · Potential Concerns
```

**GitHub + web research** ("Research this project deeply https://github.com/x/y", or `"mode":"research"`):
- GitHub repository analysis;
- Exa/Tavily searches built around `owner/repo`;
- Jina/Firecrawl reads the project's **homepage/docs**, from the repo's homepage field;
- a reasoning-tier synthesis.

The prompt makes the answer keep **From GitHub**, **From the web** and **Analysis** separate. GitHub pages are never scraped when the API is available.

### Limits (large repositories)

| Variable | Default | Spec name |
|---|---|---|
| `GITHUB_MAX_FILES` | 6 | MAX_GITHUB_FILES: files read per question |
| `GITHUB_MAX_FILE_SIZE` | 60000 | MAX_FILE_SIZE: bytes read per file (byte range) |
| `GITHUB_MAX_TOTAL_CONTENT` | 20000 | MAX_TOTAL_CONTENT: characters of README + files per question |
| `GITHUB_MAX_COMMITS` | 10 | MAX_COMMITS |
| `GITHUB_MAX_ISSUES` | 10 | MAX_ISSUES |
| `GITHUB_MAX_PR_RESULTS` | 10 | MAX_PR_RESULTS |
| `GITHUB_MAX_RELEASES` / `GITHUB_MAX_CONTRIBUTORS` | 5 / 10 | |
| `GITHUB_MAX_TREE_ENTRIES` | 50000 | tree entries considered for file search |
| `GITHUB_MAX_REQUESTS_PER_QUESTION` | 12 | hard cap on API calls per question |
| `GITHUB_MAX_REPOS` | 2 | repositories per question |
| `GITHUB_DAILY_REQUEST_LIMIT` | 500 | GitHub tool runs per UTC day |
| `GITHUB_CACHE_TTL_SECONDS` / `GITHUB_PRIVATE_CACHE_TTL_SECONDS` | 900 / 60 | cache lifetime: public / private repos |

How large repos stay cheap:
- The tree is listed **once**, and only a size-capped summary goes to the model: top-level directories, file counts, file types.
- Files are chosen by **path relevance** before any content is read.
- The README gets at most 40% of the content budget when files are also read, and files share the rest fairly.
- Never read: dependency/build directories (`node_modules`, `dist`, `vendor`, …), lockfiles, binaries and minified bundles, and secret files (`.env*`, `*.pem`, `*.key`, `id_rsa`, `credentials.json`, …), even when asked by name.
- If GitHub truncates a huge tree, the answer says the structure is partial.

### Rate limits and failures

| Situation | Behaviour |
|---|---|
| Repo doesn't exist / private without access (404) | `github.repo` reported unavailable, with a hint about tokens for private repos. No pointless fallback. |
| Rate limit (403/429 with `x-ratelimit-remaining: 0`, "secondary rate limit") | GitHub is paused until the reset time. The repo page is read with Jina/Firecrawl instead (`using web.extract as a fallback`). |
| Low remaining quota | Optional data (contributors, branches, …) is skipped first, one request is kept in reserve, and a warning says what was skipped. |
| Token rejected (401) | Retried without the token (public repos), with a warning |
| No token and `GITHUB_ALLOW_UNAUTHENTICATED=false` | GitHub unavailable (`set GITHUB_TOKEN`). The repo page is read instead. |
| Timeout (`GITHUB_TIMEOUT_MS`) | Fallback to reading the repo page |
| One endpoint fails (e.g. releases) | The rest of the answer still works, with a warning about the missing part |

The response includes `data["github.repo"][0].data.rateLimit`, showing remaining and limit, and whether the call was authenticated.

### Security model

- **Repository content is untrusted data.** README, files, issues, release notes and commit messages all pass through the sanitizer. Source files use a *code mode* that keeps indentation and syntax but still redacts instruction-like lines ("ignore previous instructions…"). Prompt-injection attempts are flagged in `security.flaggedSources`.
- **Secrets in repos are redacted before the model sees them**: provider keys (`sk-…`, `ghp_…`, `AKIA…`, …), PEM private keys, and hard-coded `password = "…"` / `api_key: "…"` values. The response warns that credentials were redacted.
- **Sensitive files are never fetched**, even on request.
- **Traceable sources only.** Every GitHub source URL comes from the API (`html_url`, plus the repo URL and API-provided branch and path). Issue, commit and release links listed inside sources may be cited. Any other GitHub URL the model makes up is removed from the answer.
- **Private repositories** are cached for `GITHUB_PRIVATE_CACHE_TTL_SECONDS` (60 s) instead of 15 min.
- `GITHUB_TOKEN` never appears in prompts, responses, logs or `/health`.

### Example requests

```bash
curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" \
  -d '{"message":"Analyze this repository https://github.com/honojs/hono"}'

curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" \
  -d '{"message":"What are the latest releases?","history":[{"role":"user","content":"https://github.com/honojs/hono"},{"role":"assistant","content":"…"}]}'

curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" \
  -d '{"message":"Research this project deeply https://github.com/honojs/hono"}'
```

Response for "Analyze this repository https://github.com/honojs/hono". The fields below come from a real unauthenticated run; the answer text depends on the model:

```jsonc
{
  "type": "github",
  "plan": { "tier": "coding", "tools": [{ "step": "github.repo#1", "capability": "github.repo", "candidates": ["github"] }] },
  "sources": [
    { "id": 1, "title": "honojs/hono — repository overview", "url": "https://github.com/honojs/hono", "evidence": "live_data" },
    { "id": 2, "title": "honojs/hono — README.md", "url": "https://github.com/honojs/hono/blob/main/README.md" },
    { "id": 3, "title": "honojs/hono — repository structure (main)", "url": "https://github.com/honojs/hono/tree/main" },
    { "id": 4, "title": "honojs/hono — activity summary (derived from the data fetched)", "url": "https://github.com/honojs/hono/pulse" },
    { "id": 5, "title": "honojs/hono — 10 most recent commits on main", "url": "https://github.com/honojs/hono/commits/main" },
    { "id": 6, "title": "honojs/hono — latest releases", "url": "https://github.com/honojs/hono/releases" },
    { "id": 7, "title": "honojs/hono — open issues (most recently updated)", "url": "https://github.com/honojs/hono/issues" },
    { "id": 8, "title": "honojs/hono: package.json", "url": "https://github.com/honojs/hono/blob/main/package.json" },
    { "id": 9, "title": "honojs/hono: vite.config.ts", "url": "https://github.com/honojs/hono/blob/main/vite.config.ts" },
    { "id": 10, "title": "honojs/hono: src/index.ts", "url": "https://github.com/honojs/hono/blob/main/src/index.ts" },
    { "id": 11, "title": "honojs/hono: tsconfig.json", "url": "https://github.com/honojs/hono/blob/main/tsconfig.json" }
  ],
  "data": { "github.repo": [{ "tool": "github", "data": {
    "repo": { "fullName": "honojs/hono", "stars": 32416, "language": "TypeScript", "defaultBranch": "main" },
    "languages": [{ "name": "TypeScript", "percent": 99.9 }],
    "structure": { "totalFiles": 585, "treeTruncated": false },
    "files": [{ "path": "package.json", "reason": "manifest/config/entry point", "truncated": true }],
    "apiCalls": 7, "rateLimit": { "authenticated": false, "limit": 60 }
  } }] },
  "warnings": ["package.json was truncated to fit the file/content limits."]
}
```

A follow-up, "Explain the routing system in https://github.com/honojs/hono", found Hono's six router implementations (`src/router/*/router.ts`) by filename alone, with **0** extra API calls, because the tree was still cached.

---

## RSS / news intelligence (Phase 7)

RSS is TILIK's **free, low-cost freshness layer**. For questions about recent news it is tried first, before paid search APIs. Tavily/Exa complement it only when it adds coverage, and Jina/Firecrawl read a story in full only when the feed text is thin.

### Configuring feeds

Feeds live in **`feeds.json`**, which is data, not code:

```json
{ "feeds": [
  { "name": "TechCrunch AI", "url": "https://techcrunch.com/category/artificial-intelligence/feed/", "category": "ai", "source": "TechCrunch" },
  { "name": "CoinDesk", "url": "https://www.coindesk.com/arc/outboundfeeds/rss/", "category": "crypto", "enabled": true }
] }
```

- **Fields:** `name`, `url`, `category`, optional `source` (publisher name used in citations), optional `enabled` (default `true`).
- **Categories:** `ai`, `technology`, `crypto`, `finance`, `developer`, `general`, or any custom name.
- **Shipped list:** 18 feeds across all six categories. All 18 parsed live on 2026-10-06 (448 articles); run `npx tsx scripts/check-feeds.ts` to re-check.
- **Overrides,** in order of precedence:
  - `RSS_FEEDS_JSON`: an inline JSON array;
  - `RSS_FEEDS`: a quick list, `category|name|url` or a bare `url`, comma/newline separated;
  - `RSS_FEEDS_FILE`: another JSON file.
- Invalid or unsafe entries (private IPs, bad URLs) are skipped and logged.

### How news questions are routed

| Question | Mode | Sources |
|---|---|---|
| "What are today's biggest technology stories?" / "Find today's AI news." / "What happened in the last 6 hours?" | digest | **RSS only.** Ranked by how many outlets cover a story, then by recency. Web search only if RSS finds nothing. |
| "Latest news about OpenAI" / "Show me recent Robinhood Chain news." | lookup | RSS. **Tavily/Exa only if RSS finds fewer than `NEWS_MIN_RSS_STORIES`.** The top thin story is read in full. |
| "What happened in AI today?" / "What's happening with tokenized assets today?" | coverage | RSS **+ one web search** (Tavily first for news) for independent coverage. The top thin story is read in full. |
| "What's happening on Robinhood Chain today?" | coverage | On-chain tool (Phase 8) + RSS. Web search is suppressed once chain data exists. |
| "What are the latest releases of github.com/x/y?" | — | **GitHub only.** RSS and web search are suppressed. |
| "What is 2+2?" / "Explain transformers" | — | No RSS: the question doesn't need current information. |

- **RSS is the required source for news, and web search is its fallback.** If every feed fails, the request falls back to Tavily/Exa automatically. That fallback counts as an *equivalent* source, so the user sees a notice but the model isn't told data is missing.
- `NEWS_WEB_COMPLEMENT=auto|always|never` controls the complementary search.
- Only feeds in the question's categories are read (all enabled feeds when no category is detected), capped by `RSS_MAX_FEEDS_PER_REQUEST`.

### Workflow ("What's happening with tokenized assets today?")

```
RSS corpus (cached) ─► freshness filter ─► relevance ─► dedupe ─► story clusters
   └─► RSS judged thin or coverage question ─► one web search (Tavily/Exa, topic=news)
   └─► top story with only a short feed blurb ─► read in full (Jina → Firecrawl)   [NEWS_EXTRACT_TOP]
   └─► fenced, sanitized sources ─► LLM synthesizes ─► answer with [n] citations (every outlet's URL kept)
```

### Freshness

- Every article keeps `publishedAt` (from the feed) and `retrievedAt` (when TILIK fetched the feed). The prompt shows each source's age, e.g. `published … (3h ago)`.
- **Window:** `NEWS_MAX_AGE_HOURS` (default 24), narrowed or widened by the question:

  | Phrase | Window |
  |---|---|
  | "last 6 hours" | 6h |
  | "breaking", "right now" | 6h |
  | "today" | 24h |
  | "yesterday" | 48h |
  | "this week" | 7 days |
  | "this month" | 30 days |

- **Undated or future-dated articles are never treated as fresh.** Older articles are excluded, and the response says how many ("1 older articles were excluded as not fresh").
- The model is told to give publication times and never to call something "breaking" or "today" unless its timestamp supports it.

### Deduplication and story clustering (lightweight, no vectors)

1. **Same article:** the same canonical URL (`www.`, tracking parameters and trailing slashes ignored) from several feeds becomes one article, keeping the richer copy.
2. **Same story:** identical normalized titles, or similar titles (token overlap with light stemming and synonyms, e.g. *stocks/equities → equity*, *tokenized/tokenised → tokeniz*), are grouped into one **story**:

```jsonc
{ "title": "OpenAI releases GPT-6 model…", "summary": "…", "publishedAt": "…", "updatedAt": "…", "ageHours": 2,
  "category": "ai", "relevance": 0.92,
  "sources": [ { "source": "AI Wire", "url": "https://…", "publishedAt": "…" }, { "source": "Model Report", "url": "https://…" } ] }
```

Each story becomes **one** citable source whose content lists every outlet's article and URL. All of those URLs are allowed in the answer, so the same story never appears as ten copies.

### Caching, cost and failure handling

| Setting | Default | Behaviour |
|---|---|---|
| `RSS_REFRESH_MINUTES` | 15 | A feed is fetched at most this often, using the existing TTL cache. Requests in between search the cached corpus, so user requests don't trigger fetches. Refreshes send `If-None-Match` / `If-Modified-Since`, so unchanged feeds return 304. |
| `RSS_TIMEOUT_MS` / `RSS_MAX_FEED_BYTES` / `RSS_MAX_ITEMS_PER_FEED` | 8000 / 2 MB / 50 | Per-feed time, size and item caps |
| `RSS_FAILURE_BACKOFF_MINUTES` | 10 | A failing feed is **skipped** (other feeds continue), its last good copy is served marked "stale", and it isn't retried until the backoff expires |
| (all feeds fail) | | The RSS step fails, so the router falls back to Tavily/Exa. If those are missing too, the answer is degraded with `grounded: false`. |

Live timings (2026-10-06, real feeds, cold cache):
- "What are today's biggest technology stories?": 3 feeds, ~0.9 s;
- "Latest news about OpenAI": 4 feeds plus one Jina read, ~2.2 s.

### Security

RSS titles, descriptions and content are **untrusted data**. They go through the same sanitizer as web pages:
- injection sentences are redacted, an instruction-like title is replaced, and HTML and tracking images are stripped;
- each source is fenced in the prompt;
- feed URLs and article URLs pass the URL guard (no private or internal addresses).

The parser ignores DOCTYPE and custom entities (no XXE or entity expansion). Article URLs come only from the feeds, and links the model invents are removed from the answer.

### Example requests

```bash
curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" -d '{"message":"What are today'\''s biggest technology stories?"}'
curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" -d '{"message":"Latest news about OpenAI"}'
curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" -d '{"message":"What happened in crypto in the last 6 hours?"}'
```

The response's `data["news.feed"][0].data` contains `mode`, `window`, `stories[]`, `stats` (considered, in window, matched, excluded old/undated, duplicates merged) and the per-feed `feeds[]` status (`fresh` / `cached` / `stale` / `failed`).

---

## Robinhood Chain on-chain intelligence (Phase 8)

*Chat with intelligence from the Robinhood Chain.* Ask "What happened here?" and TILIK reads the real chain data and explains it. The LLM never fetches or invents chain facts:

```
question → intent (address / tx hash / block / network) → Robinhood Chain tool
        → raw data: RPC (chain-ID verified) + explorer API (history, labels, stats)
        → normalized sections with explorer links → LLM explains → answer with [n] citations
```

### Network configuration (verified)

Official values come from [docs.robinhood.com/chain/connecting](https://docs.robinhood.com/chain/connecting) and were checked live on 2026-10-06:

| | Mainnet (default) | Testnet (`ROBINHOOD_NETWORK=testnet`) |
|---|---|---|
| Chain ID | **4663** (RPC answered `0x1237`) | **46630** (`0xb626`) |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Recommended RPC | `https://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}` (Alchemy) | `https://robinhood-testnet.g.alchemy.com/v2/{API_KEY}` |
| Explorer | `https://robinhoodchain.blockscout.com` | `https://explorer.testnet.chain.robinhood.com` |
| Native token | ETH | ETH |

- **Rate limits:** Robinhood's docs call the public RPC *"rate-limited and not recommended for production use"*, and it does return HTTP 429 after bursts. For anything beyond light use, set `ROBINHOOD_RPC_URL` to a provider URL. Alchemy is recommended by Robinhood; Chainstack, QuickNode, dRPC and others are listed too.
- **Block speed:** blocks arrive about every 0.1 s (an Arbitrum Orbit chain), so "today" is roughly 860,000 blocks. TILIK **never scans the chain**: windows are tiny and bounded, and daily figures come from the explorer.

### Setup

| Variable | Default | Purpose |
|---|---|---|
| `ROBINHOOD_NETWORK` | `mainnet` | Picks the official defaults above |
| `ROBINHOOD_RPC_URL` | official public RPC | Your provider URL. **Treated as a secret:** it never appears in prompts, responses, logs, errors or `/health`, and it is redacted if the model ever echoes it. |
| `ROBINHOOD_RPC_FALLBACK_URLS` | (none) | Extra RPCs tried when the primary fails |
| `ROBINHOOD_CHAIN_ID` | 4663 / 46630 | **Verified against `eth_chainId` before any data is used.** A mismatch stops the answer, so wrong-network data is never shown. |
| `ROBINHOOD_EXPLORER_URL` | official explorer | Base for `/tx/`, `/address/`, `/block/`, `/token/` links (routes verified). `none` disables links. |
| `ROBINHOOD_EXPLORER_API_KEY` | (none) | Free Blockscout PRO API key from [dev.blockscout.com](https://dev.blockscout.com) (100K credits/day, 5 req/s). Enables history, labels, holders and daily stats via `https://api.blockscout.com/<chainId>/api/v2`. |
| `ROBINHOOD_EXPLORER_API_URL` | PRO API when a key is set | Any Blockscout v2 base (e.g. a self-hosted instance). `none` disables it. |

The explorer *website's* own API sits behind a Cloudflare bot challenge for server clients (HTTP 403 "Just a moment…"). TILIK doesn't try to get around it; it uses the official PRO API with a key instead. Without a key, TILIK runs **RPC-only** and says what that leaves out.

### What the RPC alone cannot provide

| Needs the explorer API | Why |
|---|---|
| An address's transaction history and token holdings | RPC has no address index |
| Token holder counts, daily transaction counts, trends | Needs an indexer |
| Contract names, verification, proxies, decoded function names | Explorer metadata |
| Labels for addresses | Third-party annotations (shown as *explorer labels*, never as identity) |
| Who owns an address | Not knowable from chain data. TILIK says "address 0x… interacted with…". |

### Supported questions

| Question | Workflow | Data |
|---|---|---|
| "Explain this transaction 0x…(64 hex)" | transaction | Tx + receipt + block time (RPC): status, block, confirmations, from/to, value, function called (known selectors or explorer-decoded), gas and fee, **decoded events** (ERC-20 Transfer/Mint/Burn with token symbol and amount, Approval, Swap, NFT transfers…). Explorer adds the decoded call, token transfers and labels. A hash that isn't a transaction is tried as a block hash. |
| "What is this address doing? 0x…" / "Analyze this wallet." | address | Balance, nonce, contract code (RPC). With the explorer: counters, the most recent transactions (bounded), activity by day, top counterparties, functions called, token balances, recent token transfers. |
| "What is this contract? 0x…" | address → contract/token | Bytecode size, ERC-20 metadata via `eth_call` (name, symbol, decimals, total supply). With the explorer: verification, proxy and implementation, creator, holders. |
| "What happened in block 81500000?" / "latest block" | block | Time, tx count, gas use, base fee, value moved, most-called addresses, largest native transfers, tx list (bounded) |
| "What's happening on Robinhood Chain today?" / "Is activity increasing?" / "Most active contracts?" / "Largest recent transfers?" | network | Latest block (RPC). With the explorer: daily tx counts and **trend vs prior days**, a recent-transactions sample (most called contracts, largest native transfers), recent token transfers, tokens by holders. Without it: Transfer events in the last `ONCHAIN_BLOCK_WINDOW` blocks via `eth_getLogs`. |

- **Validation:** addresses are validated, including EIP-55 checksums, and malformed `0x…` values are reported back rather than queried. Follow-ups ("Explain this transaction.", "Analyze this wallet.") reuse the hash or address from earlier in the conversation.
- **Answer format:** the prompt has the model explain in plain language, copy hashes exactly, give units, say what a sample covers, and keep **On-chain facts / From the web / Analysis** separate when web sources are also present.
- **Web search:** when chain data is available, web search is never the primary source. If the chain tool fails entirely, web search is used as a labelled fallback.

### Limits, rate limiting and caching

| Variable | Default | Meaning |
|---|---|---|
| `ONCHAIN_BLOCK_WINDOW` | 20 | Blocks in an RPC log window (about 2 s of chain time) |
| `ONCHAIN_MAX_TRANSACTIONS` | 25 | MAX_TRANSACTIONS listed per analysis |
| `ONCHAIN_MAX_LOG_RESULTS` | 200 | MAX_LOG_RESULTS decoded per analysis |
| `ONCHAIN_MAX_ADDRESSES` | 3 | MAX_ADDRESSES (or tx hashes) per question |
| `ONCHAIN_MAX_RPC_CALLS` / `ONCHAIN_MAX_EXPLORER_CALLS` | 25 / 12 | Hard caps per question |
| `ONCHAIN_RPC_TIMEOUT_MS` / `ONCHAIN_TIMEOUT_MS` | 10000 / 30000 | Per call / whole tool |
| `ONCHAIN_RPC_RETRIES` | 2 | Retries with exponential backoff and jitter. A long `Retry-After` stops retrying instead of waiting, so there are no infinite loops. |
| `ONCHAIN_CACHE_TTL_SECONDS` | 3600 | Stable data: mined blocks, receipts, token metadata, contract code |
| `ONCHAIN_LIVE_TTL_SECONDS` | 10 | Live data: latest block, balances, nonces, stats, whole answers |
| `ONCHAIN_DAILY_REQUEST_LIMIT` | 2000 | Tool runs per UTC day |

Event decoding fetches only token symbol and decimals; full metadata is fetched only for token questions.

Measured live on the public RPC (no explorer key):

| Question | Time | RPC calls |
|---|---|---|
| "Show me the latest block" | 0.3 s | 1 |
| Token contract (USDG) | 3.3 s | 7 |
| Network overview | 3.7 s | 13 |
| Transaction | ~2–8 s | depends on public-RPC throttling |

### Error handling

| Situation | Behaviour |
|---|---|
| Invalid address / hash / checksum | Reported in an "Input validation" source, never queried |
| Transaction / block not found | A clear "no transaction or block with hash … on chain 4663" fact, not a crash |
| Pending transaction | "not yet mined" (no receipt requested) |
| RPC down / timeout / 429 | Bounded retries. If an explorer API is configured, the answer uses explorer data only and says so. Otherwise `chain.data` is reported unavailable, with web search as a labelled fallback when configured. |
| Chain ID mismatch | Hard stop with a configuration message |
| Unsupported method (`-32601`) / malformed response | That part is skipped with a notice (`invalid_output` / `bad_request`), and the rest of the answer still works |
| Explorer 402 / bot challenge | One clear notice, no further explorer calls in that request; RPC data still answers |

### Security model

- **Chain data is untrusted.** Token names, symbols, explorer labels, decoded inputs and log contents pass through the sanitizer like web pages: control characters are stripped, length is capped, and injection text is redacted and flagged.
- The prompt says that token names are set by deployers and explorer labels are third-party annotations. Neither proves authenticity or identity.
- **Explorer links** are built only from the configured explorer base plus verified routes, and only for hashes and addresses that came from the data. Any other link the model writes is removed.
- **Credentials:** the RPC URL (which may embed a key) and `ROBINHOOD_EXPLORER_API_KEY` are secrets. They are never logged or returned, they are redacted from answers, removed-link lists and error messages, and `/health` reports only whether the tool is configured.

### Example requests

```bash
curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" -d '{"message":"What'\''s happening on Robinhood Chain today?"}'
curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" -d '{"message":"Explain this transaction 0x96f696c74edfa55e4cadc06019e866ad6745ecbd4242661551a0afb81e9bafe2"}'
curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" -d '{"message":"What is this contract? 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"}'
curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" -d '{"message":"What happened in block 81500000?"}'
```

Live result for the contract question, RPC-only:

```jsonc
{
  "type": "onchain",
  "sources": [
    { "id": 1, "title": "Address 0x5fc5…d168 — overview", "url": "https://robinhoodchain.blockscout.com/address/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      "snippet": "… Type: token contract · bytecode 170 bytes" },
    { "id": 2, "title": "Token USDG — metadata", "url": "https://robinhoodchain.blockscout.com/token/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      "snippet": "Token contract: 0x5fc5… · Name: Global Dollar · Symbol: USDG · Decimals: 6" }
  ],
  "data": { "chain.data": [{ "data": { "chain": { "name": "Robinhood Chain", "chainId": 4663, "rpc": "public" }, "kind": "address",
    "dataSources": { "rpc": "ok", "explorer": "not configured" }, "requests": { "rpc": 7, "explorer": 0 } } }] },
  "warnings": ["Transaction history, token holdings and labels need an explorer API (RPC has no address index) — set ROBINHOOD_EXPLORER_API_URL."]
}
```

---

## GeckoTerminal market intelligence (Phase 9)

**Robinhood on-chain data + GeckoTerminal market data + AI reasoning.** The LLM never produces prices: GeckoTerminal does, every number is validated first, and the model explains it.

### Setup

- **No API key needed.** TILIK uses GeckoTerminal's free public API (`https://api.geckoterminal.com/api/v2`), limited to **30 calls/minute** per its [FAQ](https://apiguide.geckoterminal.com/faq).
- **Network:** Robinhood Chain is supported as network id **`robinhood`**. I verified this on 2026-10-06 by listing all 226 GeckoTerminal networks and fetching live USDG data. It's configurable with `GECKOTERMINAL_NETWORK` (no ids are hard-coded in logic).
- Requests send `Accept: application/json;version=20230302`.

### Endpoints used

All of these were verified live on network `robinhood`, except where marked:

| Purpose | Endpoint |
|---|---|
| Token: price, FDV, market cap, liquidity, 24h volume, plus its top pools in **one call** | `GET /networks/{net}/tokens/{address}?include=top_pools` |
| A token's pools (if not included) | `GET /networks/{net}/tokens/{address}/pools` |
| Pool: liquidity, volume and price change (5m/1h/6h/24h), buys/sells/buyers/sellers | `GET /networks/{net}/pools/{address}` |
| Price history | `GET /networks/{net}/pools/{address}/ohlcv/{day\|hour}?limit=&currency=usd` |
| Recent trades (each one an on-chain tx) | `GET /networks/{net}/pools/{address}/trades` |
| Most active pools | `GET /networks/{net}/pools` |
| Symbol → candidate tokens | `GET /search/pools?query=&network=&include=base_token,quote_token` (documented; rate-limited during verification) |
| Is the network supported? (only checked after a 404) | `GET /networks?page=N` |

Not used: trending and new pools (top pools answer "most active").

**Uniswap v4 pools** are identified by a 32-byte pool id rather than a contract address. Both are accepted as pool identifiers, while token addresses must be exactly 20 bytes.

### Supported questions

| Question | What runs |
|---|---|
| "What is the price of this token? 0x…" | GeckoTerminal token lookup. Robinhood Chain also adds on-chain token facts (name, symbol, decimals, supply), because the address counts as on-chain too. |
| "Show me the liquidity / What is the volume?" (with an address, or as a follow-up) | Token or pool lookup. An address that isn't a token is tried as a pool. |
| "Which pools are most active?" | Top pools on the network, with liquidity, 24h volume, change and trades |
| "Analyze this token on Robinhood Chain 0x…" | **Combined:** on-chain facts (Robinhood RPC/explorer) + market data (price, liquidity, volume, change, pools) |
| "What happened to this token today?" | Token + **hourly** OHLCV (24 candles) + recent trades, plus on-chain facts. "This week" uses daily candles (`MARKET_OHLCV_DAYS`). |
| "What is the price of USDG?" (symbol only) | Symbol search. **Every token sharing the symbol is listed by contract address.** TILIK never assumes a symbol is unique, and asks for the address. |
| "What's happening on Robinhood Chain today?" | Chain overview + most active pools (market data now fills what Phase 8 reported as missing) |

- **Follow-ups:** "What's the price of this token?" after an address was mentioned reuses that address.
- **Prompt rules:** on-chain, market, web and analysis stay in separate sections (**On-chain facts / Market data / From the web / Analysis**). Each price comes with its fetch time. GeckoTerminal prices are described as DEX-derived, and the model may not infer a price from on-chain transfers.

### Validation

Before anything reaches the model:
- **Prices, liquidity, volume:** must be finite, non-negative and below 1e15.
- **Percent changes:** −100% or more.
- **Counts:** non-negative integers.
- **Timestamps:** parseable, after 2015 and not in the future.
- **Addresses and pool ids:** strict hex.
- **OHLCV rows:** complete, with high ≥ low.
- **Trades:** need a valid tx hash, time and buy/sell kind.

Anything that fails is **dropped and shown as "not reported"**, and a warning gives the count. A response with no valid token or pool identity fails as `invalid_output`, so malformed data never becomes a confident statement.

### Freshness and caching

| Variable | Default | Cached data |
|---|---|---|
| `MARKET_CACHE_TTL` | 30 s | Prices, pool stats, OHLCV, trades, whole answers. GeckoTerminal itself refreshes about every minute. |
| `POOL_CACHE_TTL` | 60 s | Pool lists (top pools, a token's pools, symbol search) |
| `TOKEN_METADATA_CACHE_TTL` | 3600 s | Network list and stable metadata |
| `MARKET_STALE_MAX_SECONDS` | 900 s | If GeckoTerminal fails, last-known data up to this age is shown **labelled `⚠ STALE DATA … not current`**, and status is `stale`. `0` disables this, giving an error instead of old prices. Stale answers are never cached. |

Every market source states when its data was fetched ("data fetched … (12s ago)").

### Rate limits and cost

- **Client-wide limiter:** `GECKOTERMINAL_RATE_LIMIT_PER_MINUTE=25`, below the public 30/min. When exhausted, requests fail fast (or use stale data) instead of being throttled by GeckoTerminal.
- **Per-question cap:** `MARKET_MAX_REQUESTS_PER_QUESTION=6`.
- **Typical costs:** a token price is **1 call**; "today" adds OHLCV and trades for 3 total.
- **Deduplication and retries:** identical concurrent requests share one call, and the cache prevents repeats. `GECKOTERMINAL_RETRIES=1` is a bounded retry on 429/5xx/timeouts, and a long `Retry-After` stops retrying.
- **Result caps:** `MARKET_MAX_POOLS`, `MARKET_MAX_TRADES`, `MARKET_OHLCV_DAYS`, `MARKET_DAILY_REQUEST_LIMIT`.

### Fallback and unavailable states

| Situation | Answer |
|---|---|
| Token/pool not listed on GeckoTerminal | Explicit "GeckoTerminal has no token or pool at 0x… on network robinhood … do not estimate it" (status `unavailable`) |
| Network not supported | Explicit "GeckoTerminal does not support the network …" |
| GeckoTerminal down / rate-limited / timeout | Stale data if recent (labelled). Otherwise `market.data` is reported unavailable, the model is told not to guess, **and on-chain data still answers.** |
| Invalid address / checksum | Reported, never queried |

### Sources and links

- Market sources cite the **GeckoTerminal API URL** that produced them (e.g. `…/networks/robinhood/tokens/0x…?include=top_pools`), which is verifiable and traceable.
- Recent trades link to their **Robinhood explorer transaction pages** (on-chain references), and those links are citable.
- GeckoTerminal *website* links aren't generated: the site blocks automated access, so its URL format couldn't be verified.

### Example requests

```bash
curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" -d '{"message":"What is the price of this token? 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"}'
curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" -d '{"message":"Analyze this token on Robinhood Chain 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 and show what happened today"}'
curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" -d '{"message":"Which pools are most active?"}'
```

Live results (2026-10-06, real APIs, dev-mock LLM):

| Question | Time | Sources |
|---|---|---|
| Price question | 3.8 s | Market: USDG at about $1, 1 GeckoTerminal call. On-chain: token contract, Global Dollar / 6 decimals. |
| "…what happened today" | 2.4 s | Market + on-chain + 24 hourly candles + 15 recent trades (2 GeckoTerminal calls; the token was cached) |
| "Which pools are most active?" | 0.3 s | 10 pools (including v4 pools), 0 values discarded |

### Limitations

- Prices are **DEX-pool derived** (GeckoTerminal), not centralized-exchange quotes. Thin pools can be misleading, and the answer flags very low liquidity.
- Market data covers only what GeckoTerminal indexes on the configured network. Tokens without DEX pools have no price.
- Symbol search depends on the documented search endpoint, which is the most rate-limited one.
- One network per deployment (`GECKOTERMINAL_NETWORK`).

---

## Security: untrusted web content

**Webpage content is untrusted data.** Instructions inside a page never override TILIK's instructions. Several layers enforce this:

1. **URL guard** (`security/url-guard.ts`). Before any URL goes to an extractor, TILIK blocks:
   - non-http(s) schemes;
   - embedded credentials;
   - `localhost`, `*.local`, `*.internal` and single-label hostnames;
   - private, loopback, link-local and cloud-metadata IPs (`169.254.169.254`), including decimal and hex IP forms;
   - non-global IPv6;
   - unusual ports and executable downloads;
   - anything in `VEYRA_BLOCKED_DOMAINS`.

   Blocked URLs are listed in `security.blockedUrls` and warnings. Punycode domains are flagged.
2. **Sanitizer** (`security/untrusted.ts`). Every source passes through it, from search, extraction and any future tool. It:
   - strips zero-width/bidi characters, HTML comments, `<script>`/`<style>` blocks and leftover tags;
   - removes markdown images, which can act as tracking or exfiltration beacons, and link targets;
   - redacts instruction-like sentences, such as "ignore previous instructions", "reveal API keys / system prompt / .env", "you are now…", fake `system:` turns, chat-template tokens and forged source delimiters.

   Affected sources are flagged in `security.flaggedSources`, and a warning is added.
3. **Fenced context** (`core/prompts.ts`). Each source sits between `<<<SOURCE n NONCE>>>` … `<<<END SOURCE n NONCE>>>` markers. The nonce comes from a random per-process salt, so a page can't forge a closing marker. The system prompt says that only the system message and the user's question can give instructions, and that source text is data.
4. **Output guard** (`security/output-guard.ts`). Before the answer leaves the server, including mid-stream with a buffered window so a key split across chunks is still caught:
   - every configured secret (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_RPC_URL`) and common credential formats (`sk-or-…`, `gsk_…`, `tvly-…`, `fc-…`, `jina_…`, `AIza…`, `ghp_…`, …) are replaced with `[REDACTED]`;
   - a secret canary planted in the system prompt is redacted if the model ever repeats it, which detects prompt-dumping;
   - links in the answer that aren't a source URL or a URL the user wrote are removed (`security.removedLinks`).
5. **Never exposed:**
   - API keys aren't placed in prompts;
   - `/health` reports only `configured: true/false`;
   - upstream error excerpts are scrubbed of key-like strings;
   - environment variables and the system prompt are never returned.

**Trade-off:** pattern-based redaction can occasionally remove a harmless sentence. An article *about* prompt injection that quotes "ignore previous instructions" is one example. That sentence is replaced with a visible note, and the source is flagged.

---

## The intelligence router (Phase 10)

TILIK behaves as **one system**: every question goes through the same pipeline, and the frontend never needs to know which API answered.

```
1 UNDERSTAND   rules (+ optional cheap-model check) → internal intents → unified intents
               + conversation context (follow-ups inherit tokens, repos, URLs, tx hashes)
2 PLAN         model tier (with reasons) + minimal tool set (why, phase, dependencies, max attempts, freshness)
3 EXECUTE      phase 1: independent tools in PARALLEL
               phase 2: fallback (a source failed) / complement (RSS thin → one web search)
               phase 3: DEPENDENT reads (pages chosen from phase-1 results; never before their URLs exist)
4 VERIFY       sanitize, dedupe, rank by relevance × authority × freshness, keep every kind of data, fit budget
5 REASON       final tier chosen with the real context size/mix; fenced sources; fact/inference/unknown rules
6 ANSWER       citations verified, unverified links removed, secrets redacted, claims classified
```

### Unified intents

A question can carry several. Composites are derived:

| Unified intent | Comes from |
|---|---|
| `GENERAL`, `CODING`, `SUMMARIZATION` | Questions that need no live data (no tools) |
| `WEB_SEARCH`, `DEEP_RESEARCH`, `URL_ANALYSIS`, `NEWS` | Web data (Tavily/Exa, Jina/Firecrawl, RSS) |
| `GITHUB`, `ROBINHOOD_ONCHAIN`, `MARKET` | GitHub API, Robinhood Chain, GeckoTerminal |
| `ONCHAIN_MARKET` | On-chain **and** market in one question |
| `COMBINED_RESEARCH` | Research spanning 2+ kinds of data, or any question spanning 3+ |

For example, "Analyze this Robinhood Chain project and tell me whether the GitHub is active: github.com/x/y" gives `ROBINHOOD_ONCHAIN + GITHUB`.

### Tool planning

`plan.tools[]` explains each step:

| Field | Meaning |
|---|---|
| `why` | Why the step is needed, e.g. "Address 0x… is mentioned — read its on-chain state directly." |
| `phase` | 1 = independent, run in parallel · 2 = fallback or complement · 3 = depends on earlier results |
| `dependsOn` | The steps whose results it needs |
| `maxAttempts` | Upper bound: candidates × (1 + retries) |
| `freshness` | `live` (chain, market) · `recent` (news, search) · `moderate` (GitHub) · `stable` (docs/pages) |

`plan.maxToolCalls` bounds the whole request. Typical plans:

| Question | Plan |
|---|---|
| "Analyze this token." | Robinhood Chain ∥ GeckoTerminal → LLM |
| "Research this project <repo>" | GitHub ∥ Exa ∥ Tavily → read project site / top pages (Jina/Firecrawl) → LLM (reasoning tier) |
| "What happened in AI today?" | RSS → (one web search if RSS is thin) → read top thin story → LLM |
| "What is 2+2?" | LLM only |

Tools are **never** called "just in case":
- An authoritative source (chain data, the GitHub API) suppresses general web search for its question.
- RSS is tried before paid search.
- Page reads only happen for pages chosen from earlier results.

### Model routing

`plan.model` records `{ tier, needs, reasons, candidates, skipped, notes }`:
- **Tier from intents** (`config/routing.ts`): cheap for summaries, fast for general, chain, market and news, coding for code and GitHub, reasoning for research.
- **Escalation:** 3+ kinds of data to combine raise fast/cheap to reasoning; a large context (>12k chars) raises cheap to fast.
- **Re-check after retrieval:** the tier is chosen again once the real context size and mix are known.
- **Cost:** a provider at 80%+ of its daily cap (e.g. paid OpenRouter, `OPENROUTER_DAILY_REQUEST_LIMIT`) goes to the back of the list.
- **Latency:** streaming requests try Groq first.
- **Availability:** unconfigured or cooling-down providers are never selected and are listed in `skipped`. Explicit choices are `auto | openrouter | gemini | groq | <provider>:<model>` (+ `strictModel`). On failure, the next configured provider is tried.

### Execution

Every tool call has:
- **A timeout:** per tool.
- **A retry policy:** transient failures only (timeout, network, 5xx), bounded, with backoff. GitHub retries once; tools with an equivalent fallback (Exa↔Tavily, Jina↔Firecrawl) or internal retries (RPC, GeckoTerminal) don't stack retries.
- **A result record:** `toolRuns[]` = `{ step, tool, status, ms, attempts, cached, error }`, plus source metadata.

One failed tool never fails the request.

### Context management

`core/context-builder.ts` decides what the model sees:
1. Sanitize and dedupe (same canonical URL or near-identical content).
2. Rank: `0.55·relevance + 0.3·authority + 0.15·freshness`. Freshness only counts for time-sensitive questions.
3. **Authority**, in priority order:
   - `direct`: blockchain and market data;
   - `official`: GitHub API, documentation, the project's own site;
   - `reputable`: Reuters, AP, Bloomberg, CoinDesk… (extend with `VEYRA_TRUSTED_DOMAINS`);
   - `general`: everything else.
4. **Diversity:** the best source of every kind of data is kept before filling by score, so ten web results can't crowd out the chain data.
5. **Budget:** `VEYRA_MAX_CONTEXT_CHARS` is shared fairly; each source keeps its head (where facts and metadata are) and all metadata (title, URL, type, provider, timestamps, relevance, authority).

`retrieval` reports `resultsFound`, `duplicatesRemoved`, `droppedByLimit`, `sourcesUsed`, `byFamily` and `cacheHits`.

### Fact vs inference vs unknown

The prompt requires three kinds of statement:
- **FACT:** cited.
- **INFERENCE:** under "Analysis".
- **UNKNOWN:** "Not available: …", never a guess.

`response.knowledge` reports them:

```jsonc
"knowledge": {
  "facts": { "count": 2, "statements": [{ "text": "Rocket is a TypeScript framework.", "sourceIds": [1] }] },
  "inferences": { "count": 1, "examples": ["The project likely has an active maintainer base."] },
  "unknowns": ["market.data: all tools failed: geckoterminal (upstream)", "Release data: not available."],
  "uncited": 0
}
```

### Conversation context

The last 6 turns are scanned for **entities only** (addresses, tx hashes, repos, URLs), never content:
- "Analyze this token 0x…" → "What about liquidity?" → market data for the same token.
- "What is this website about? <url>" → "Summarize it" → reads the same page.
- "Look at github.com/x/y" → "What are the latest releases?" → the GitHub releases endpoint.

### Streaming contract

`stream: true`; the event names are the SSE `event:` field, and every event carries `requestId`:

```
request.started    { requestId, at }
status             { message }   ← fixed, safe strings only: "Understanding your question…", "Searching the web…",
                                    "Reading repository…", "Checking Robinhood Chain…", "Analyzing market data…",
                                    "Checking news feeds…", "Reading pages…", "Writing the answer…"
intent.detected    { intents, unified, primary, method }
plan.created       { plan }                 (initial plan; the final plan is in response.completed)
tool.started       { step, capability, tool, label }
tool.completed     { run: { step, tool, status, ms, attempts, cached, error } }
source.discovered  { source }               (one per ranked source, with authority/family)
model.selected     { provider, model, tier }
response.delta     { text }                 (secrets redacted mid-stream)
response.completed { response }             (the full VeyraResponse)
error              { error }
```

No model reasoning or prompt content is ever streamed. Send `"streamFormat": "v1"` for the legacy events.

### Response contract (`POST /chat`)

```jsonc
{
  "id": "…request id…",
  "type": "normal | research | github | onchain | market | combined",
  "answer": "…markdown with [n] citations…",
  "grounded": true,
  "sources": [{ "id": 1, "title": "…", "url": "…", "domain": "…", "type": "onchain", "family": "onchain", "authority": "direct",
                "evidence": "live_data", "provider": "robinhood-chain", "retrievedAt": "…", "publishedAt": "…", "relevance": 1, "snippet": "…" }],
  "citations": { "used": [1, 2], "invalid": [], "statements": [{ "text": "…", "sourceIds": [1] }] },
  "knowledge": { "facts": {…}, "inferences": {…}, "unknowns": [], "uncited": 0 },
  "data": { "chain.data": [{ "tool": "robinhood-chain", "data": {…} }], "market.data": [{ "tool": "geckoterminal", "data": {…} }] },
  "plan": { "intents": […], "unifiedIntents": ["ROBINHOOD_ONCHAIN", "MARKET", "ONCHAIN_MARKET"], "model": { "tier": "fast", "reasons": […], "candidates": […] },
            "tools": [{ "step": "chain.data#1", "why": "…", "phase": 1, "dependsOn": [], "maxAttempts": 1, "freshness": "live" }], "maxToolCalls": 2,
            "unavailable": [], "skipped": [], "blockedUrls": [] },
  "retrieval": { "sourcesUsed": 3, "byFamily": { "onchain": 2, "market": 1 }, "cacheHits": 0, "duplicatesRemoved": 0, … },
  "security": { "flaggedSources": [], "blockedUrls": [], "removedLinks": [], "redactions": [] },
  "toolRuns": […], "model": { "provider": "groq", "model": "…", "fallbackUsed": false, "cached": false, "attempts": […] },
  "timings": { "totalMs": …, "toolsMs": …, "llmMs": … }, "warnings": []
}
```

`type` drives the future UI:
- `combined` = two or more kinds of data were used (e.g. on-chain + market, GitHub + web);
- `research` = web/news only;
- `github` / `onchain` / `market` = a single specialist source.

### Failure strategy

| Failure | Behaviour |
|---|---|
| Web search unavailable | Answer from the other sources. `knowledge.unknowns` and `warnings` say web data is missing. |
| GitHub unavailable | Rate limit or timeout: the repo page is read instead. 404: "not found / private". Either way it's stated. |
| GeckoTerminal unavailable | On-chain data still answers; market metrics are listed as unknown, never inferred from transfers |
| LLM provider unavailable | The next configured provider is used (`model.fallbackUsed`, logged as `model.fallback`) |
| Everything unavailable | `grounded: false`, no sources; the model is told exactly which data is missing and says so |

### Observability

Structured JSON logs, every line carrying `requestId`:

| Log line | Fields |
|---|---|
| `request.started` | sizes only (never content) |
| `intent.detected` | intents, unified, method, signals |
| `plan.created` | tier, reasons, steps |
| `tool.completed` | step, tool, status, ms, cached, attempts, error kind |
| `tool.fallback` | which source was replaced, and by what |
| `model.retiered` | the tier changed after retrieval |
| `context.built` | sources, byFamily, duplicates, dropped, contextChars, cacheHits, unavailable |
| `model.fallback` | the provider/model that answered after a fallback |
| `request.completed` | type, provider, model, cache, grounded, totalMs |

Secrets and message content are never logged.

### Example requests (verified live, real APIs, dev-mock LLM)

| Request | Result |
|---|---|
| `{"message":"Analyze this token on Robinhood Chain 0x5fc5…d168","stream":true}` | `request.started → status → intent.detected → plan.created → tool.started ×2 (parallel) → tool.completed ×2 → source.discovered ×3 → model.selected → response.delta… → response.completed`. `type=combined`, unified `ROBINHOOD_ONCHAIN, MARKET, ONCHAIN_MARKET`, all sources `direct`. 5.3 s. |
| `{"message":"What happened in AI today?"}` | `news.feed#1[p1] → web.extract#r1[p3]`, 8 sources, `type=research`. 3.8 s. |
| `{"message":"What about liquidity?","history":[…token…]}` | Resolved to the earlier token, `market.data#1`, answered from cache. 7 ms. |
| `{"message":"Research this project deeply https://github.com/honojs/hono"}` | `type=combined`, `DEEP_RESEARCH, GITHUB, COMBINED_RESEARCH`, reasoning tier, GitHub + project site. `knowledge.unknowns`: web search not configured. 6.0 s. |
| `{"message":"What is 2+2?"}` | No tools, `type=normal`. 6 ms. |

---

## API

### `POST /chat`

```jsonc
{
  "message": "What happened on Robinhood Chain today?",   // required
  "model": "auto",          // "auto" | "openrouter" | "gemini" | "groq" | "<provider>:<model id>"
  "mode": "auto",           // "auto" | "research"
  "strictModel": false,     // true = never fall back from the chosen provider/model
  "stream": false,          // true = Server-Sent Events
  "history": [{ "role": "user", "content": "…" }, { "role": "assistant", "content": "…" }],
  // optional: structured references from earlier answers, so "what about its liquidity?" can resolve "it"
  "context": { "entities": { "addresses": ["0x…"], "githubRepos": ["owner/repo"], "txHashes": ["0x…"], "urls": ["https://…"], "tickers": ["USDG"] } }
}
```

If `VEYRA_API_KEY` is set, send `Authorization: Bearer <key>`.

**Conversations.** The web app keeps conversations in the browser (`localStorage`, key `veyra.conversations.v1`; capped at 50 chats / 100 messages each / ~2 MB, oldest inactive chats removed first) and is addressable at `/chat/<conversationId>`. Each request sends bounded follow-up context: the last 6 messages (user text clipped to 1,000 chars, assistant answers summarized to ~600) plus `context.entities` (at most 5 addresses, 3 repos, 3 tx hashes, 5 URLs, 5 tickers — strictly validated). The server treats both as untrusted: references only feed the follow-up resolvers (never the model), URLs still pass the URL safety check, and the system prompt marks earlier messages as context, not instructions.

**Example** (`curl`; in PowerShell use `curl.exe` and a body file):

```bash
curl -s http://127.0.0.1:8787/chat -H "Content-Type: application/json" \
  -d '{"message":"Explain what an L2 rollup is in two sentences"}'
```

**Response** (abridged):

```jsonc
{
  "id": "3baa45e5-…",
  "type": "normal",                 // normal | research | github | onchain | market
  "answer": "An L2 rollup executes transactions off the main chain…",
  "grounded": true,                 // false = needed live data that couldn't be retrieved
  "sources": [],                    // [{ id, title, url, domain, type, evidence, provider, alsoFoundBy?, publishedAt, retrievedAt, relevance, snippet }]
  "citations": { "used": [], "invalid": [], "statements": [] },
  "data": {},                       // { [capability]: [{ tool, step, data }] }: structured payloads for type-specific UI
  "plan": {
    "intents": ["general"], "primaryIntent": "general", "intentMethod": "rules",
    "entities": { "urls": [], "githubRepos": [], "addresses": [], "txHashes": [], "tickers": [] },
    "tier": "fast",
    "tools": [],                    // [{ step, capability, strategy, query, candidates: [primary, fallback] }]
    "unavailable": [],              // [{ capability, reason }]: required data that could not be obtained
    "skipped": []                   // [{ capability, reason }]: deliberately not used
  },
  "retrieval": { "resultsFound": 0, "duplicatesRemoved": 0, "droppedByLimit": 0, "sourcesUsed": 0 },
  "toolRuns": [],                   // [{ step, capability, tool, status, ms, cached?, error? }]
  "model": {
    "provider": "groq", "model": "llama-3.3-70b-versatile",
    "fallbackUsed": false, "cached": false,
    "attempts": [{ "provider": "groq", "model": "llama-3.3-70b-versatile", "ok": true, "ms": 412 }]
  },
  "usage": { "inputTokens": 512, "outputTokens": 61 },
  "timings": { "totalMs": 430, "toolsMs": 0, "llmMs": 425 },
  "warnings": []
}
```

**Streaming** (`"stream": true`) uses the v2 event contract described in [Streaming contract](#streaming-contract). Send `"streamFormat": "v1"` for the legacy `plan → sources → model → delta → done` events. Fallback to another model is possible only before the first token.

**Errors**: `400` validation · `401` bad bearer token · `503` no model could answer (includes per-provider `attempts` and `skipped` reasons) · `500` internal (details only in server logs).

### `GET /health`
Shows which providers and tools are configured, plus today's request counts against limits. It never returns key values.

### `GET /models`
Lists the choices for a UI model picker (Auto, configured providers, and specific models from the routing tiers).

---

## How routing works

**Intent** (`router/intent.ts`): regex/entity rules, free and deterministic. They detect GitHub URLs, `0x` addresses vs. 64-hex tx hashes, `$TICKERS`, and keywords. With `VEYRA_INTENT_MODE=hybrid`, low-confidence results are re-checked by the cheapest available model through `structuredGenerate()`.

**Model** (`router/model-router.ts`, `config/routing.ts`): each intent maps to a tier (`cheap`, `fast`, `coding`, `reasoning`). Each tier has an ordered candidate list:

| Tier | Used for | Default order |
|---|---|---|
| cheap | summarize | OpenRouter gpt-oss-20b → Gemini flash-lite-latest → Groq gpt-oss-20b |
| fast | general, web, news, chain, market | OpenRouter gpt-oss-120b → Gemini flash-lite-latest → Groq gpt-oss-120b → OpenRouter gpt-oss-20b |
| coding | coding, GitHub | OpenRouter qwen3-coder → Gemini 3.8 Flash → Groq gpt-oss-120b |
| reasoning | research | OpenRouter deepseek-v4-pro → Gemini 3.8 Flash → Groq gpt-oss-120b |

OpenRouter is the primary provider, Gemini the cross-provider fallback, Groq the third. Streaming uses the same order (set `VEYRA_STREAM_PREFER_GROQ=true` to send streamed answers to Groq first for the lowest latency). Each model is tried at most once, capped by `VEYRA_MAX_MODEL_ATTEMPTS`; OpenRouter is also capped by `OPENROUTER_DAILY_REQUEST_LIMIT`. Model IDs change often (verified 2026-10-08: Gemini 2.5 and Groq Llama models are no longer offered to new keys), so override them without code changes: copy `routing.example.json`, then set `VEYRA_ROUTING_FILE`.

**Fallback**: a failed candidate is skipped and the next one is tried. Rate limits put that model on cooldown, while quota or auth failures cool down the whole provider. Unconfigured providers are never called. Identical prompts are served from cache.

**Tools** (`router/tool-router.ts`):
- Intents map to required, optional and fallback capabilities (`web.search`, `web.extract`, `github.repo`, `news.feed`, `chain.data`, `market.data`).
- Each capability uses its most suitable configured tool, plus one fallback. Only research uses both web providers at once.
- General and coding questions call **no** tools.
- A missing required capability is reported to the model and the user, never faked.
- An authoritative primary source suppresses secondary web search: chain data for on-chain questions, the GitHub API for repositories.

See [Web intelligence](#web-intelligence-phase-4-tavily--exa) for details.

---

## Adding a tool

For complete, real examples, see:
- `src/providers/search/tavily.ts` and `exa.ts` (search);
- `src/providers/web/jina.ts` and `firecrawl.ts` (extraction);
- `src/providers/github/tool.ts` (multi-endpoint API with planning and limits);
- `src/providers/news/tool.ts` (cached corpus + search);
- `src/providers/blockchain/tool.ts` (RPC + explorer with fallback);
- `src/providers/market/tool.ts` (strictly validated market data with a stale fallback).

New tools get sanitization, URL checks and output guards automatically. The shape:

1. Create e.g. `src/providers/<area>/<name>.ts` exporting a `ToolFactory`:

```ts
export const exaTool: ToolFactory = (env) => ({
  name: "exa",
  description: "Neural web search",
  capabilities: ["web.search"],
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.object({ results: z.array(/* … */) }),
  auth: { envKeys: ["EXA_API_KEY"] },
  rateLimit: { requestsPerMinute: 30 },
  costTier: "low",
  cacheTtlSeconds: 900,          // 0 for live chain/market data
  isConfigured: () => Boolean(env.EXA_API_KEY),
  planInput: ({ query }) => ({ query }),
  async execute(input, { signal }) {
    const json = await httpJson(/* … */, { source: "tool:exa", signal, timeoutMs: 10_000, /* … */ });
    return { data: json, sources: json.results.map(r => ({ title: r.title, url: r.url, type: "web", evidence: "search_result", content: r.text, relevance: r.score })) };
  },
});
```

2. Add it to `TOOL_FACTORIES` in `src/tools/registry.ts`.

Routing, fallback (e.g. Exa → Tavily for `web.search`), caching, rate limiting, timeouts, source dedupe and citations all apply automatically.

---

## Security and cost principles built in

- Keys live only in env vars. Gemini's key goes in a header, never a URL. `/health` reports only `configured: true/false`.
- `/chat` requires a bearer token when `VEYRA_API_KEY` is set. The server binds to `127.0.0.1` by default and warns if it's exposed without a token.
- Retrieved content is sanitized, fenced and treated as untrusted data. Unsafe URLs are never fetched. Answers are scrubbed of secrets and unverified links. See [Security: untrusted web content](#security-untrusted-web-content).
- The model may only state live facts that come from the provided sources, and may only output URLs that are sources or that the user wrote.
- Request budgets per provider per day, bounded context (`VEYRA_MAX_CONTEXT_CHARS`), bounded history, bounded tool steps, and caching for LLM and tool calls.

### Production hardening (Phase 13)

| Area | What happens | Config |
|---|---|---|
| Secrets | Stay server-side; startup logs `configured/missing/default/disabled` only; every log line is scrubbed (env secret values, key formats, bearer tokens, `apikey=` params, RPC-URL keys). `/health` = booleans only. | — |
| Rate limits | Per client on `POST /chat` → `429 Too many requests. Please try again shortly.` + `Retry-After`. Research / 3+-source requests have a smaller second allowance. Off for local dev with the mock LLM, always on in production. | `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_HEAVY_MAX_REQUESTS`, `RATE_LIMIT_ENABLED`, `TRUST_PROXY` |
| Request limits | Body, message and history size checked before any provider runs (400/413). | `VEYRA_MAX_BODY_BYTES`, `VEYRA_MAX_MESSAGE_CHARS`, `VEYRA_MAX_HISTORY_CHARS` |
| Cost ceilings | Hard tool budget per request (retries, fallbacks, follow-ups included); fallback chain capped, each model at most once. | `VEYRA_MAX_TOOL_CALLS_PER_REQUEST`, `VEYRA_MAX_MODEL_ATTEMPTS` |
| Timeouts | Every external call has a timeout + abort; bounded retries; one whole-request deadline → `504` (or an SSE `error` event). | `VEYRA_REQUEST_TIMEOUT_MS` (+ per-provider timeouts) |
| SSE | Client disconnect aborts tools and the model; output capped; errors sanitized. | `VEYRA_MAX_STREAM_CHARS` |
| URLs | http(s) only; no credentials, localhost, private/link-local/metadata IPs, intranet names, odd ports; **every redirect hop is re-checked** and credentials never follow a cross-origin redirect. | `VEYRA_BLOCKED_DOMAINS` |
| Errors | Public bodies are `{kind, message}`: no stacks, paths, keys or prompts; production omits even sanitized details. | `NODE_ENV=production` |
| Headers | CSP (own scripts only, no inline/eval, no framing), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP; HSTS in production; `/chat` is `no-store`. | — |
| CORS | Explicit allow-list; dev allows localhost; production allows none unless listed; `*` refused in production. | `VEYRA_CORS_ORIGIN` / `CORS_ORIGIN` |
| Logs | One JSON line per request: request id (`X-Request-Id`), endpoint, status, latency; pipeline logs add intent, tools, provider. Never headers, IPs, message text or conversation ids. | `VEYRA_LOG_LEVEL` |

> In-memory caches, budgets, cooldowns and rate limits are per process. Move them to Redis/KV (or enforce limits at the edge) before running multiple instances.
