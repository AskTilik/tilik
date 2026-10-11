import { cacheKey, TtlCache } from "../cache/ttl-cache.js";
import { VeyraError, publicErrorMessage, toVeyraError, type ErrorKind } from "../core/errors.js";
import { Cooldowns, DailyBudget, RateLimiter } from "../core/guards.js";
import type { Logger } from "../core/logger.js";
import type { Entities } from "../router/intent.js";
import type { PlannedStep, ToolPlan } from "../router/tool-router.js";
import type { SourceInput } from "../sources/types.js";
import type { AnyTool, Capability, ToolResult } from "./types.js";

export interface ToolRun {
  step: string;
  capability: Capability;
  tool: string;
  status: "ok" | "error";
  ms: number;
  /** Invocations made (1 + retries actually used). */
  attempts?: number;
  cached?: boolean;
  error?: { kind: ErrorKind; message: string };
}

/** Lifecycle callbacks (used for live progress events). Must not throw. */
export interface RunHooks {
  onStart?(step: PlannedStep, tool: AnyTool): void;
  onEnd?(run: ToolRun): void;
}

export interface ToolOutput {
  step: string;
  capability: Capability;
  tool: string;
  data: unknown;
  sources: SourceInput[];
  notices?: string[];
  citableUrls?: string[];
  related?: string[];
  suggestWebSearch?: boolean;
}

export interface ToolRunnerDeps {
  logger: Logger;
  defaultTimeoutMs: number;
  cache?: TtlCache<ToolResult<unknown>>;
  limiter?: RateLimiter;
  cooldowns?: Cooldowns;
  budget?: DailyBudget;
}

/** Shared by every run() of one request: a hard ceiling on real tool executions (cache hits are free). */
export type CallBudget = { used: number; max: number };
type RunContext = { entities: Entities; signal: AbortSignal; callBudget?: CallBudget };

/**
 * Executes a tool plan. Steps run in parallel; within a step, "first" tries
 * candidates in order (fallback) and "all" runs them together (research).
 * A failing tool never sinks the request.
 */
export class ToolRunner {
  private readonly cache: TtlCache<ToolResult<unknown>>;
  private readonly limiter: RateLimiter;
  private readonly cooldowns: Cooldowns;
  private readonly budget: DailyBudget;
  /** Identical calls already in flight share one upstream request. */
  private readonly inflight = new Map<string, Promise<ToolResult<unknown>>>();

  constructor(private readonly deps: ToolRunnerDeps) {
    this.cache = deps.cache ?? new TtlCache(500);
    this.limiter = deps.limiter ?? new RateLimiter();
    this.cooldowns = deps.cooldowns ?? new Cooldowns();
    this.budget = deps.budget ?? new DailyBudget();
  }

  /** Today's upstream calls vs. limit per tool (for /health). */
  get budgetSnapshot() {
    return this.budget.snapshot();
  }

  async run(plan: ToolPlan, ctx: RunContext, hooks: RunHooks = {}): Promise<{ runs: ToolRun[]; outputs: ToolOutput[] }> {
    const runs: ToolRun[] = [];
    const outputs: ToolOutput[] = [];

    await Promise.all(
      plan.steps.map(async (step) => {
        if (step.strategy === "all") {
          await Promise.all(step.candidates.map((c) => this.attempt(step, c.tool, c.input, ctx, runs, outputs, hooks)));
          return;
        }
        for (const { tool, input } of step.candidates) {
          if (await this.attempt(step, tool, input, ctx, runs, outputs, hooks)) return;
        }
      }),
    );
    return { runs, outputs };
  }

  private async attempt(
    step: PlannedStep,
    tool: AnyTool,
    input: unknown,
    ctx: RunContext,
    runs: ToolRun[],
    outputs: ToolOutput[],
    hooks: RunHooks,
  ): Promise<boolean> {
    const started = Date.now();
    const base = { step: step.id, capability: step.capability, tool: tool.name };
    hooks.onStart?.(step, tool);
    const finish = (run: ToolRun) => {
      runs.push(run);
      hooks.onEnd?.(run);
    };
    let attempts = 0;
    try {
      // Retry policy: transient failures only (timeout, network, 5xx), bounded, with backoff.
      let outcome: { result: ToolResult<unknown>; cached: boolean } | undefined;
      for (;;) {
        attempts++;
        try {
          outcome = await this.execute(tool, input, { query: step.query, ...ctx });
          break;
        } catch (err) {
          const e = toVeyraError(err, `tool:${tool.name}`);
          const transient = e.kind === "timeout" || e.kind === "network" || e.kind === "upstream";
          if (!transient || attempts > (tool.retries ?? 0) || ctx.signal.aborted) throw e;
          await new Promise((r) => setTimeout(r, Math.min(2000, 300 * 2 ** (attempts - 1))));
        }
      }
      const { result, cached } = outcome;
      finish({ ...base, status: "ok", ms: Date.now() - started, attempts, ...(cached ? { cached } : {}) });
      outputs.push({
        ...base,
        data: result.data,
        sources: result.sources,
        ...(result.notices?.length ? { notices: result.notices } : {}),
        ...(result.citableUrls?.length ? { citableUrls: result.citableUrls } : {}),
        ...(result.related?.length ? { related: result.related } : {}),
        ...(result.suggestWebSearch ? { suggestWebSearch: true } : {}),
      });
      return true;
    } catch (err) {
      const e = toVeyraError(err, `tool:${tool.name}`);
      if (e.kind === "aborted") throw e;
      if (e.kind === "rate_limit" || e.kind === "quota" || e.kind === "auth") {
        this.cooldowns.mark(tool.name, e.retryAfterMs ?? (e.kind === "rate_limit" ? 30_000 : 10 * 60_000));
      }
      this.deps.logger.warn("tool failed", { tool: tool.name, step: step.id, kind: e.kind, attempts, error: e.message });
      finish({ ...base, status: "error", ms: Date.now() - started, attempts, error: { kind: e.kind, message: publicErrorMessage(e.message) } });
      return false;
    }
  }

  private async execute(
    tool: AnyTool,
    rawInput: unknown,
    ctx: { query: string; entities: Entities; signal: AbortSignal; callBudget?: CallBudget },
  ): Promise<{ result: ToolResult<unknown>; cached: boolean }> {
    const source = `tool:${tool.name}`;
    const input = tool.inputSchema.safeParse(rawInput);
    if (!input.success) throw new VeyraError("bad_request", source, `Invalid tool input: ${input.error.message}`);

    const ttlMs = (tool.cacheTtlSeconds ?? 0) * 1000;
    const key = cacheKey("tool", tool.name, input.data);
    const hit = ttlMs > 0 ? this.cache.get(key) : undefined;
    if (hit) return { result: hit, cached: true };
    const pending = this.inflight.get(key);
    if (pending) return { result: await pending, cached: true };

    // Per-request ceiling: recovery, complements, follow-ups and retries all draw from the same budget.
    if (ctx.callBudget) {
      if (ctx.callBudget.used >= ctx.callBudget.max) throw new VeyraError("budget", source, "Per-request tool budget reached");
      ctx.callBudget.used++;
    }
    if (this.cooldowns.isCooling(tool.name)) throw new VeyraError("rate_limit", source, "Tool is cooling down after a recent failure");
    if (tool.rateLimit && !this.limiter.tryAcquire(tool.name, tool.rateLimit.requestsPerMinute)) {
      throw new VeyraError("rate_limit", source, "Local rate limit reached");
    }
    if (!this.budget.tryConsume(tool.name, tool.dailyLimit ?? 0)) {
      throw new VeyraError("budget", source, `Daily request limit (${tool.dailyLimit}) reached`);
    }

    const work = (async () => {
      const timeoutMs = tool.timeoutMs ?? this.deps.defaultTimeoutMs;
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
      const result = await withDeadline(tool.execute(input.data, { ...ctx, signal }), signal, source, timeoutMs);
      const data = tool.outputSchema.safeParse(result.data);
      if (!data.success) throw new VeyraError("invalid_output", source, `Tool output failed validation: ${data.error.message}`);
      const { data: _raw, ...extras } = result;
      const validated = { ...extras, data: data.data };
      // A result may ask for a shorter lifetime (e.g. private repository content), never a longer one.
      const effectiveTtl = result.cacheTtlSeconds !== undefined ? Math.min(ttlMs, result.cacheTtlSeconds * 1000) : ttlMs;
      if (effectiveTtl > 0) this.cache.set(key, validated, effectiveTtl);
      return validated;
    })();
    this.inflight.set(key, work);
    try {
      return { result: await work, cached: false };
    } finally {
      this.inflight.delete(key);
    }
  }
}

/** Guards against tools that ignore their AbortSignal. */
function withDeadline<T>(work: Promise<T>, signal: AbortSignal, source: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const timedOut = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
      reject(new VeyraError(timedOut ? "timeout" : "aborted", source, timedOut ? `Timed out after ${timeoutMs}ms` : "Aborted"));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
