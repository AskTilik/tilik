import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { blockedDomains } from "../config/env.js";
import type { ChatMessage, TokenUsage } from "../providers/llm/types.js";
import { selectPagesToExtract } from "../research/extraction.js";
import { planSearchQueries, type QueryPlan } from "../research/planner.js";
import {
  classifyIntent,
  contextTurn,
  inheritFollowUpContext,
  inheritGitHubContext,
  inheritOnchainContext,
  INTENTS,
  orderIntents,
  type Intent,
  type IntentResult,
} from "../router/intent.js";
import { AllModelsFailedError, parseModelPreference, type Attempt, type CandidatePlan, type ModelPreference, type ModelRouter } from "../router/model-router.js";
import { isEquivalentFallback, planComplement, planFollowUp, planRecovery, planTools, type PlannedStep } from "../router/tool-router.js";
import {
  CAPABILITY_INFO,
  explainSteps,
  familyOfIntent,
  modelNeeds,
  plannedFamilies,
  responseTypeFor,
  unifyIntents,
  type Family,
} from "../router/unified.js";
import type { OutputGuard } from "../security/output-guard.js";
import { checkCitations } from "../sources/citations.js";
import type { Source } from "../sources/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { RunHooks, ToolRun, ToolRunner } from "../tools/runner.js";
import type { ChatRequest, PublicSource, ResponseType, VeyraResponse } from "../types/api.js";
import { analyzeClaims } from "./claims.js";
import { buildContext } from "./context-builder.js";
import { EventQueue, type Emit, type EngineEvent } from "./events.js";
import { withFields, type Logger } from "./logger.js";
import { buildMessages, buildSystemPrompt } from "./prompts.js";

export type { EngineEvent } from "./events.js";

/** Intents whose answers depend on data retrieved at request time. */
const LIVE_INTENTS = new Set<Intent>(["web_search", "web_extract", "research", "news", "github", "onchain", "market"]);
const WEBSITE_REQUEST = /\b(website|web ?site|homepage|home page|official site|docs|documentation)\b/i;
const TIME_SENSITIVE =/\b(today|now|latest|recent(ly)?|breaking|this (week|morning)|yesterday|hours?|currently|live)\b/i;

export interface EngineDeps {
  env: Env;
  modelRouter: ModelRouter;
  tools: ToolRegistry;
  toolRunner: ToolRunner;
  outputGuard: OutputGuard;
  logger: Logger;
}

interface Prepared {
  id: string;
  log: Logger;
  started: number;
  type: ResponseType;
  preference: ModelPreference;
  candidatePlan: CandidatePlan;
  messages: ChatMessage[];
  publicPlan: VeyraResponse["plan"];
  sources: Source[];
  toolRuns: ToolRun[];
  data: VeyraResponse["data"];
  retrieval: VeyraResponse["retrieval"];
  partialFailures: string[];
  /** URLs the answer may contain: source URLs, user URLs, URLs returned by structured APIs. */
  allowedUrls: string[];
  grounded: boolean;
  toolsMs: number;
}

/**
 * The VEYRA intelligence router — one pipeline for every question:
 *
 *   understand intent → plan model + tools (bounded, explained) → execute (independent steps in
 *   parallel, dependent steps after) → verify/normalize/rank context → reason → answer with
 *   verified citations, fact/inference/unknown breakdown and structured data.
 *
 * `ask` returns the final response; `askStream` emits the same pipeline as safe progress events.
 */
/** Per-call options: the HTTP layer's request id, so access logs and pipeline logs share one id. */
export interface RunOptions {
  requestId?: string;
}

export class VeyraEngine {
  constructor(private readonly deps: EngineDeps) {}

  ask(req: ChatRequest, signal: AbortSignal, opts: RunOptions = {}): Promise<VeyraResponse> {
    return this.run(req, signal, () => {}, false, opts);
  }

  async *askStream(req: ChatRequest, signal: AbortSignal, opts: RunOptions = {}): AsyncGenerator<EngineEvent> {
    const queue = new EventQueue<EngineEvent>();
    this.run(req, signal, (e) => queue.push(e), true, opts).then(
      () => queue.close(),
      (err) => queue.fail(err),
    );
    yield* queue;
  }

  private async run(req: ChatRequest, signal: AbortSignal, emit: Emit, streaming: boolean, opts: RunOptions = {}): Promise<VeyraResponse> {
    const prep = await this.prepare(req, signal, emit, streaming, opts);
    const { id } = prep;
    emit({ type: "status", requestId: id, message: "Writing the answer…" });
    const llmStarted = Date.now();
    let response: VeyraResponse;

    if (!streaming) {
      const { result, attempts, cached } = await this.deps.modelRouter.generate(prep.candidatePlan, prep.messages, signal);
      emit({ type: "model.selected", requestId: id, provider: result.provider, model: result.model, tier: prep.candidatePlan.tier });
      response = this.finish(prep, { answer: result.text, attempts, cached, llmMs: Date.now() - llmStarted, ...(result.usage ? { usage: result.usage } : {}) });
    } else {
      let answer = "";
      let attempts: Attempt[] = [];
      let usage: TokenUsage | undefined;
      // Secrets are redacted before any token leaves the server, even mid-stream.
      const redactor = this.deps.outputGuard.streamRedactor();
      // Output ceiling: past it, the model stream is aborted (no more tokens paid for) and the answer ends with a notice.
      const maxChars = this.deps.env.VEYRA_MAX_STREAM_CHARS;
      const llm = new AbortController();
      let truncated = false;
      for await (const event of this.deps.modelRouter.stream(prep.candidatePlan, prep.messages, AbortSignal.any([signal, llm.signal]))) {
        if (event.type === "model") {
          attempts = event.attempts;
          emit({ type: "model.selected", requestId: id, provider: event.provider, model: event.model, tier: prep.candidatePlan.tier });
        } else if (event.type === "delta") {
          const room = maxChars > 0 ? maxChars - answer.length : Number.POSITIVE_INFINITY;
          const text = room < event.text.length ? event.text.slice(0, Math.max(0, room)) : event.text;
          answer += text;
          const safe = redactor.push(text);
          if (safe) emit({ type: "response.delta", requestId: id, text: safe });
          if (text.length < event.text.length) {
            truncated = true;
            llm.abort();
            break;
          }
        } else if (event.usage) usage = event.usage;
      }
      const notice = truncated ? "\n\n_[Answer cut off: it reached the maximum length.]_" : "";
      const tail = redactor.flush() + notice;
      if (tail) emit({ type: "response.delta", requestId: id, text: tail });
      response = this.finish(prep, { answer: answer + notice, attempts, cached: false, llmMs: Date.now() - llmStarted, ...(usage ? { usage } : {}) });
      if (truncated) {
        response.warnings.push(`The answer reached the ${maxChars}-character limit and was cut off.`);
        prep.log.warn("stream.truncated", { maxChars });
      }
    }

    if (response.model.fallbackUsed) prep.log.warn("model.fallback", { provider: response.model.provider, model: response.model.model, attempts: response.model.attempts.length });
    prep.log.info("request.completed", {
      type: response.type,
      provider: response.model.provider,
      model: response.model.model,
      llmCached: response.model.cached,
      sources: response.sources.length,
      cacheHits: response.retrieval.cacheHits,
      grounded: response.grounded,
      totalMs: response.timings.totalMs,
    });
    emit({ type: "response.completed", requestId: id, response });
    return response;
  }

  private async prepare(req: ChatRequest, signal: AbortSignal, emit: Emit, streaming: boolean, opts: RunOptions = {}): Promise<Prepared> {
    const { env, modelRouter, tools, toolRunner } = this.deps;
    const started = Date.now();
    const id = opts.requestId ?? randomUUID();
    const log = withFields(this.deps.logger, { requestId: id });
    emit({ type: "request.started", requestId: id, at: new Date(started).toISOString() });
    emit({ type: "status", requestId: id, message: "Understanding your question…" });
    // Content is never logged — only sizes.
    log.info("request.started", { messageChars: req.message.length, historyTurns: req.history.length, stream: streaming, model: req.model });

    // 1. UNDERSTAND: free rules (optionally a cheap model when unsure), then conversation context.
    let intent = classifyIntent(req.message, { forceResearch: req.mode === "research" });
    if (env.VEYRA_INTENT_MODE === "hybrid" && intent.confidence < 0.6) intent = await this.refineIntent(intent, req.message, signal);
    // Client-supplied references (validated, bounded) act as the most recent mention; resolvers only — never sent to the model.
    const refs = contextTurn(req.context?.entities);
    const conversation = refs ? [...req.history, refs] : req.history;
    intent = inheritGitHubContext(intent, req.message, conversation);
    intent = inheritOnchainContext(intent, req.message, conversation);
    intent = inheritFollowUpContext(intent, req.message, conversation);
    // A follow-up plans its tools with the question it continues ("Go deeper" → the earlier topic).
    const toolQuery = intent.contextQuery ? `${intent.contextQuery}\n${req.message}` : req.message;
    const unified = unifyIntents(intent.intents);
    const research = intent.intents.includes("research");
    emit({ type: "intent.detected", requestId: id, intents: intent.intents, unified, primary: intent.primary, method: intent.method });
    log.info("intent.detected", { intents: intent.intents, unified, method: intent.method, signals: intent.signals });

    // 2. PLAN THE MODEL — fail fast (before any tool spend) if nothing can answer.
    const intentFamilies = new Set(intent.intents.map(familyOfIntent).filter((f): f is Family => Boolean(f)));
    const preference = parseModelPreference(req.model);
    let choice = modelRouter.chooseTier(intent.intents, { families: intentFamilies.size });
    let candidatePlan = modelRouter.plan(choice.tier, preference, req.strictModel, { lowLatency: streaming });
    if (candidatePlan.candidates.length === 0) throw new AllModelsFailedError([], candidatePlan.skipped);

    const history = req.history
      .slice(-env.VEYRA_MAX_HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

    // 3. PLAN THE TOOLS (bounded): research query expansion, then the minimal capability set.
    let queryPlan: QueryPlan | undefined;
    if (research && tools.forCapability("web.search").some((t) => t.isConfigured())) {
      queryPlan = await planSearchQueries(toolQuery, {
        maxQueries: env.VEYRA_RESEARCH_MAX_QUERIES,
        useLlm: env.VEYRA_RESEARCH_PLANNER === "llm",
        modelRouter,
        history,
        logger: log,
        signal,
        ...(intent.entities.githubRepos[0] ? { repo: intent.entities.githubRepos[0] } : {}),
      });
    }
    const blocked = blockedDomains(env);
    const toolPlan = planTools(intent, toolQuery, tools, {
      maxSteps: env.VEYRA_MAX_TOOL_STEPS,
      maxExtractUrls: env.VEYRA_EXTRACT_MAX_URLS,
      maxRepos: env.GITHUB_MAX_REPOS,
      blockedDomains: blocked,
      ...(queryPlan ? { searchQueries: queryPlan.queries } : {}),
    });

    const modelInfo = (plan: CandidatePlan, reasons: string[]) => ({
      tier: plan.tier,
      needs: modelNeeds(plan.tier, env),
      reasons,
      candidates: plan.candidates.map((c) => `${c.provider.id}:${c.model}`),
      skipped: plan.skipped,
      notes: plan.notes ?? [],
    });
    const planFor = (steps: PlannedStep[], failedCaps: string[], unavailable: VeyraResponse["plan"]["unavailable"], model: VeyraResponse["plan"]["model"]): VeyraResponse["plan"] => {
      const explained = explainSteps(steps, intent, failedCaps);
      return {
        intents: intent.intents,
        unifiedIntents: unified,
        primaryIntent: intent.primary,
        intentMethod: intent.method,
        entities: intent.entities,
        tier: model.tier,
        model,
        ...(queryPlan ? { searchQueries: queryPlan } : {}),
        tools: explained,
        maxToolCalls: explained.reduce((n, s) => n + s.maxAttempts, 0),
        unavailable,
        skipped: toolPlan.skipped,
        blockedUrls: toolPlan.blockedUrls,
      };
    };
    emit({ type: "plan.created", requestId: id, plan: planFor(toolPlan.steps, [], toolPlan.unavailable, modelInfo(candidatePlan, choice.reasons)) });
    log.info("plan.created", { tier: choice.tier, tierReasons: choice.reasons, steps: toolPlan.steps.map((s) => `${s.id}:${s.candidates.map((c) => c.tool.name).join("|")}`) });

    // 4. EXECUTE. Independent steps in parallel; dependent ones after (never extract before URLs are known).
    const announced = new Set<string>();
    const hooks: RunHooks = {
      onStart: (step, tool) => {
        const label = CAPABILITY_INFO[step.capability]?.label ?? "Working…";
        if (!announced.has(step.capability)) {
          announced.add(step.capability);
          emit({ type: "status", requestId: id, message: label });
        }
        emit({ type: "tool.started", requestId: id, step: step.id, capability: step.capability, tool: tool.name, label });
      },
      onEnd: (run) => {
        emit({ type: "tool.completed", requestId: id, run });
        log.info("tool.completed", { step: run.step, tool: run.tool, status: run.status, ms: run.ms, cached: Boolean(run.cached), attempts: run.attempts, error: run.error?.kind });
      },
    };
    const toolsStarted = Date.now();
    // One hard tool budget for the whole request (initial plan, recovery, complements, dependent reads).
    const callBudget = { used: 0, max: env.VEYRA_MAX_TOOL_CALLS_PER_REQUEST || Number.POSITIVE_INFINITY };
    const { runs, outputs } = await toolRunner.run(toolPlan, { entities: intent.entities, signal, callBudget }, hooks);
    const steps: PlannedStep[] = [...toolPlan.steps];
    const runMore = async (more: PlannedStep[]) => {
      if (!more.length) return;
      const r = await toolRunner.run({ steps: more, unavailable: [], skipped: [], blockedUrls: [] }, { entities: intent.entities, signal, callBudget }, hooks);
      runs.push(...r.runs);
      outputs.push(...r.outputs);
      steps.push(...more);
    };

    // 4b. Recovery: a required source failed (e.g. GitHub rate-limited) → its fallback, once.
    const stageOneFailures = [...new Set(steps.filter((s) => !s.optional).map((s) => s.capability))]
      .filter((c) => !outputs.some((o) => o.capability === c))
      .map((capability) => ({ capability, kinds: runs.filter((r) => r.capability === capability && r.error).map((r) => r.error!.kind) }));
    // Suppressed capabilities stay out while the authoritative source works; if it failed, its fallback is allowed.
    const authoritativeFailed = toolPlan.authoritative !== undefined && stageOneFailures.some((f) => f.capability === toolPlan.authoritative);
    const stillSuppressed = authoritativeFailed ? [] : (toolPlan.suppressed ?? []);
    const recovery = planRecovery(stageOneFailures, intent, toolQuery, tools, {
      alreadyPlanned: new Set([...steps.map((s) => s.capability), ...stillSuppressed]),
      blockedDomains: blocked,
      maxExtractUrls: env.VEYRA_EXTRACT_MAX_URLS,
    });
    if (recovery.recovered.length) log.warn("tool.fallback", { recovered: recovery.recovered });
    await runMore(recovery.steps);

    // 4c. Complement: a tool judged its results thin (e.g. RSS) → one web search.
    const rssRan = outputs.some((o) => o.capability === "news.feed");
    const wantsWeb = env.NEWS_WEB_COMPLEMENT === "always" ? rssRan : env.NEWS_WEB_COMPLEMENT === "never" ? false : outputs.some((o) => o.suggestWebSearch);
    if (wantsWeb && !steps.some((s) => s.capability === "web.search") && !stillSuppressed.includes("web.search")) {
      const complement = planComplement("web.search", toolQuery, intent, tools);
      if (complement) await runMore([complement]);
    }

    // 4d. Dependent step: read the most important pages in full — only after their URLs are known.
    if (research && env.VEYRA_RESEARCH_EXTRACT_TOP > 0) {
      await runMore(planFollowUp("web.extract", selectPagesToExtract(outputs, env.VEYRA_RESEARCH_EXTRACT_TOP), intent, tools, { query: toolQuery, blockedDomains: blocked }));
    } else {
      const urls: string[] = [];
      // The user explicitly asked about the project's website/docs: read the homepage the repository declares (1 page).
      if (WEBSITE_REQUEST.test(req.message)) urls.push(...outputs.filter((o) => o.capability === "github.repo").flatMap((o) => o.related ?? []).slice(0, 1));
      if (rssRan && env.NEWS_EXTRACT_TOP > 0) urls.push(...outputs.filter((o) => o.capability === "news.feed").flatMap((o) => o.related ?? []).slice(0, env.NEWS_EXTRACT_TOP));
      if (urls.length) await runMore(planFollowUp("web.extract", urls, intent, tools, { query: toolQuery, blockedDomains: blocked }));
    }
    const toolsMs = Date.now() - toolsStarted;

    // Required capability with every step failed → unavailable (model is told). Otherwise → partial failure (warning).
    const failed: VeyraResponse["plan"]["unavailable"] = [];
    const partialFailures: string[] = [];
    for (const capability of new Set(steps.map((s) => s.capability))) {
      const capSteps = steps.filter((s) => s.capability === capability);
      const okSteps = capSteps.filter((s) => outputs.some((o) => o.step === s.id));
      const counts = new Map<string, number>();
      for (const r of runs) {
        if (r.capability !== capability || r.status !== "error") continue;
        const label = `${r.tool} (${r.error?.kind ?? "error"})`;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      const errors = [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(", ");
      const via = recovery.recovered.find((r) => r.capability === capability)?.fallback;
      if (okSteps.length === 0 && capSteps.some((s) => !s.optional)) {
        failed.push({
          capability,
          reason: `all tools failed: ${errors}${via ? ` — using ${via} as a fallback` : ""}`,
          ...(via && isEquivalentFallback(capability, via) ? { soft: true } : {}),
        });
      } else if (okSteps.length < capSteps.length) partialFailures.push(`${capSteps.length - okSteps.length} of ${capSteps.length} ${capability} steps failed: ${errors}`);
    }
    const unavailable = [...toolPlan.unavailable, ...failed];

    // 5. VERIFY / NORMALIZE / RANK: high-quality context, not raw API dumps.
    const families = plannedFamilies(steps);
    const base = research ? env.VEYRA_RESEARCH_MAX_SOURCES : env.VEYRA_MAX_SOURCES;
    const maxSources = Math.max(
      outputs.some((o) => o.capability === "github.repo") ? env.GITHUB_MAX_FILES + 8 : base,
      families.size >= 2 ? base + 4 : base,
    );
    const built = buildContext(outputs, {
      maxSources,
      maxContextChars: env.VEYRA_MAX_CONTEXT_CHARS,
      blockedDomains: blocked,
      timeSensitive: intent.intents.some((i) => i === "news" || i === "market" || i === "onchain") || TIME_SENSITIVE.test(req.message),
      trustedDomains: (env.VEYRA_TRUSTED_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean),
    });
    const sources = built.sources;
    const usedFamilies = new Set(sources.map((s) => s.family));
    const type = responseTypeFor(intent.primary, usedFamilies);

    // 6. FINAL MODEL CHOICE, now that the size and mix of the context are known.
    const contextChars = sources.reduce((n, s) => n + (s.content?.length ?? 0), 0);
    const finalChoice = modelRouter.chooseTier(intent.intents, { families: Math.max(usedFamilies.size, intentFamilies.size), contextChars });
    if (finalChoice.tier !== candidatePlan.tier) {
      const replanned = modelRouter.plan(finalChoice.tier, preference, req.strictModel, { lowLatency: streaming });
      if (replanned.candidates.length) {
        candidatePlan = replanned;
        choice = finalChoice;
        log.info("model.retiered", { tier: finalChoice.tier, reasons: finalChoice.reasons });
      }
    } else choice = finalChoice;

    const data: VeyraResponse["data"] = {};
    for (const o of outputs) (data[o.capability] ??= []).push({ tool: o.tool, step: o.step, data: o.data });
    const needsLive = intent.intents.some((i) => LIVE_INTENTS.has(i));

    // 7. REASONING INPUT — bounded history plus fenced, ranked, numbered sources.
    const messages = buildMessages({
      system: buildSystemPrompt({
        type,
        alsoTypes: sources.flatMap((s): ResponseType[] => (s.type === "onchain" || s.type === "market" || s.type === "github" ? [s.type] : [])),
        now: new Date(),
        // "Soft" gaps (an equivalent fallback covered them) are shown to the user, not the model.
        unavailable: unavailable.filter((u) => !u.soft),
        canary: this.deps.outputGuard.canary,
      }),
      history,
      question: req.message,
      sources,
    });

    const publicSources = sources.map(toPublicSource);
    const cacheHits = runs.filter((r) => r.cached).length;
    const retrieval = { ...built.stats, cacheHits };
    emit({ type: "context.ready", requestId: id, sources: publicSources, toolRuns: runs, data, retrieval });
    for (const s of publicSources) emit({ type: "source.discovered", requestId: id, source: s });
    log.info("context.built", {
      type,
      sources: sources.length,
      byFamily: built.stats.byFamily,
      duplicatesRemoved: built.stats.duplicatesRemoved,
      dropped: built.stats.droppedByLimit,
      contextChars,
      cacheHits,
      unavailable: unavailable.map((u) => u.capability),
      tier: choice.tier,
    });

    return {
      id,
      log,
      started,
      type,
      preference,
      candidatePlan,
      messages,
      sources,
      toolRuns: runs,
      data,
      retrieval,
      partialFailures: [...partialFailures, ...new Set(outputs.flatMap((o) => o.notices ?? []))],
      allowedUrls: [...sources.flatMap((s) => (s.url ? [s.url] : [])), ...intent.entities.urls, ...outputs.flatMap((o) => o.citableUrls ?? [])],
      grounded: !needsLive || sources.length > 0,
      toolsMs,
      publicPlan: planFor(
        steps,
        stageOneFailures.map((f) => f.capability),
        unavailable,
        modelInfo(candidatePlan, choice.reasons),
      ),
    };
  }

  private finish(prep: Prepared, out: { answer: string; attempts: Attempt[]; cached: boolean; llmMs: number; usage?: TokenUsage }): VeyraResponse {
    const used = out.attempts.findLast((a) => a.ok) ?? { provider: "unknown", model: "unknown" };
    const first = prep.candidatePlan.candidates[0];
    const preferredProvider = prep.preference.kind === "auto" ? undefined : prep.preference.provider;
    const fallbackUsed =
      (first !== undefined && (first.provider.id !== used.provider || first.model !== used.model)) || (preferredProvider !== undefined && preferredProvider !== used.provider);

    // Output guards: verified citations → only real links → no secrets / system prompt.
    const citations = checkCitations(out.answer, prep.sources);
    const links = this.deps.outputGuard.removeUnverifiedUrls(citations.answer, prep.allowedUrls);
    const redaction = this.deps.outputGuard.redact(links.text);

    const warnings = prep.publicPlan.unavailable.map((u) => `Live data unavailable — ${u.capability}: ${u.reason}`);
    warnings.push(...prep.partialFailures);
    for (const b of prep.publicPlan.blockedUrls) warnings.push(`Blocked unsafe URL (not fetched): ${b.url} — ${b.reason}`);
    const NON_INJECTION = new Set(["punycode_domain", "secret_redacted"]);
    const flagged = prep.sources.filter((s) => s.securityFlags?.some((f) => !NON_INJECTION.has(f)));
    if (flagged.length) warnings.push(`Possible prompt injection: instruction-like text was removed from source(s) ${flagged.map((s) => `[${s.id}]`).join(", ")} and treated as data.`);
    const withSecrets = prep.sources.filter((s) => s.securityFlags?.includes("secret_redacted"));
    if (withSecrets.length) warnings.push(`Credentials/secrets found in retrieved content were redacted from source(s) ${withSecrets.map((s) => `[${s.id}]`).join(", ")}.`);
    if (links.removed.length) warnings.push(`Removed ${links.removed.length} link(s) that were not among the sources.`);
    if (redaction.findings.length) warnings.push(`Redacted sensitive content from the answer (${redaction.findings.join(", ")}).`);
    if (citations.invalid.length) warnings.push(`Removed citation(s) to non-existent source(s): ${citations.invalid.map((n) => `[${n}]`).join(", ")}`);
    if (prep.sources.length && citations.used.length === 0 && used.provider !== "dev-mock") warnings.push("The answer does not cite any of the retrieved sources.");
    if (preferredProvider && preferredProvider !== used.provider) {
      const skip = prep.candidatePlan.skipped.find((s) => s.provider === preferredProvider);
      warnings.push(`Requested provider "${preferredProvider}" was not used${skip ? ` (${skip.reason})` : ""}; answered by ${used.provider}.`);
    } else if (fallbackUsed) warnings.push(`Fell back to ${used.provider}/${used.model}.`);
    if (used.provider === "dev-mock") warnings.push("DEVELOPMENT MOCK answered — this is not a real model response.");

    return {
      id: prep.id,
      type: prep.type,
      answer: redaction.text,
      grounded: prep.grounded,
      sources: prep.sources.map(toPublicSource),
      citations: { used: citations.used, invalid: citations.invalid, statements: citations.statements },
      knowledge: analyzeClaims(redaction.text, citations.statements, prep.publicPlan.unavailable),
      security: {
        flaggedSources: [...new Set([...flagged, ...withSecrets])].map((s) => ({ id: s.id, flags: s.securityFlags ?? [] })),
        blockedUrls: prep.publicPlan.blockedUrls,
        // The removed links themselves may contain secrets (e.g. a model echoing an RPC URL with a key).
        removedLinks: links.removed.map((l) => this.deps.outputGuard.redact(l).text),
        redactions: redaction.findings,
      },
      data: prep.data,
      plan: prep.publicPlan,
      retrieval: prep.retrieval,
      toolRuns: prep.toolRuns,
      model: { provider: used.provider, model: used.model, fallbackUsed, cached: out.cached, attempts: out.attempts },
      ...(out.usage ? { usage: out.usage } : {}),
      timings: { totalMs: Date.now() - prep.started, toolsMs: prep.toolsMs, llmMs: out.llmMs },
      warnings,
    };
  }

  /** Hybrid mode: ask the cheapest available model to classify; keep the rules result on any failure. */
  private async refineIntent(rules: IntentResult, message: string, signal: AbortSignal): Promise<IntentResult> {
    const schema = z.object({ intents: z.array(z.enum(INTENTS)).min(1).max(4) });
    const plan = this.deps.modelRouter.plan("cheap", { kind: "auto" });
    try {
      const { value } = await this.deps.modelRouter.structured(
        plan,
        [
          {
            role: "system",
            content:
              "Classify the user's request into 1-4 intents. general: chit-chat/knowledge; coding: write/debug code; summarize: condense given text; web_search: needs current web info; web_extract: read a specific URL; research: multi-source deep research; news: recent news; github: a GitHub repo; onchain: blockchain addresses/transactions/blocks/Robinhood Chain; market: token prices/volume/liquidity.",
          },
          { role: "user", content: message.slice(0, 2000) },
        ],
        schema,
        signal,
      );
      const intents = orderIntents(value.data.intents);
      return { ...rules, intents, primary: intents[0]!, method: "llm", confidence: 0.8 };
    } catch (err) {
      this.deps.logger.debug("LLM intent classification failed; using rules", { error: (err as Error).message });
      return rules;
    }
  }
}

function toPublicSource(s: Source): PublicSource {
  const { content, snippet, ...meta } = s;
  const excerpt = snippet ?? content;
  return { ...meta, ...(excerpt ? { snippet: excerpt.length > 300 ? `${excerpt.slice(0, 299)}…` : excerpt } : {}) };
}
