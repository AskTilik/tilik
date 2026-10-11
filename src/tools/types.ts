import type { z } from "zod";
import type { Entities, GitHubRepoRef, Intent } from "../router/intent.js";
import type { SourceInput } from "../sources/types.js";

/**
 * Capabilities decouple *what* is needed from *which* service provides it.
 * The tool router asks for capabilities; any registered tool offering one can
 * serve it, and multiple tools for the same capability become fallbacks
 * (e.g. web.search → Exa, then Tavily).
 */
export type Capability =
  | "web.search"
  | "web.extract"
  | "github.repo"
  | "news.feed"
  | "chain.data"
  | "market.data"
  | (string & {});

export type CostTier = "free" | "low" | "paid";

export interface ToolPlanningContext {
  /** The text this step should act on — the user's message, or a planned research sub-query. */
  query: string;
  entities: Entities;
  intents: Intent[];
  /** "research" asks tools for deeper (and costlier) retrieval. */
  mode: "standard" | "research";
  /** For URL-oriented capabilities (web.extract): the vetted URL this step targets. */
  url?: string;
  /** For repository capabilities (github.repo): the repository this step targets. */
  repo?: GitHubRepoRef;
}

export interface ToolExecutionContext {
  query: string;
  entities: Entities;
  signal: AbortSignal;
}

export interface ToolResult<D> {
  /** Structured payload for the frontend (validated by outputSchema). */
  data: D;
  /** Normalized evidence for the reasoning layer and citations. */
  sources: SourceInput[];
  /** User-facing notes about limits or degraded data (become response warnings). */
  notices?: string[];
  /**
   * URLs returned by a structured API (e.g. a GitHub issue's html_url) that the
   * answer may cite even though they are listed inside a source, not as one.
   */
  citableUrls?: string[];
  /** Pages worth reading in a research follow-up (e.g. a repository's homepage/docs). */
  related?: string[];
  /** Shorter cache lifetime for this particular result (e.g. private repository content). */
  cacheTtlSeconds?: number;
  /** The tool's own judgement that web search should complement its results (e.g. RSS found too little). */
  suggestWebSearch?: boolean;
}

export interface Tool<I = unknown, D = unknown> {
  name: string;
  description: string;
  capabilities: Capability[];
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<D>;
  /** Env vars the tool needs. Listed for /health; values are never exposed. */
  auth: { envKeys: string[] };
  rateLimit?: { requestsPerMinute: number };
  /** Max upstream calls per UTC day (cache hits don't count). 0/undefined = unlimited. */
  dailyLimit?: number;
  costTier: CostTier;
  /** Lower runs first among tools of equal cost tier and suitability. */
  priority?: number;
  /**
   * 0..1 — how well this tool fits the request. The router tries the most
   * suitable tool first (e.g. Tavily for breaking news, Exa for semantic queries).
   */
  suitability?(ctx: ToolPlanningContext): number;
  /** 0 disables caching (use for live chain/market data that must be fresh). */
  cacheTtlSeconds?: number;
  timeoutMs?: number;
  /**
   * Extra attempts on transient failures (timeout, network, 5xx), with backoff.
   * Leave 0 for tools that retry internally or have an equivalent fallback tool.
   */
  retries?: number;
  isConfigured(): boolean;
  /** Derive input from the request, or null when this tool can't help with it. */
  planInput(ctx: ToolPlanningContext): I | null;
  execute(input: I, ctx: ToolExecutionContext): Promise<ToolResult<D>>;
}

/** Heterogeneous tool collections; each tool still validates its own input/output schemas at runtime. */
export type AnyTool = Tool<any, any>;
