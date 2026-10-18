import { checkUrl } from "../security/url-guard.js";
import { normalizeUrl } from "../sources/collector.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { AnyTool, Capability, ToolPlanningContext } from "../tools/types.js";
import type { GitHubRepoRef, Intent, IntentResult } from "./intent.js";

export interface CapabilityNeeds {
  /** Needed to answer properly; reported to the model as unavailable if missing. */
  required: Capability[];
  /** Enriches the answer when available; silently skipped if missing. */
  optional?: Capability[];
  /** Used only when a required capability is unavailable — the first applicable one wins. */
  fallback?: Capability[];
}

/** What each intent needs. Intents without live-data needs call no tools at all. */
export const INTENT_CAPABILITIES: Record<Intent, CapabilityNeeds> = {
  general: { required: [] },
  coding: { required: [] },
  summarize: { required: [] },
  web_search: { required: ["web.search"] },
  web_extract: { required: ["web.extract"] },
  research: { required: ["web.search"], optional: ["web.extract"] },
  // RSS is the low-cost freshness layer; web search complements it (decided after RSS runs) or replaces it.
  news: { required: ["news.feed"], fallback: ["web.search"] },
  // Reading the repo page beats searching about it; search only if there's no URL.
  github: { required: ["github.repo"], fallback: ["web.extract", "web.search"] },
  // A token address also gets TILIK's token check (lock, dev wallet, early buyers, holders): the answer then matches the website.
  onchain: { required: ["chain.data"], optional: ["token.check"], fallback: ["web.search"] },
  // No web fallback: search snippets would present stale prices as current.
  market: { required: ["market.data"], optional: ["token.check"] },
};

/**
 * When the primary intent has its own authoritative source, general sources
 * pulled in by secondary intents (e.g. "today"/"latest" → news) are dropped:
 * chain data, not web articles, answers "What happened on Robinhood Chain
 * today?" (RSS may still add relevant news), and the GitHub API — not RSS or
 * web search — answers "What are the latest releases of this repo?".
 */
const AUTHORITATIVE: Partial<Record<Intent, { source: Capability; suppress: Capability[] }>> = {
  onchain: { source: "chain.data", suppress: ["web.search"] },
  github: { source: "github.repo", suppress: ["web.search", "news.feed"] },
};

/** Fallbacks that provide the same kind of data — the model needn't be told the primary was missing. */
const EQUIVALENT_FALLBACK = new Set(["news.feed>web.search"]);

export function isEquivalentFallback(capability: Capability, fallback: Capability): boolean {
  return EQUIVALENT_FALLBACK.has(`${capability}>${fallback}`);
}

export interface PlannedStep {
  /** Unique within the request, e.g. "web.search#2" or "web.extract#r1" (research follow-up). */
  id: string;
  capability: Capability;
  /** "first": try candidates in order until one succeeds. "all": run every candidate and merge results. */
  strategy: "first" | "all";
  /** The text this step searches for (differs per step in research mode). */
  query: string;
  /** The URL this step reads (web.extract). */
  url?: string;
  /** Optional steps enrich the answer; their failure is a partial failure, not missing data. */
  optional: boolean;
  /** "followup" steps are planned from earlier results (research extraction). */
  stage: "primary" | "followup";
  candidates: { tool: AnyTool; input: unknown }[];
}

export interface ToolPlan {
  steps: PlannedStep[];
  /**
   * Required capabilities no configured tool can provide — the model is told this data is missing,
   * unless `soft` (an equivalent fallback covers it, e.g. web search instead of RSS).
   */
  unavailable: { capability: Capability; reason: string; soft?: boolean }[];
  /** Capabilities deliberately not used, with the reason (for transparency/debugging). */
  skipped: { capability: Capability; reason: string }[];
  /** URLs from the request that failed the safety check and were never fetched. */
  blockedUrls: { url: string; reason: string }[];
  /** Capabilities deliberately excluded because an authoritative source covers the question (not re-added while it works). */
  suppressed?: Capability[];
  /** The authoritative source that caused the suppression (if it fails, its fallback is allowed again). */
  authoritative?: Capability;
}

export interface PlanOptions {
  maxSteps: number;
  /** Alternates tried after the primary tool fails (default 1). */
  maxFallbacks?: number;
  /** Research mode: one web.search step per query. The first query uses every provider. */
  searchQueries?: string[];
  /** Direct URLs extracted per request (default 3). */
  maxExtractUrls?: number;
  blockedDomains?: string[];
  /** Repositories handled per request (default 2). */
  maxRepos?: number;
}

/** Steps a capability would run, one per target. Empty = the capability has nothing to act on. */
function targetsFor(
  capability: Capability,
  ctx: { query: string; searchQueries?: string[] | undefined; extractUrls: string[]; repos: GitHubRepoRef[] },
): { query: string; url?: string; repo?: GitHubRepoRef }[] {
  if (capability === "web.search") return (ctx.searchQueries?.length ? ctx.searchQueries : [ctx.query]).map((q) => ({ query: q }));
  if (capability === "web.extract") return ctx.extractUrls.map((url) => ({ query: ctx.query, url }));
  if (capability === "github.repo") return ctx.repos.map((repo) => ({ query: ctx.query, repo }));
  return [{ query: ctx.query }];
}

/**
 * Picks the minimum set of tools for a request:
 * - nothing for questions that need no live data;
 * - one tool per capability/target (the most suitable), with one fallback;
 * - both web search providers only for research, and only for the main query;
 * - one extraction step per safe URL in the request.
 */
export function planTools(intent: IntentResult, query: string, registry: ToolRegistry, opts: PlanOptions): ToolPlan {
  const research = intent.intents.includes("research");
  const unavailable: ToolPlan["unavailable"] = [];
  const skipped: ToolPlan["skipped"] = [];
  const { safe, blocked } = vetUrls(intent.entities.urls, opts);
  const repos = intent.entities.githubRepos.slice(0, opts.maxRepos ?? 2);

  // 1. Resolve required / optional / fallback capabilities. Value = optional?
  const wanted = new Map<Capability, boolean>();
  const want = (c: Capability, optional: boolean) => wanted.set(c, (wanted.get(c) ?? true) && optional);
  const hasTarget = (c: Capability) => (c === "web.extract" ? safe.length > 0 : c === "github.repo" ? repos.length > 0 : true);
  const applicable = (c: Capability) => toolStatus(registry, c).ok && hasTarget(c);

  for (const i of intent.intents) {
    const needs = INTENT_CAPABILITIES[i];
    const missing: { capability: Capability; reason: string }[] = [];
    for (const c of needs.required) {
      const s = toolStatus(registry, c);
      if (!s.ok) missing.push({ capability: c, reason: s.reason });
      else if (c === "github.repo" && !repos.length) missing.push({ capability: c, reason: "no GitHub repository identified (needs a github.com/owner/repo link)" });
      else want(c, false);
    }
    for (const c of needs.optional ?? []) {
      const s = toolStatus(registry, c);
      if (s.ok) want(c, true);
      else if (!skipped.some((x) => x.capability === c)) skipped.push({ capability: c, reason: `optional: ${s.reason}` });
    }
    const fallback = missing.length ? (needs.fallback ?? []).find(applicable) : undefined;
    if (fallback) want(fallback, false);
    // No usable fallback: say why, so "set TAVILY_API_KEY…" reaches the user.
    const fallbackWhy = !fallback && missing.length
      ? (needs.fallback ?? [])
          .map((f) => {
            const s = toolStatus(registry, f);
            return s.ok ? undefined : `fallback ${f}: ${s.reason}`;
          })
          .filter(Boolean)
          .join("; ")
      : "";
    for (const m of missing) {
      if (unavailable.some((u) => u.capability === m.capability)) continue;
      unavailable.push({
        capability: m.capability,
        reason: m.reason + (fallback ? ` — using ${fallback} as a fallback` : fallbackWhy ? `; ${fallbackWhy}` : ""),
        ...(fallback && EQUIVALENT_FALLBACK.has(`${m.capability}>${fallback}`) ? { soft: true } : {}),
      });
    }
  }

  // 2. Authoritative source for the primary intent suppresses secondary general sources.
  const authoritative = AUTHORITATIVE[intent.primary];
  const suppressed: Capability[] = [];
  if (authoritative && wanted.has(authoritative.source) && !research) {
    const reason = `not needed: ${authoritative.source} is the primary source`;
    suppressed.push(...authoritative.suppress);
    for (const c of authoritative.suppress) {
      if (wanted.delete(c)) skipped.push({ capability: c, reason });
      // Nor is a missing secondary source worth reporting when the authoritative source is there.
      const i = unavailable.findIndex((u) => u.capability === c);
      if (i >= 0) {
        unavailable.splice(i, 1);
        skipped.push({ capability: c, reason });
      }
    }
  }
  // A GitHub tool, when present, owns github.com URLs.
  const extractUrls = wanted.has("github.repo") ? safe.filter((u) => !isGitHub(u)) : safe;

  // 3. Build steps.
  const steps: PlannedStep[] = [];
  const counters = new Map<string, number>();
  for (const [capability, optional] of wanted) {
    const s = toolStatus(registry, capability);
    if (!s.ok) continue;

    const targets = targetsFor(capability, { query, searchQueries: opts.searchQueries, extractUrls, repos });
    if (targets.length === 0) {
      skipped.push({ capability, reason: blocked.length ? "every URL in the request was blocked" : "no URL in the request to read" });
      continue;
    }

    for (const [ti, target] of targets.entries()) {
      if (steps.length >= opts.maxSteps) {
        skipped.push({ capability, reason: `per-request tool step limit (${opts.maxSteps}) reached` });
        break;
      }
      const n = (counters.get(capability) ?? 0) + 1;
      const step = buildStep({
        id: `${capability}#${n}`,
        capability,
        tools: s.tools,
        ctx: {
          query: target.query,
          entities: intent.entities,
          intents: intent.intents,
          mode: research ? "research" : "standard",
          ...(target.url ? { url: target.url } : {}),
          ...(target.repo ? { repo: target.repo } : {}),
        },
        rotate: capability === "web.search" ? ti : 0,
        strategy: research && capability === "web.search" && ti === 0 ? "all" : "first",
        optional,
        stage: "primary",
        maxFallbacks: opts.maxFallbacks,
      });
      if (!step) {
        skipped.push({ capability, reason: "no configured tool applies to this request" });
        continue;
      }
      counters.set(capability, n);
      steps.push(step);
    }
  }
  return {
    steps,
    unavailable,
    skipped,
    blockedUrls: blocked,
    ...(suppressed.length ? { suppressed, authoritative: authoritative!.source } : {}),
  };
}

/**
 * Plans a bounded follow-up stage from earlier results — used by research to
 * read the most relevant pages that search only returned snippets for.
 * Single pass: follow-up steps never plan further steps.
 */
export function planFollowUp(
  capability: Capability,
  urls: string[],
  intent: IntentResult,
  registry: ToolRegistry,
  opts: { query: string; blockedDomains?: string[]; maxFallbacks?: number },
): PlannedStep[] {
  const s = toolStatus(registry, capability);
  if (!s.ok) return [];
  const { safe } = vetUrls(urls, { blockedDomains: opts.blockedDomains ?? [], maxExtractUrls: urls.length });
  return safe.flatMap((url, i) => {
    const step = buildStep({
      id: `${capability}#r${i + 1}`,
      capability,
      tools: s.tools,
      ctx: { query: opts.query, entities: intent.entities, intents: intent.intents, mode: "research", url },
      rotate: 0,
      strategy: "first",
      optional: true,
      stage: "followup",
      maxFallbacks: opts.maxFallbacks,
    });
    return step ? [step] : [];
  });
}

/**
 * A complementary step decided at request time (e.g. RSS found too little →
 * one web search). Optional: if it fails, the answer still uses what we have.
 */
export function planComplement(
  capability: Capability,
  query: string,
  intent: IntentResult,
  registry: ToolRegistry,
): PlannedStep | undefined {
  const s = toolStatus(registry, capability);
  if (!s.ok) return undefined;
  return buildStep({
    id: `${capability}#c1`,
    capability,
    tools: s.tools,
    ctx: { query, entities: intent.entities, intents: intent.intents, mode: "standard" },
    rotate: 0,
    strategy: "first",
    optional: true,
    stage: "followup",
    maxFallbacks: undefined,
  });
}

/**
 * Runtime recovery: a required capability was planned but every tool for it
 * failed (e.g. GitHub rate-limited or timed out). Plan the intent's first
 * applicable fallback once — e.g. read the github.com page with Jina instead.
 * Not used when the target doesn't exist (not_found) — a fallback can't fix that.
 */
export function planRecovery(
  failures: { capability: Capability; kinds: string[] }[],
  intent: IntentResult,
  query: string,
  registry: ToolRegistry,
  opts: { alreadyPlanned: Set<Capability>; blockedDomains?: string[]; maxExtractUrls?: number },
): { steps: PlannedStep[]; recovered: { capability: Capability; fallback: Capability }[] } {
  const steps: PlannedStep[] = [];
  const recovered: { capability: Capability; fallback: Capability }[] = [];
  const { safe } = vetUrls(intent.entities.urls, opts);
  for (const f of failures) {
    if (f.kinds.length && f.kinds.every((k) => k === "not_found" || k === "bad_request")) continue;
    const fallbacks = intent.intents.flatMap((i) => (INTENT_CAPABILITIES[i].required.includes(f.capability) ? (INTENT_CAPABILITIES[i].fallback ?? []) : []));
    const fallback = fallbacks.find(
      (c) => !opts.alreadyPlanned.has(c) && toolStatus(registry, c).ok && (c !== "web.extract" || safe.length > 0) && c !== "github.repo",
    );
    if (!fallback) continue;
    const s = toolStatus(registry, fallback);
    if (!s.ok) continue;
    const targets = targetsFor(fallback, { query, extractUrls: safe, repos: [] });
    targets.forEach((t, n) => {
      const step = buildStep({
        id: `${fallback}#f${n + 1}`,
        capability: fallback,
        tools: s.tools,
        ctx: { query: t.query, entities: intent.entities, intents: intent.intents, mode: "standard", ...(t.url ? { url: t.url } : {}) },
        rotate: 0,
        strategy: "first",
        optional: false,
        stage: "followup",
        maxFallbacks: undefined,
      });
      if (step) steps.push(step);
    });
    if (steps.some((s) => s.capability === fallback)) {
      recovered.push({ capability: f.capability, fallback });
      opts.alreadyPlanned.add(fallback);
    }
  }
  return { steps, recovered };
}

function buildStep(p: {
  id: string;
  capability: Capability;
  tools: AnyTool[];
  ctx: ToolPlanningContext;
  rotate: number;
  strategy: PlannedStep["strategy"];
  optional: boolean;
  stage: PlannedStep["stage"];
  maxFallbacks: number | undefined;
}): PlannedStep | undefined {
  const ranked = [...p.tools].sort((a, b) => (b.suitability?.(p.ctx) ?? 0.5) - (a.suitability?.(p.ctx) ?? 0.5));
  // Rotate the primary for extra research queries so both providers contribute.
  const r = ranked.length > 1 ? p.rotate % ranked.length : 0;
  const ordered = [...ranked.slice(r), ...ranked.slice(0, r)];
  const candidates = ordered
    .map((tool) => ({ tool, input: tool.planInput(p.ctx) }))
    .filter((c) => c.input !== null)
    .slice(0, 1 + (p.maxFallbacks ?? 1));
  if (candidates.length === 0) return undefined;
  return {
    id: p.id,
    capability: p.capability,
    strategy: p.strategy,
    query: p.ctx.query,
    ...(p.ctx.url ? { url: p.ctx.url } : {}),
    optional: p.optional,
    stage: p.stage,
    candidates,
  };
}

function toolStatus(registry: ToolRegistry, capability: Capability): { ok: true; tools: AnyTool[] } | { ok: false; reason: string } {
  const all = registry.forCapability(capability);
  if (all.length === 0) return { ok: false, reason: "no tool installed for this capability yet" };
  const configured = all.filter((t) => t.isConfigured());
  if (configured.length === 0) {
    const keys = [...new Set(all.flatMap((t) => t.auth.envKeys))].join(" or ");
    return { ok: false, reason: `no tool configured (set ${keys})` };
  }
  return { ok: true, tools: configured };
}

/** Safety-checks and de-duplicates URLs; caps how many are fetched. */
function vetUrls(urls: string[], opts: { maxExtractUrls?: number; blockedDomains?: string[] }) {
  const safe: string[] = [];
  const blocked: { url: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    const check = checkUrl(raw, { blockedDomains: opts.blockedDomains ?? [] });
    if (!check.ok) {
      blocked.push({ url: raw, reason: check.reason });
      continue;
    }
    const key = normalizeUrl(check.url) ?? check.url;
    if (seen.has(key)) continue;
    seen.add(key);
    safe.push(check.url);
  }
  return { safe: safe.slice(0, opts.maxExtractUrls ?? 3), blocked };
}

function isGitHub(url: string): boolean {
  return /^https?:\/\/(www\.)?github\.com\//i.test(url);
}
