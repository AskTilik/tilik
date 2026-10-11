import { z } from "zod";
import type { Knowledge } from "../core/claims.js";
import type { Tier } from "../config/routing.js";
import type { ErrorKind } from "../core/errors.js";
import type { TokenUsage } from "../providers/llm/types.js";
import type { Entities, Intent } from "../router/intent.js";
import type { Attempt } from "../router/model-router.js";
import type { ExplainedStep, UnifiedIntent } from "../router/unified.js";
import type { ToolRun } from "../tools/runner.js";
import type { Source } from "../sources/types.js";

export const ChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  /** "auto" | "openrouter" | "gemini" | "groq" | "<provider>:<model id>" */
  model: z.string().max(200).default("auto"),
  /** "research" forces the research workflow even without research keywords. */
  mode: z.enum(["auto", "research"]).default("auto"),
  /** When true, never fall back away from the chosen provider/model. */
  strictModel: z.boolean().default(false),
  stream: z.boolean().default(false),
  /**
   * SSE event format. "v2" (default): request.started → intent.detected → plan.created → status/tool.* →
   * source.discovered → model.selected → response.delta → response.completed. "v1": plan → sources → model → delta → done.
   */
  streamFormat: z.enum(["v1", "v2"]).default("v2"),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .max(50)
    .default([]),
  /**
   * Optional structured references from earlier turns (repo, address, pool, tx, URL, ticker) so a follow-up
   * like "what about its liquidity?" can resolve "it" without relying on visible text. Untrusted like any
   * user input: strictly formatted, bounded, and URLs still pass the URL safety check before any fetch.
   */
  context: z
    .object({
      entities: z
        .object({
          urls: z.array(z.string().max(2048).regex(/^https?:\/\/\S+$/i)).max(5),
          githubRepos: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/)).max(3),
          addresses: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).max(5),
          txHashes: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).max(3),
          tickers: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,14}$/)).max(5),
        })
        .partial(),
    })
    .partial()
    .optional(),
});
export type ConversationContext = NonNullable<z.infer<typeof ChatRequestSchema>["context"]>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** Drives specialized UI. "combined" = two or more kinds of data (on-chain, market, GitHub, web) were used. */
export type ResponseType = "normal" | "research" | "github" | "onchain" | "market" | "combined";

/** Sources as returned to clients: `snippet` only; the full content sent to the model stays server-side. */
export type PublicSource = Omit<Source, "content">;

export interface VeyraResponse {
  /** Request id (also in every stream event and log line). */
  id: string;
  type: ResponseType;
  answer: string;
  /**
   * False when the request needed live data (chain, market, web, …) that could
   * not be retrieved. The answer then contains no real-time facts.
   */
  grounded: boolean;
  sources: PublicSource[];
  /** Which sources the answer cites, and which statement each citation supports. */
  citations: {
    used: number[];
    /** Citations the model made to non-existent sources (removed from the answer). */
    invalid: number[];
    statements: { text: string; sourceIds: number[] }[];
  };
  /** FACT (cited) vs INFERENCE (analysis) vs UNKNOWN (unavailable) in the answer. */
  knowledge: Knowledge;
  /** Structured tool payloads grouped by capability, for type-specific rendering. */
  data: Record<string, { tool: string; step: string; data: unknown }[]>;
  plan: {
    intents: Intent[];
    /** Unified vocabulary (GENERAL, WEB_SEARCH, DEEP_RESEARCH, …, ONCHAIN_MARKET, COMBINED_RESEARCH). */
    unifiedIntents: UnifiedIntent[];
    primaryIntent: Intent;
    intentMethod: "rules" | "llm";
    entities: Entities;
    tier: Tier;
    /** Model routing decision. */
    model: { tier: Tier; needs: string; reasons: string[]; candidates: string[]; skipped: { provider: string; model: string; reason: string }[]; notes: string[] };
    /** Research mode only: the planned search queries. */
    searchQueries?: { queries: string[]; method: "llm" | "rules" };
    /** Every tool step: why, phase (1 parallel · 2 fallback/complement · 3 dependent), dependencies, max attempts, freshness. */
    tools: ExplainedStep[];
    /** Upper bound on tool invocations for this request. */
    maxToolCalls: number;
    /** `soft`: an equivalent fallback covered it (e.g. web search instead of RSS) — informational only. */
    unavailable: { capability: string; reason: string; soft?: boolean }[];
    skipped: { capability: string; reason: string }[];
    /** URLs in the request that failed the safety check and were never fetched. */
    blockedUrls: { url: string; reason: string }[];
  };
  /** What the security layer did on this request. */
  security: {
    /** Sources from which instruction-like text was removed (possible prompt injection). */
    flaggedSources: { id: number; flags: string[] }[];
    blockedUrls: { url: string; reason: string }[];
    /** Links in the answer that weren't sources or user-supplied, removed. */
    removedLinks: string[];
    /** Sensitive content removed from the answer: secret, credential_pattern, system_prompt. */
    redactions: string[];
  };
  retrieval: {
    resultsFound: number;
    duplicatesRemoved: number;
    droppedByLimit: number;
    sourcesUsed: number;
    /** Sources used per kind of data. */
    byFamily: Partial<Record<"onchain" | "market" | "github" | "web", number>>;
    /** Tool calls answered from cache. */
    cacheHits: number;
  };
  toolRuns: ToolRun[];
  model: {
    provider: string;
    model: string;
    fallbackUsed: boolean;
    cached: boolean;
    attempts: Attempt[];
  };
  usage?: TokenUsage;
  timings: { totalMs: number; toolsMs: number; llmMs: number };
  warnings: string[];
}

export interface ErrorBody {
  error: { kind: ErrorKind | "validation" | "internal" | "unauthorized"; message: string; details?: unknown };
}
