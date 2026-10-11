import type { z } from "zod";
import type { Env } from "../config/env.js";
import type { RoutingConfig, Tier } from "../config/routing.js";
import { cacheKey, TtlCache } from "../cache/ttl-cache.js";
import { VeyraError, publicErrorMessage, toVeyraError, type ErrorKind } from "../core/errors.js";
import { Cooldowns, DailyBudget } from "../core/guards.js";
import type { Logger } from "../core/logger.js";
import type { ProviderRegistry } from "../providers/llm/registry.js";
import type { ChatMessage, GenerateResult, LLMProvider, StreamEvent } from "../providers/llm/types.js";
import type { Intent } from "./intent.js";

/** "auto" | "<provider>" | "<provider>:<model id>" (model ids may themselves contain ":" or "/"). */
export type ModelPreference =
  | { kind: "auto" }
  | { kind: "provider"; provider: string }
  | { kind: "model"; provider: string; model: string };

export function parseModelPreference(value: string | undefined): ModelPreference {
  const v = value?.trim();
  if (!v || v.toLowerCase() === "auto") return { kind: "auto" };
  const sep = v.indexOf(":");
  if (sep < 0) return { kind: "provider", provider: v.toLowerCase() };
  return { kind: "model", provider: v.slice(0, sep).toLowerCase(), model: v.slice(sep + 1) };
}

export interface ModelCandidate {
  provider: LLMProvider;
  model: string;
  maxTokens: number;
  temperature?: number;
  extra?: Record<string, unknown>;
}

export interface Attempt {
  provider: string;
  model: string;
  ok: boolean;
  ms: number;
  error?: { kind: ErrorKind; message: string };
}

export interface CandidatePlan {
  tier: Tier;
  candidates: ModelCandidate[];
  skipped: { provider: string; model: string; reason: string }[];
  /** Ordering decisions (budget pressure, latency). */
  notes?: string[];
}

export class AllModelsFailedError extends VeyraError {
  constructor(readonly attempts: Attempt[], readonly skipped: CandidatePlan["skipped"]) {
    super("upstream", "model-router", attempts.length ? "All model candidates failed" : "No LLM provider is configured");
  }
}

export interface ModelRouterDeps {
  env: Env;
  routing: RoutingConfig;
  providers: ProviderRegistry;
  logger: Logger;
  budget?: DailyBudget;
  cooldowns?: Cooldowns;
  cache?: TtlCache<GenerateResult>;
}

/**
 * Chooses which model answers, in what order to fall back, and enforces the
 * daily request caps and provider cooldowns that protect the budget.
 */
export class ModelRouter {
  private readonly budget: DailyBudget;
  private readonly cooldowns: Cooldowns;
  private readonly cache: TtlCache<GenerateResult>;

  constructor(private readonly deps: ModelRouterDeps) {
    const { env } = deps;
    this.budget =
      deps.budget ??
      new DailyBudget({
        openrouter: env.OPENROUTER_DAILY_REQUEST_LIMIT,
        gemini: env.GEMINI_DAILY_REQUEST_LIMIT,
        groq: env.GROQ_DAILY_REQUEST_LIMIT,
      });
    this.cooldowns = deps.cooldowns ?? new Cooldowns();
    this.cache = deps.cache ?? new TtlCache<GenerateResult>(200);
  }

  selectTier(intents: Intent[]): Tier {
    const { intentTiers, tierRank } = this.deps.routing;
    const needed = new Set(intents.map((i) => intentTiers[i]));
    return tierRank.find((t) => needed.has(t)) ?? "fast";
  }

  /**
   * Task-aware tier choice with reasons: intent needs, multi-source synthesis,
   * and context size. Escalation is conservative — the paid budget is limited.
   */
  chooseTier(intents: Intent[], signals: { families: number; contextChars?: number }): { tier: Tier; reasons: string[] } {
    let tier = this.selectTier(intents);
    const reasons = [`${intents.join("+")} → ${tier} tier (routing config)`];
    // Combining 3+ kinds of data (e.g. chain + market + web) is real synthesis work.
    if (signals.families >= 3 && (tier === "fast" || tier === "cheap")) {
      tier = "reasoning";
      reasons.push(`${signals.families} kinds of data to combine → reasoning tier`);
    }
    // A large context deserves more than the cheapest model.
    if (signals.contextChars !== undefined && signals.contextChars > 12_000 && tier === "cheap") {
      tier = "fast";
      reasons.push(`large context (${signals.contextChars.toLocaleString("en-US")} chars) → fast tier`);
    }
    return { tier, reasons };
  }

  plan(tier: Tier, preference: ModelPreference, strict = false, opts: { lowLatency?: boolean } = {}): CandidatePlan {
    const { routing, providers, env } = this.deps;
    const ceiling = env.VEYRA_MAX_OUTPUT_TOKENS;
    const tierDefault = routing.tiers[tier][0]?.maxTokens ?? 1500;
    const ordered: { provider: string; model: string; maxTokens?: number; temperature?: number; extra?: Record<string, unknown> }[] = [];

    if (preference.kind === "model") {
      ordered.push({ provider: preference.provider, model: preference.model });
    } else if (preference.kind === "provider") {
      const fromTier = routing.tiers[tier].filter((c) => c.provider === preference.provider);
      const fallbackModel = providers.get(preference.provider)?.defaultModel;
      if (fromTier.length) ordered.push(...fromTier);
      else if (fallbackModel) ordered.push({ provider: preference.provider, model: fallbackModel });
      else ordered.push({ provider: preference.provider, model: "(unknown provider)" });
    }
    const notes: string[] = [];
    if (!strict || preference.kind === "auto") {
      let tierList = [...routing.tiers[tier]];
      // Cost: a provider at ≥80% of its daily request cap goes to the back (protects the paid budget).
      const snap = this.budget.snapshot();
      const strained = (p: string) => (snap[p]?.limit ?? 0) > 0 && snap[p]!.used / snap[p]!.limit >= 0.8;
      if (tierList.some((c) => strained(c.provider))) {
        tierList = [...tierList.filter((c) => !strained(c.provider)), ...tierList.filter((c) => strained(c.provider))];
        notes.push(`deprioritized near daily limit: ${[...new Set(routing.tiers[tier].filter((c) => strained(c.provider)).map((c) => c.provider))].join(", ")}`);
      }
      // Latency: when streaming, try the fastest configured provider first.
      // Opt-in only: by default streaming keeps the configured provider order (OpenRouter primary).
      if (opts.lowLatency && this.deps.env.VEYRA_STREAM_PREFER_GROQ && preference.kind === "auto") {
        const fast = tierList.filter((c) => c.provider === "groq" && providers.get("groq")?.isConfigured());
        if (fast.length && tierList[0]?.provider !== "groq") {
          tierList = [...fast, ...tierList.filter((c) => c.provider !== "groq")];
          notes.push("streaming: lowest-latency provider (groq) first");
        }
      }
      ordered.push(...tierList);
      // Last resort: every other provider's default model, then the dev mock if enabled.
      for (const p of providers.list()) {
        if (p.id !== "dev-mock") ordered.push({ provider: p.id, model: p.defaultModel });
      }
      const mock = providers.get("dev-mock");
      if (mock) ordered.push({ provider: mock.id, model: mock.defaultModel });
    }

    const seen = new Set<string>();
    const candidates: ModelCandidate[] = [];
    const skipped: CandidatePlan["skipped"] = [];
    for (const c of ordered) {
      const key = `${c.provider}:${c.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const provider = providers.get(c.provider);
      const reason = !provider
        ? "unknown provider"
        : !provider.isConfigured()
          ? "not configured (missing API key)"
          : this.cooldowns.isCooling(c.provider) || this.cooldowns.isCooling(key)
            ? "cooling down after a recent failure"
            : undefined;
      if (reason || !provider) {
        skipped.push({ provider: c.provider, model: c.model, reason: reason ?? "unknown provider" });
        continue;
      }
      candidates.push({
        provider,
        model: c.model,
        maxTokens: Math.min(c.maxTokens ?? tierDefault, ceiling || Infinity),
        ...(c.temperature !== undefined ? { temperature: c.temperature } : {}),
        ...(c.extra ? { extra: c.extra } : {}),
      });
    }
    // Bounded fallback chain: each model at most once, and at most VEYRA_MAX_MODEL_ATTEMPTS of them
    // (the clearly-labelled dev mock, when enabled, stays the last resort).
    const maxAttempts = this.deps.env.VEYRA_MAX_MODEL_ATTEMPTS;
    const real = candidates.filter((c) => c.provider.id !== "dev-mock");
    if (maxAttempts > 0 && real.length > maxAttempts) {
      for (const c of real.slice(maxAttempts)) skipped.push({ provider: c.provider.id, model: c.model, reason: "fallback limit reached" });
      const kept = new Set(real.slice(0, maxAttempts));
      return { tier, candidates: candidates.filter((c) => kept.has(c) || c.provider.id === "dev-mock"), skipped, ...(notes.length ? { notes } : {}) };
    }
    return { tier, candidates, skipped, ...(notes.length ? { notes } : {}) };
  }

  async generate(
    plan: CandidatePlan,
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<{ result: GenerateResult; attempts: Attempt[]; cached: boolean }> {
    const keyFor = (c: ModelCandidate) => cacheKey("llm", c.provider.id, c.model, messages, c.maxTokens, c.temperature);
    // Identical prompt answered recently by any candidate → free.
    for (const c of plan.candidates) {
      const hit = this.cache.get(keyFor(c));
      if (hit) return { result: hit, attempts: [{ provider: c.provider.id, model: c.model, ok: true, ms: 0 }], cached: true };
    }
    const { value, attempts, candidate } = await this.firstSuccessful(plan, (c) =>
      c.provider.generate({ ...this.request(c, messages), ...(signal ? { signal } : {}) }),
    );
    this.cache.set(keyFor(candidate), value, this.deps.env.VEYRA_CACHE_TTL_SECONDS * 1000);
    return { result: value, attempts, cached: false };
  }

  async structured<T>(plan: CandidatePlan, messages: ChatMessage[], schema: z.ZodType<T>, signal?: AbortSignal) {
    return this.firstSuccessful(plan, (c) =>
      c.provider.structuredGenerate({ ...this.request(c, messages), ...(signal ? { signal } : {}) }, schema),
    );
  }

  /** Tries candidates in order; each attempt is budgeted, and failures put the provider on cooldown where appropriate. */
  private async firstSuccessful<R>(
    plan: CandidatePlan,
    call: (c: ModelCandidate) => Promise<R>,
  ): Promise<{ value: R; attempts: Attempt[]; candidate: ModelCandidate }> {
    const attempts: Attempt[] = [];
    for (const c of plan.candidates) {
      const started = Date.now();
      if (!this.budget.tryConsume(c.provider.id)) {
        attempts.push(this.failed(c, started, new VeyraError("budget", c.provider.id, "Daily request limit reached")));
        continue;
      }
      try {
        const value = await call(c);
        attempts.push({ provider: c.provider.id, model: c.model, ok: true, ms: Date.now() - started });
        return { value, attempts, candidate: c };
      } catch (err) {
        attempts.push(this.failed(c, started, this.handleFailure(c, err)));
      }
    }
    throw new AllModelsFailedError(attempts, plan.skipped);
  }

  /**
   * Streams from the first candidate that starts successfully. Falling back is
   * only possible before the first token — after that, a failure is surfaced.
   */
  async *stream(
    plan: CandidatePlan,
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent | { type: "model"; provider: string; model: string; attempts: Attempt[] }> {
    const attempts: Attempt[] = [];
    for (const c of plan.candidates) {
      const started = Date.now();
      if (!this.budget.tryConsume(c.provider.id)) {
        attempts.push(this.failed(c, started, new VeyraError("budget", c.provider.id, "Daily request limit reached")));
        continue;
      }
      let begun = false;
      try {
        for await (const event of c.provider.stream({ ...this.request(c, messages), ...(signal ? { signal } : {}) })) {
          // Empty chunks (some providers open the stream with one, then stall) don't count as starting:
          // until real text arrives, a stall or error can still fall back to the next model.
          if (!begun && event.type === "delta" && !event.text) continue;
          if (!begun) {
            begun = true;
            attempts.push({ provider: c.provider.id, model: c.model, ok: true, ms: Date.now() - started });
            yield { type: "model", provider: c.provider.id, model: c.model, attempts };
          }
          yield event;
        }
        return;
      } catch (err) {
        const e = this.handleFailure(c, err);
        if (begun) throw e;
        attempts.push(this.failed(c, started, e));
      }
    }
    throw new AllModelsFailedError(attempts, plan.skipped);
  }

  /** Today's request counts vs. limits per provider (for /health). */
  get budgetSnapshot() {
    return this.budget.snapshot();
  }

  private request(c: ModelCandidate, messages: ChatMessage[]) {
    return {
      model: c.model,
      messages,
      maxTokens: c.maxTokens,
      ...(c.temperature !== undefined ? { temperature: c.temperature } : {}),
      ...(c.extra ? { extra: c.extra } : {}),
    };
  }

  private handleFailure(c: ModelCandidate, err: unknown): VeyraError {
    const e = toVeyraError(err, c.provider.id);
    if (e.kind === "aborted") throw e;
    const pid = c.provider.id;
    if (e.kind === "rate_limit") this.cooldowns.mark(`${pid}:${c.model}`, e.retryAfterMs ?? 30_000);
    if (e.kind === "quota") this.cooldowns.mark(pid, e.retryAfterMs ?? 10 * 60_000);
    if (e.kind === "auth") this.cooldowns.mark(pid, 10 * 60_000);
    this.deps.logger.warn("model attempt failed", { provider: pid, model: c.model, kind: e.kind, error: e.message });
    return e;
  }

  private failed(c: ModelCandidate, started: number, e: VeyraError): Attempt {
    return { provider: c.provider.id, model: c.model, ok: false, ms: Date.now() - started, error: { kind: e.kind, message: publicErrorMessage(e.message) } };
  }
}
