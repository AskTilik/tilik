import { z } from "zod";

/**
 * All configuration comes from environment variables. Secrets are never
 * hardcoded and never leave the backend (see /health which only reports
 * whether a provider is configured, not its key).
 */

const int = (fallback: number) => z.coerce.number().int().nonnegative().default(fallback);
const optional = z.string().trim().optional();
const flag = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");
const flagDefault = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === "true" || v === "1"));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: int(8787),
  VEYRA_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** Optional bearer token protecting /chat. Strongly recommended outside localhost. */
  VEYRA_API_KEY: optional,
  /** Allowed browser origin(s) for cross-origin calls, comma-separated (e.g. https://veyra.example). CORS_ORIGIN is an alias. */
  VEYRA_CORS_ORIGIN: optional,
  CORS_ORIGIN: optional,
  /** Behind a reverse proxy: take the client IP from X-Forwarded-For (only enable when the proxy sets it). */
  TRUST_PROXY: flag,

  // ── Abuse protection (Phase 13) ──────────────────────────────────────────
  /** Rate limiting on POST /chat. Default: on, except development with the mock LLM. */
  RATE_LIMIT_ENABLED: z.enum(["true", "false", "1", "0"]).optional(),
  RATE_LIMIT_WINDOW_MS: int(60_000),
  /** Requests per client per window. */
  RATE_LIMIT_MAX_REQUESTS: int(20),
  /** Expensive requests (research mode, multi-source workflows) per client per window. */
  RATE_LIMIT_HEAVY_MAX_REQUESTS: int(5),
  /** Request body bytes accepted by /chat. */
  VEYRA_MAX_BODY_BYTES: int(256 * 1024),
  /** Characters in one message (the schema's hard ceiling is 8000). */
  VEYRA_MAX_MESSAGE_CHARS: int(8000),
  /** Characters across all history messages in one request. */
  VEYRA_MAX_HISTORY_CHARS: int(24_000),
  /** Hard cap on tool executions (including retries and fallbacks) in one request. Cached answers don't count. */
  VEYRA_MAX_TOOL_CALLS_PER_REQUEST: int(12),
  /** Models tried per answer (fallback chain length). Each is tried at most once — no loops. */
  VEYRA_MAX_MODEL_ATTEMPTS: int(4),
  /** Whole-request deadline (tools + model + streaming). */
  VEYRA_REQUEST_TIMEOUT_MS: int(120_000),
  /** Streamed answer size cap (characters); the stream ends cleanly with a notice when reached. */
  VEYRA_MAX_STREAM_CHARS: int(60_000),

  // ── LLM providers ────────────────────────────────────────────────────────
  OPENROUTER_API_KEY: optional,
  OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_DEFAULT_MODEL: z.string().default("openai/gpt-oss-120b"),
  OPENROUTER_APP_URL: optional,
  OPENROUTER_APP_NAME: z.string().default("TILIK"),
  OPENROUTER_DAILY_REQUEST_LIMIT: int(200),

  GEMINI_API_KEY: optional,
  GEMINI_BASE_URL: z.url().default("https://generativelanguage.googleapis.com/v1beta"),
  /** Last-resort Gemini model (the 2.5 family is no longer available to new keys; verified 2026-10-08). */
  GEMINI_DEFAULT_MODEL: z.string().default("gemini-flash-lite-latest"),
  GEMINI_DAILY_REQUEST_LIMIT: int(1000),

  GROQ_API_KEY: optional,
  /** Optional second Groq key, used only if GROQ_API_KEY is rejected (revoked/invalid). Not a rate-limit workaround. */
  GROQ_API_KEY_BACKUP: optional,
  GROQ_BASE_URL: z.url().default("https://api.groq.com/openai/v1"),
  /** Llama models are no longer available to new Groq keys (verified 2026-10-08). */
  GROQ_DEFAULT_MODEL: z.string().default("openai/gpt-oss-120b"),
  /** true = streamed answers go to Groq first (lowest latency). Default: the normal order (OpenRouter primary). */
  VEYRA_STREAM_PREFER_GROQ: flag,
  GROQ_DAILY_REQUEST_LIMIT: int(1000),

  // ── Routing & cost control ───────────────────────────────────────────────
  VEYRA_ROUTING_FILE: optional,
  VEYRA_INTENT_MODE: z.enum(["rules", "hybrid"]).default("rules"),
  VEYRA_MAX_OUTPUT_TOKENS: int(4000),
  VEYRA_MAX_CONTEXT_CHARS: int(24000),
  VEYRA_MAX_HISTORY_MESSAGES: int(10),
  VEYRA_MAX_TOOL_STEPS: int(4),
  VEYRA_LLM_TIMEOUT_MS: int(60000),
  VEYRA_TOOL_TIMEOUT_MS: int(15000),
  VEYRA_CACHE_TTL_SECONDS: int(600),
  /** Development only: registers a clearly-labelled mock LLM as the last fallback. */
  VEYRA_DEV_MOCK_LLM: flag,

  // ── Storage: Upstash Redis (holder history, shared answers) ─────────────
  UPSTASH_REDIS_REST_URL: z.url().optional(),
  UPSTASH_REDIS_REST_TOKEN: optional,
  /** Vercel sends it as a Bearer token on cron calls; cron routes refuse other callers. */
  CRON_SECRET: optional,

  // ── Telegram bot (@asktilik_bot): /check, watchlist alerts, daily report ──
  TELEGRAM_BOT_TOKEN: optional,
  /** Telegram echoes it in X-Telegram-Bot-Api-Secret-Token on every webhook call. */
  TELEGRAM_WEBHOOK_SECRET: optional,

  // ── Web search (Phase 4) ─────────────────────────────────────────────────
  TAVILY_API_KEY: optional,
  TAVILY_BASE_URL: z.url().default("https://api.tavily.com"),
  /** Tavily free plan: 1,000 credits/month ≈ 33/day. 0 = unlimited. */
  TAVILY_DAILY_REQUEST_LIMIT: int(30),
  EXA_API_KEY: optional,
  EXA_BASE_URL: z.url().default("https://api.exa.ai"),
  EXA_DAILY_REQUEST_LIMIT: int(30),
  /** Results requested per search call. */
  VEYRA_SEARCH_MAX_RESULTS: int(5),
  VEYRA_SEARCH_CACHE_TTL_SECONDS: int(900),
  /** Sources passed to the model for a normal web answer. */
  VEYRA_MAX_SOURCES: int(8),
  /** Research mode: search queries per request (1 = no query expansion). */
  VEYRA_RESEARCH_MAX_QUERIES: int(3),
  VEYRA_RESEARCH_MAX_SOURCES: int(12),
  /** llm = cheap model writes the sub-queries; rules = deterministic, zero cost. */
  VEYRA_RESEARCH_PLANNER: z.enum(["llm", "rules"]).default("llm"),

  // ── Web extraction (Phase 5) ─────────────────────────────────────────────
  /** Optional: Jina Reader works without a key at 20 req/min; a free key raises it to 500. */
  JINA_API_KEY: optional,
  JINA_BASE_URL: z.url().default("https://r.jina.ai"),
  /** Allow keyless Jina (free, rate-limited). Set false to require a key. */
  JINA_ALLOW_KEYLESS: flagDefault(true),
  JINA_DAILY_REQUEST_LIMIT: int(200),
  FIRECRAWL_API_KEY: optional,
  FIRECRAWL_BASE_URL: z.url().default("https://api.firecrawl.dev"),
  FIRECRAWL_DAILY_REQUEST_LIMIT: int(30),
  /** Which extractor to try first; the other is the fallback. */
  VEYRA_EXTRACT_PRIMARY: z.enum(["jina", "firecrawl"]).default("jina"),
  /** Direct URLs extracted per request. */
  VEYRA_EXTRACT_MAX_URLS: int(3),
  /** Characters kept per extracted page (before the context budget applies). */
  VEYRA_EXTRACT_MAX_CHARS: int(20000),
  VEYRA_EXTRACT_CACHE_TTL_SECONDS: int(3600),
  /** Research mode: top search results (snippet-only) to fetch in full. 0 disables. */
  VEYRA_RESEARCH_EXTRACT_TOP: int(2),
  /** Comma-separated domains never fetched or cited, e.g. "badsite.com,tracker.io". */
  VEYRA_BLOCKED_DOMAINS: optional,
  /** Extra domains ranked as reputable by the context builder (comma-separated). */
  VEYRA_TRUSTED_DOMAINS: optional,

  // ── GitHub (Phase 6) ─────────────────────────────────────────────────────
  /** Optional: unauthenticated = 60 API requests/hour per IP; a token = 5,000/hour and private repos it can access. */
  GITHUB_TOKEN: optional,
  GITHUB_API_URL: z.url().default("https://api.github.com"),
  GITHUB_RAW_URL: z.url().default("https://raw.githubusercontent.com"),
  /** Use the public API without a token (and retry without it if the token is rejected). */
  GITHUB_ALLOW_UNAUTHENTICATED: flagDefault(true),
  /** Files whose content is fetched per question (MAX_GITHUB_FILES). */
  GITHUB_MAX_FILES: int(6),
  /** Bytes read per file — larger files are cut (MAX_FILE_SIZE). */
  GITHUB_MAX_FILE_SIZE: int(60000),
  /** Characters of README + file content per question (MAX_TOTAL_CONTENT). */
  GITHUB_MAX_TOTAL_CONTENT: int(20000),
  GITHUB_MAX_COMMITS: int(10),
  GITHUB_MAX_ISSUES: int(10),
  GITHUB_MAX_PR_RESULTS: int(10),
  GITHUB_MAX_RELEASES: int(5),
  GITHUB_MAX_CONTRIBUTORS: int(10),
  /** Tree entries considered when searching for files (huge monorepos are truncated by GitHub at 100k). */
  GITHUB_MAX_TREE_ENTRIES: int(50000),
  /** Hard cap on GitHub API calls per question (raw file downloads don't count against GitHub's API quota). */
  GITHUB_MAX_REQUESTS_PER_QUESTION: int(12),
  /** Repositories handled per question (e.g. "compare A and B"). */
  GITHUB_MAX_REPOS: int(2),
  GITHUB_DAILY_REQUEST_LIMIT: int(500),
  GITHUB_CACHE_TTL_SECONDS: int(900),
  /** Private repository content is kept in memory only briefly. */
  GITHUB_PRIVATE_CACHE_TTL_SECONDS: int(60),
  GITHUB_TIMEOUT_MS: int(30000),

  // ── Robinhood Chain (Phase 8) — defaults from docs.robinhood.com/chain/connecting ──
  ONCHAIN_ENABLED: flagDefault(true),
  /** mainnet (chain 4663) | testnet (chain 46630): selects the official defaults below. */
  ROBINHOOD_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
  /** RPC endpoint. Default: the official public RPC (rate-limited). For production use a provider URL (e.g. Alchemy). */
  ROBINHOOD_RPC_URL: optional,
  /** Extra RPC endpoints tried when the primary fails (comma-separated). */
  ROBINHOOD_RPC_FALLBACK_URLS: optional,
  /** Expected chain ID; the RPC is verified against it before any data is used. */
  ROBINHOOD_CHAIN_ID: z.coerce.number().int().positive().optional(),
  /** Block explorer (links). Default: the official explorer for the network. "none" disables. */
  ROBINHOOD_EXPLORER_URL: optional,
  /**
   * Blockscout v2 API (history, labels, stats). Default: Blockscout PRO API
   * (https://api.blockscout.com/<chainId>/api/v2) when ROBINHOOD_EXPLORER_API_KEY is set; otherwise none.
   * "none" disables.
   */
  ROBINHOOD_EXPLORER_API_URL: optional,
  /** Free key at https://dev.blockscout.com (100K credits/day, 5 req/s). Sent as ?apikey=. */
  ROBINHOOD_EXPLORER_API_KEY: optional,
  /** Blocks scanned for "recent activity" when RPC is the only source (~0.1 s per block). */
  ONCHAIN_BLOCK_WINDOW: int(20),
  /** Transactions listed per analysis (MAX_TRANSACTIONS). */
  ONCHAIN_MAX_TRANSACTIONS: int(25),
  /** Event logs decoded per analysis (MAX_LOG_RESULTS). */
  ONCHAIN_MAX_LOG_RESULTS: int(200),
  /** Addresses / transactions analysed per question (MAX_ADDRESSES). */
  ONCHAIN_MAX_ADDRESSES: int(3),
  ONCHAIN_MAX_RPC_CALLS: int(25),
  ONCHAIN_MAX_EXPLORER_CALLS: int(12),
  ONCHAIN_RPC_TIMEOUT_MS: int(10000),
  /** Retries per RPC call (with exponential backoff; never unbounded). */
  ONCHAIN_RPC_RETRIES: int(2),
  ONCHAIN_TIMEOUT_MS: int(30000),
  /** Stable data: mined blocks, receipts, token metadata, contract info. */
  ONCHAIN_CACHE_TTL_SECONDS: int(3600),
  /** Live data: latest block, balances, recent activity, stats. */
  ONCHAIN_LIVE_TTL_SECONDS: int(10),
  ONCHAIN_DAILY_REQUEST_LIMIT: int(2000),

  // ── Market data: GeckoTerminal (Phase 9) ─────────────────────────────────
  MARKET_ENABLED: flagDefault(true),
  GECKOTERMINAL_API_URL: z.url().default("https://api.geckoterminal.com/api/v2"),
  /** GeckoTerminal network id — verified: Robinhood Chain = "robinhood" (2026-10-06). */
  GECKOTERMINAL_NETWORK: z.string().trim().min(1).default("robinhood"),
  /** Public API limit is 30 calls/minute; stay below it. */
  GECKOTERMINAL_RATE_LIMIT_PER_MINUTE: int(25),
  GECKOTERMINAL_TIMEOUT_MS: int(10000),
  GECKOTERMINAL_RETRIES: int(1),
  /** Live prices / pool stats (seconds). GeckoTerminal itself refreshes roughly every minute. */
  MARKET_CACHE_TTL: int(30),
  /** Pool lists (top pools, a token's pools). */
  POOL_CACHE_TTL: int(60),
  /** Token name/symbol/decimals, network list. */
  TOKEN_METADATA_CACHE_TTL: int(3600),
  /** If GeckoTerminal is down, last-known data up to this age may be shown — always labelled stale. 0 = never. */
  MARKET_STALE_MAX_SECONDS: int(900),
  MARKET_MAX_POOLS: int(5),
  MARKET_MAX_TRADES: int(15),
  MARKET_OHLCV_DAYS: int(7),
  MARKET_MAX_REQUESTS_PER_QUESTION: int(6),
  MARKET_DAILY_REQUEST_LIMIT: int(2000),

  // ── Reserved for later phases ────────────────────────────────────────────
  ETHERSCAN_API_KEY: optional,
  // ── RSS / news (Phase 7) ─────────────────────────────────────────────────
  RSS_ENABLED: flagDefault(true),
  /** Feed list: JSON file ({"feeds":[{name,url,category,source?,enabled?}]}). */
  RSS_FEEDS_FILE: z.string().default("feeds.json"),
  /** Inline JSON feed list (overrides the file). */
  RSS_FEEDS_JSON: optional,
  /** Quick override: comma/newline separated "url" or "category|name|url" entries (overrides the file). */
  RSS_FEEDS: optional,
  /** A feed is re-fetched at most this often; requests in between use the cached copy. */
  RSS_REFRESH_MINUTES: int(15),
  RSS_TIMEOUT_MS: int(8000),
  RSS_MAX_FEEDS_PER_REQUEST: int(12),
  RSS_MAX_ITEMS_PER_FEED: int(50),
  RSS_MAX_FEED_BYTES: int(2_000_000),
  /** After a feed fails it is not retried for this long (its last good copy is used meanwhile). */
  RSS_FAILURE_BACKOFF_MINUTES: int(10),
  /** Default freshness window; questions can narrow/widen it ("last 6 hours", "this week"). */
  NEWS_MAX_AGE_HOURS: int(24),
  NEWS_MAX_STORIES: int(8),
  /** Fewer matching RSS stories than this → complement with web search. */
  NEWS_MIN_RSS_STORIES: int(3),
  /** auto = RSS first, web search only when it adds coverage; always | never. */
  NEWS_WEB_COMPLEMENT: z.enum(["auto", "always", "never"]).default("auto"),
  /** Top stories (with thin RSS text) read in full via Jina/Firecrawl. 0 = never. */
  NEWS_EXTRACT_TOP: int(1),
});

export type Env = z.infer<typeof EnvSchema>;

/** Every variable that holds a credential. Values are never logged, returned or shown — only "configured"/"missing". */
export const SECRET_ENV_KEYS = [
  "VEYRA_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "GROQ_API_KEY_BACKUP",
  "TAVILY_API_KEY",
  "EXA_API_KEY",
  "JINA_API_KEY",
  "FIRECRAWL_API_KEY",
  "GITHUB_TOKEN",
  "ROBINHOOD_EXPLORER_API_KEY",
  "ETHERSCAN_API_KEY",
  "UPSTASH_REDIS_REST_TOKEN",
  "CRON_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
] as const;

/** RPC URLs often embed a provider key in the path or query (e.g. Alchemy). Treated as secrets too. */
const SECRET_URL_KEYS = ["ROBINHOOD_RPC_URL", "ROBINHOOD_RPC_FALLBACK_URLS"] as const;

/** Values to scrub from any log line (exact matches), including credential parts of RPC URLs. */
export function secretValues(env: Env): string[] {
  const values: string[] = [];
  for (const k of SECRET_ENV_KEYS) if (env[k]) values.push(env[k]);
  for (const k of SECRET_URL_KEYS) {
    for (const raw of (env[k] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      try {
        const u = new URL(raw);
        // The host is public; path segments / query values that look like keys are not.
        for (const seg of u.pathname.split("/")) if (seg.length >= 16) values.push(seg);
        for (const v of u.searchParams.values()) if (v.length >= 8) values.push(v);
        if (u.password) values.push(u.password);
      } catch {
        values.push(raw);
      }
    }
  }
  return [...new Set(values.filter((v) => v.length >= 8))];
}

export function corsOrigins(env: Env): string[] {
  return (env.VEYRA_CORS_ORIGIN ?? env.CORS_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

export function rateLimitEnabled(env: Env): boolean {
  if (env.RATE_LIMIT_ENABLED !== undefined) return env.RATE_LIMIT_ENABLED === "true" || env.RATE_LIMIT_ENABLED === "1";
  // Local development against the mock LLM spends nothing: don't get in the way. Production is always protected.
  return !(env.VEYRA_DEV_MOCK_LLM && env.NODE_ENV !== "production");
}

export type ConfigStatus = { group: string; name: string; status: "configured" | "missing" | "default" | "disabled"; note?: string };

/**
 * Safe configuration report for startup logs: classifies what is set, never includes a value.
 * Nothing is strictly required to start; at least one LLM provider is required to answer.
 */
export function configStatus(env: Env): ConfigStatus[] {
  const has = (v: string | undefined): ConfigStatus["status"] => (v ? "configured" : "missing");
  return [
    { group: "llm (≥1 required to answer)", name: "OpenRouter", status: has(env.OPENROUTER_API_KEY) },
    { group: "llm (≥1 required to answer)", name: "Gemini", status: has(env.GEMINI_API_KEY) },
    { group: "llm (≥1 required to answer)", name: "Groq", status: has(env.GROQ_API_KEY) },
    { group: "llm (≥1 required to answer)", name: "Groq backup key", status: has(env.GROQ_API_KEY_BACKUP), note: "used only if the main Groq key is rejected" },
    { group: "llm (≥1 required to answer)", name: "Dev mock LLM", status: env.VEYRA_DEV_MOCK_LLM ? "configured" : "disabled", note: "development only" },
    { group: "storage (optional)", name: "Upstash Redis", status: has(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN ? "yes" : undefined) },
    { group: "bots (optional)", name: "Telegram bot", status: has(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET ? "yes" : undefined) },
    { group: "web (optional)", name: "Tavily", status: has(env.TAVILY_API_KEY) },
    { group: "web (optional)", name: "Exa", status: has(env.EXA_API_KEY) },
    { group: "web (optional)", name: "Jina", status: env.JINA_API_KEY ? "configured" : env.JINA_ALLOW_KEYLESS ? "default" : "missing", note: env.JINA_API_KEY ? undefined : "keyless, rate-limited" },
    { group: "web (optional)", name: "Firecrawl", status: has(env.FIRECRAWL_API_KEY) },
    { group: "github (optional)", name: "GitHub token", status: env.GITHUB_TOKEN ? "configured" : "default", note: env.GITHUB_TOKEN ? undefined : "unauthenticated, 60 req/h" },
    { group: "chain (optional)", name: "Robinhood RPC", status: !env.ONCHAIN_ENABLED ? "disabled" : env.ROBINHOOD_RPC_URL ? "configured" : "default", note: env.ROBINHOOD_RPC_URL ? undefined : "public RPC, rate-limited" },
    { group: "chain (optional)", name: "Blockscout explorer key", status: has(env.ROBINHOOD_EXPLORER_API_KEY) },
    { group: "market (optional)", name: "GeckoTerminal", status: env.MARKET_ENABLED ? "default" : "disabled", note: "no key needed" },
    { group: "security", name: "VEYRA_API_KEY (bearer on /chat)", status: has(env.VEYRA_API_KEY), note: "recommended outside localhost" },
    { group: "security", name: "CORS origins", status: corsOrigins(env).length ? "configured" : "default", note: corsOrigins(env).length ? undefined : env.NODE_ENV === "production" ? "same-origin only" : "localhost only" },
    { group: "security", name: "Rate limiting", status: rateLimitEnabled(env) ? "configured" : "disabled" },
  ];
}

/** Configuration that is unsafe in production. Returned as messages (no values); the server refuses to start. */
export function productionProblems(env: Env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  if (env.VEYRA_DEV_MOCK_LLM) problems.push("VEYRA_DEV_MOCK_LLM must not be enabled in production.");
  if (corsOrigins(env).includes("*")) problems.push("CORS origin '*' is not allowed in production: list the allowed origins explicitly.");
  return problems;
}

export function blockedDomains(env: Env): string[] {
  return (env.VEYRA_BLOCKED_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // Treat `KEY=` (empty) the same as unset so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
