import type { Env } from "../config/env.js";
import type { Tier } from "../config/routing.js";
import type { AnyTool, Capability } from "../tools/types.js";
import type { Intent, IntentResult } from "./intent.js";
import type { PlannedStep } from "./tool-router.js";

/**
 * The unified "ask anything" vocabulary on top of the internal intents.
 * A request can carry several; composites describe cross-source questions.
 */
export const UNIFIED_INTENTS = [
  "GENERAL",
  "WEB_SEARCH",
  "DEEP_RESEARCH",
  "URL_ANALYSIS",
  "GITHUB",
  "NEWS",
  "ROBINHOOD_ONCHAIN",
  "MARKET",
  "ONCHAIN_MARKET",
  "COMBINED_RESEARCH",
  "CODING",
  "SUMMARIZATION",
] as const;
export type UnifiedIntent = (typeof UNIFIED_INTENTS)[number];

const MAP: Record<Intent, UnifiedIntent> = {
  general: "GENERAL",
  coding: "CODING",
  summarize: "SUMMARIZATION",
  web_search: "WEB_SEARCH",
  web_extract: "URL_ANALYSIS",
  research: "DEEP_RESEARCH",
  news: "NEWS",
  github: "GITHUB",
  onchain: "ROBINHOOD_ONCHAIN",
  market: "MARKET",
};

/** Kinds of data a question touches. Used for composite intents, model routing and response types. */
export type Family = "onchain" | "market" | "github" | "web";

export function familyOfIntent(i: Intent): Family | undefined {
  if (i === "onchain" || i === "market" || i === "github") return i;
  if (i === "web_search" || i === "web_extract" || i === "research" || i === "news") return "web";
  return undefined;
}

export function familyOfCapability(c: Capability): Family {
  return c === "chain.data" ? "onchain" : c === "market.data" ? "market" : c === "github.repo" ? "github" : "web";
}

export function unifyIntents(intents: Intent[]): UnifiedIntent[] {
  const out = new Set<UnifiedIntent>(intents.map((i) => MAP[i]));
  if (intents.includes("onchain") && intents.includes("market")) out.add("ONCHAIN_MARKET");
  const families = new Set(intents.map(familyOfIntent).filter(Boolean));
  if ((intents.includes("research") && families.size >= 2) || families.size >= 3) out.add("COMBINED_RESEARCH");
  return UNIFIED_INTENTS.filter((u) => out.has(u));
}

// ── Plan explanation ─────────────────────────────────────────────────────────

export type Freshness = "live" | "recent" | "moderate" | "stable";

/** What each capability is for, its user-facing status label, and how fresh its data must be. */
export const CAPABILITY_INFO: Record<string, { label: string; freshness: Freshness; tool: string }> = {
  "chain.data": { label: "Checking Robinhood Chain…", freshness: "live", tool: "direct blockchain data (RPC/explorer)" },
  "market.data": { label: "Analyzing market data…", freshness: "live", tool: "DEX market data (GeckoTerminal)" },
  "news.feed": { label: "Checking news feeds…", freshness: "recent", tool: "RSS news feeds" },
  "web.search": { label: "Searching the web…", freshness: "recent", tool: "web search" },
  "github.repo": { label: "Reading repository…", freshness: "moderate", tool: "GitHub API" },
  "web.extract": { label: "Reading pages…", freshness: "stable", tool: "page extraction" },
};

export interface ExplainedStep {
  step: string;
  capability: string;
  candidates: string[];
  strategy: "first" | "all";
  stage: "primary" | "followup";
  optional: boolean;
  query: string;
  url?: string;
  /** Why this step exists. */
  why: string;
  /** 1 = independent (runs in parallel); 2 = fallback/complement after phase 1; 3 = depends on earlier results. */
  phase: 1 | 2 | 3;
  dependsOn: string[];
  /** Upper bound on tool invocations for this step (candidates × (1 + retries)). */
  maxAttempts: number;
  freshness: Freshness;
}

export function explainSteps(steps: PlannedStep[], intent: IntentResult, failed: string[] = []): ExplainedStep[] {
  return steps.map((s) => {
    const kind = /#f\d+$/.test(s.id) ? "recovery" : /#c\d+$/.test(s.id) ? "complement" : s.stage === "followup" ? "followup" : "primary";
    const phase: 1 | 2 | 3 = kind === "primary" ? 1 : kind === "followup" ? 3 : 2;
    const dependsOn =
      kind === "followup"
        ? steps.filter((o) => o.stage === "primary" && (o.capability === "web.search" || o.capability === "news.feed" || o.capability === "github.repo")).map((o) => o.id)
        : kind === "complement"
          ? steps.filter((o) => o.capability === "news.feed").map((o) => o.id)
          : kind === "recovery"
            ? steps.filter((o) => failed.includes(o.capability) && o.stage === "primary").map((o) => o.id)
            : [];
    const info = CAPABILITY_INFO[s.capability];
    return {
      step: s.id,
      capability: s.capability,
      candidates: s.candidates.map((c) => c.tool.name),
      strategy: s.strategy,
      stage: s.stage,
      optional: s.optional,
      query: s.query,
      ...(s.url ? { url: s.url } : {}),
      why: whyFor(s, kind, intent),
      phase,
      dependsOn,
      maxAttempts: s.candidates.reduce((n, c) => n + 1 + ((c.tool as AnyTool).retries ?? 0), 0),
      freshness: info?.freshness ?? "moderate",
    };
  });
}

function whyFor(s: PlannedStep, kind: string, intent: IntentResult): string {
  const e = intent.entities;
  if (kind === "recovery") return `Fallback: the primary source for this question failed, so ${CAPABILITY_INFO[s.capability]?.tool ?? s.capability} is used instead.`;
  if (kind === "complement") return "Complement: the news feeds returned little for this question, so one web search adds coverage.";
  if (kind === "followup") return `Read in full: ${s.url ?? "a page"} was among the most relevant results (or the project's own site) and only a snippet was available.`;
  switch (s.capability) {
    case "chain.data":
      return e.txHashes.length
        ? `Transaction ${e.txHashes[0]} is mentioned — retrieve it directly from Robinhood Chain.`
        : e.addresses.length
          ? `Address ${e.addresses[0]} is mentioned — read its on-chain state directly.`
          : "The question is about Robinhood Chain activity — read live chain data rather than web articles.";
    case "market.data":
      return e.addresses.length ? `Market data (price, liquidity, volume) for ${e.addresses[0]} from DEX pools.` : "The question asks about prices, liquidity, volume or pools — fetch live DEX market data.";
    case "github.repo":
      return `Repository ${s.query && e.githubRepos[0] ? `${e.githubRepos[0].owner}/${e.githubRepos[0].repo}` : "mentioned"} — read it through the GitHub API (only the parts the question needs).`;
    case "news.feed":
      return "The question asks about recent news — check the RSS feeds first (free, fresh).";
    case "web.extract":
      return `The question refers to ${s.url ?? "a URL"} — read the page itself.`;
    case "web.search":
      return intent.intents.includes("research")
        ? `Research query "${s.query.slice(0, 80)}"${s.strategy === "all" ? " — main query, sent to every search provider" : ""}.`
        : "The question needs current information from the web.";
    default:
      return `Needed for: ${intent.intents.join(", ")}.`;
  }
}

/** Response type from the kinds of data actually used (falls back to the primary intent). */
export function responseTypeFor(primary: Intent, families: Set<Family>): "normal" | "research" | "github" | "onchain" | "market" | "combined" {
  if (families.size >= 2) return "combined";
  const [only] = [...families];
  if (only === "onchain" || only === "market" || only === "github") return only;
  if (only === "web") return "research";
  switch (primary) {
    case "onchain":
    case "github":
    case "market":
    case "research":
      return primary;
    case "news":
    case "web_search":
    case "web_extract":
      return "research";
    default:
      return "normal";
  }
}

/** Families a request will draw on, from the plan (used before any data arrives). */
export function plannedFamilies(steps: PlannedStep[]): Set<Family> {
  return new Set(steps.map((s) => familyOfCapability(s.capability)));
}

export function modelNeeds(tier: Tier, env: Env): string {
  return tier === "reasoning"
    ? "strong reasoning (multi-source synthesis)"
    : tier === "coding"
      ? "code understanding"
      : tier === "cheap"
        ? `inexpensive model (output ≤ ${env.VEYRA_MAX_OUTPUT_TOKENS} tokens)`
        : "fast general model";
}
