import { VeyraError } from "../../core/errors.js";
import { httpJson, httpRequest } from "../../core/http.js";
import { readSSEData } from "../../core/sse.js";
import { BaseLLMProvider, deepMerge } from "./base.js";
import type { GenerateRequest, GenerateResult, StreamEvent, TokenUsage } from "./types.js";

export interface OpenAICompatibleOptions {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string | undefined;
  /** Optional second key, used only when the main key is rejected (revoked/invalid) — not for rate limits. */
  backupApiKey?: string | undefined;
  defaultModel: string;
  timeoutMs: number;
  extraHeaders?: Record<string, string>;
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface CompletionResponse {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: RawUsage;
  error?: { message?: string; code?: number | string };
}

interface CompletionChunk {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: RawUsage | null;
  x_groq?: { usage?: RawUsage };
  error?: { message?: string };
}

/** Works for any OpenAI-style /chat/completions API — used by OpenRouter and Groq. */
export class OpenAICompatibleProvider extends BaseLLMProvider {
  readonly id: string;
  readonly label: string;
  readonly defaultModel: string;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    super();
    this.id = opts.id;
    this.label = opts.label;
    this.defaultModel = opts.defaultModel;
  }

  isConfigured(): boolean {
    return Boolean(this.opts.apiKey || this.opts.backupApiKey);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const data = await this.withKey((headers) =>
      httpJson<CompletionResponse>(`${this.opts.baseUrl}/chat/completions`, {
        source: this.id,
        headers,
        body: this.body(req, false),
        timeoutMs: this.opts.timeoutMs,
        ...(req.signal ? { signal: req.signal } : {}),
      }),
    );
    // OpenRouter can report upstream failures inside a 200 response.
    if (data.error) throw new VeyraError("upstream", this.id, data.error.message ?? "Provider returned an error");

    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? "";
    if (!text.trim()) {
      throw new VeyraError("invalid_output", this.id, `Empty completion (finish_reason: ${choice?.finish_reason ?? "unknown"})`);
    }
    return {
      text,
      provider: this.id,
      model: data.model ?? req.model,
      ...(data.usage ? { usage: mapUsage(data.usage) } : {}),
      ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
    };
  }

  async *stream(req: GenerateRequest): AsyncGenerator<StreamEvent> {
    // A rejected key is reported before the first byte, so switching keys here never splits a stream.
    const res = await this.withKey((headers) =>
      httpRequest(`${this.opts.baseUrl}/chat/completions`, {
        source: this.id,
        headers,
        body: this.body(req, true),
        timeoutMs: this.opts.timeoutMs,
        ...(req.signal ? { signal: req.signal } : {}),
      }),
    );
    if (!res.body) throw new VeyraError("upstream", this.id, "Missing response body");

    let usage: TokenUsage | undefined;
    let finishReason: string | undefined;
    for await (const payload of readSSEData(res.body)) {
      if (payload === "[DONE]") break;
      let chunk: CompletionChunk;
      try {
        chunk = JSON.parse(payload) as CompletionChunk;
      } catch {
        continue;
      }
      if (chunk.error) throw new VeyraError("upstream", this.id, chunk.error.message ?? "Stream error");
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) yield { type: "delta", text: choice.delta.content };
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const rawUsage = chunk.usage ?? chunk.x_groq?.usage;
      if (rawUsage) usage = mapUsage(rawUsage);
    }
    yield { type: "done", ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}) };
  }

  /** Until this time the main key is known to be rejected, so calls go straight to the backup key. */
  private mainKeyRejectedUntil = 0;

  /**
   * Runs one call with the active key; if that key is rejected (auth) and the other key exists, retries once
   * with it. At most two attempts, never a loop. Rate limits/quota are account-wide, so they don't switch keys.
   */
  private async withKey<T>(call: (headers: Record<string, string>) => Promise<T>): Promise<T> {
    const { apiKey, backupApiKey } = this.opts;
    if (!apiKey && !backupApiKey) throw new VeyraError("not_configured", this.id, `${this.label} API key is not set`);
    const useBackupFirst = !apiKey || (Boolean(backupApiKey) && Date.now() < this.mainKeyRejectedUntil);
    const first = (useBackupFirst ? backupApiKey : apiKey)!;
    const second = useBackupFirst ? apiKey : backupApiKey;
    try {
      return await call(this.headers(first));
    } catch (err) {
      if (!(err instanceof VeyraError) || err.kind !== "auth" || !second) throw err;
      // Remember which key failed: a rejected main key is skipped for 10 minutes; a rejected backup clears that.
      this.mainKeyRejectedUntil = first === apiKey ? Date.now() + 10 * 60_000 : 0;
      return call(this.headers(second));
    }
  }

  private headers(key: string): Record<string, string> {
    return { Authorization: `Bearer ${key}`, ...this.opts.extraHeaders };
  }

  private body(req: GenerateRequest, stream: boolean): Record<string, unknown> {
    return deepMerge(
      {
        model: req.model,
        messages: req.messages,
        temperature: req.temperature ?? 0.3,
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
        stream,
      },
      req.extra,
    );
  }
}

function mapUsage(u: RawUsage): TokenUsage {
  return {
    ...(u.prompt_tokens !== undefined ? { inputTokens: u.prompt_tokens } : {}),
    ...(u.completion_tokens !== undefined ? { outputTokens: u.completion_tokens } : {}),
  };
}
