// Test doubles only — never imported by src/.
import { z } from "zod";
import { loadEnv, type Env } from "../src/config/env.js";
import { VeyraError, type ErrorKind } from "../src/core/errors.js";
import { BaseLLMProvider } from "../src/providers/llm/base.js";
import type { GenerateRequest, GenerateResult, StreamEvent } from "../src/providers/llm/types.js";
import type { Tool } from "../src/tools/types.js";
import type { SourceInput } from "../src/sources/types.js";

export interface FetchCall {
  url: string;
  body: any;
  headers: Record<string, string>;
}

/** Replaces global fetch so real tool code runs against canned upstream responses. Call restore() after. */
export function mockFetch(handler: (url: string, body: any, init: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, body, headers });
    return handler(url, body, init);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

export const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** A request that never answers until its signal aborts (used for timeout tests). */
export const hang = (init: RequestInit) =>
  new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));

export function testEnv(overrides: Record<string, string> = {}): Env {
  // RSS and the chain tool are off unless a test turns them on (both work without keys, so they'd otherwise run everywhere).
  return loadEnv({ NODE_ENV: "test", VEYRA_LOG_LEVEL: "error", RSS_ENABLED: "false", ONCHAIN_ENABLED: "false", MARKET_ENABLED: "false", ...overrides });
}

export class FakeProvider extends BaseLLMProvider {
  readonly label: string;
  calls: GenerateRequest[] = [];

  constructor(
    readonly id: string,
    private readonly behaviour: { fail?: ErrorKind; reply?: string; configured?: boolean } = {},
    readonly defaultModel = `${id}-default`,
  ) {
    super();
    this.label = id;
  }

  isConfigured() {
    return this.behaviour.configured ?? true;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    if (this.behaviour.fail) throw new VeyraError(this.behaviour.fail, this.id, `fake ${this.behaviour.fail}`);
    return { text: this.behaviour.reply ?? `answer from ${this.id}`, provider: this.id, model: req.model };
  }

  async *stream(req: GenerateRequest): AsyncGenerator<StreamEvent> {
    const result = await this.generate(req);
    for (const part of result.text.split(" ")) yield { type: "delta", text: `${part} ` };
    yield { type: "done", usage: { inputTokens: 1, outputTokens: 2 } };
  }
}

/** Provider whose reply is computed from the request; `chunks` controls how stream() splits it. */
export class ScriptedProvider extends BaseLLMProvider {
  readonly label = "scripted";
  calls: GenerateRequest[] = [];

  constructor(
    readonly id: string,
    private readonly reply: (req: GenerateRequest) => string,
    private readonly chunks: (text: string) => string[] = (t) => [t],
    readonly defaultModel = `${id}-default`,
  ) {
    super();
  }

  isConfigured() {
    return true;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    return { text: this.reply(req), provider: this.id, model: req.model };
  }

  async *stream(req: GenerateRequest): AsyncGenerator<StreamEvent> {
    this.calls.push(req);
    for (const c of this.chunks(this.reply(req))) yield { type: "delta", text: c };
    yield { type: "done" };
  }
}

export function fakeTool(opts: {
  name: string;
  capability: string;
  configured?: boolean;
  fail?: ErrorKind;
  sources?: SourceInput[];
  costTier?: "free" | "low" | "paid";
  cacheTtlSeconds?: number;
  needsUrl?: boolean;
}): Tool<{ q: string }, { n: number }> & { executions: number } {
  return {
    name: opts.name,
    description: "test tool",
    capabilities: [opts.capability],
    inputSchema: z.object({ q: z.string() }),
    outputSchema: z.object({ n: z.number() }),
    auth: { envKeys: [`${opts.name.toUpperCase()}_KEY`] },
    costTier: opts.costTier ?? "free",
    cacheTtlSeconds: opts.cacheTtlSeconds ?? 0,
    executions: 0,
    isConfigured: () => opts.configured ?? true,
    planInput: (ctx) => (opts.needsUrl && ctx.entities.urls.length === 0 ? null : { q: ctx.query }),
    async execute() {
      this.executions++;
      if (opts.fail) throw new VeyraError(opts.fail, `tool:${opts.name}`, `fake ${opts.fail}`);
      return {
        data: { n: 1 },
        sources: opts.sources ?? [
          { title: `${opts.name} result`, url: `https://example.com/${opts.name}`, type: "web", evidence: "search_result", content: "c" },
        ],
      };
    },
  };
}
