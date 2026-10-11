import type { Env } from "../../config/env.js";
import { VeyraError } from "../../core/errors.js";
import { httpJson, httpRequest } from "../../core/http.js";
import { readSSEData } from "../../core/sse.js";
import { BaseLLMProvider, deepMerge } from "./base.js";
import type { GenerateRequest, GenerateResult, StreamEvent, TokenUsage } from "./types.js";

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
}

/** Google Gemini via the native Generative Language REST API. */
export class GeminiProvider extends BaseLLMProvider {
  readonly id = "gemini";
  readonly label = "Google Gemini";
  readonly defaultModel: string;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly baseUrl: string,
    defaultModel: string,
    private readonly timeoutMs: number,
  ) {
    super();
    this.defaultModel = defaultModel;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const data = await httpJson<GeminiResponse>(this.url(req.model, "generateContent"), {
      source: this.id,
      headers: this.headers(),
      body: this.body(req),
      timeoutMs: this.timeoutMs,
      ...(req.signal ? { signal: req.signal } : {}),
    });
    const { text, finishReason } = this.extract(data);
    if (!text.trim()) {
      throw new VeyraError("invalid_output", this.id, `Empty completion (finishReason: ${finishReason ?? "unknown"})`);
    }
    const usage = mapUsage(data);
    return {
      text,
      provider: this.id,
      model: data.modelVersion ?? req.model,
      ...(usage ? { usage } : {}),
      ...(finishReason ? { finishReason } : {}),
    };
  }

  async *stream(req: GenerateRequest): AsyncGenerator<StreamEvent> {
    const res = await httpRequest(`${this.url(req.model, "streamGenerateContent")}?alt=sse`, {
      source: this.id,
      headers: this.headers(),
      body: this.body(req),
      timeoutMs: this.timeoutMs,
      ...(req.signal ? { signal: req.signal } : {}),
    });
    if (!res.body) throw new VeyraError("upstream", this.id, "Missing response body");

    let usage: TokenUsage | undefined;
    let finishReason: string | undefined;
    for await (const payload of readSSEData(res.body)) {
      let chunk: GeminiResponse;
      try {
        chunk = JSON.parse(payload) as GeminiResponse;
      } catch {
        continue;
      }
      const extracted = this.extract(chunk);
      if (extracted.text) yield { type: "delta", text: extracted.text };
      if (extracted.finishReason) finishReason = extracted.finishReason;
      usage = mapUsage(chunk) ?? usage;
    }
    yield { type: "done", ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}) };
  }

  private extract(data: GeminiResponse): { text: string; finishReason?: string } {
    if (data.promptFeedback?.blockReason) {
      throw new VeyraError("bad_request", this.id, `Prompt blocked by Gemini safety filter: ${data.promptFeedback.blockReason}`);
    }
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("");
    return { text, ...(candidate?.finishReason ? { finishReason: candidate.finishReason } : {}) };
  }

  private url(model: string, method: string): string {
    const id = model.replace(/^models\//, "");
    return `${this.baseUrl}/models/${encodeURIComponent(id)}:${method}`;
  }

  /** Key goes in a header, not the query string, so it never appears in URLs or logs. */
  private headers(): Record<string, string> {
    if (!this.apiKey) throw new VeyraError("not_configured", this.id, "Gemini API key is not set");
    return { "x-goog-api-key": this.apiKey };
  }

  private body(req: GenerateRequest): Record<string, unknown> {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content);
    const contents = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    return deepMerge(
      {
        contents,
        ...(system.length ? { systemInstruction: { parts: [{ text: system.join("\n\n") }] } } : {}),
        generationConfig: {
          temperature: req.temperature ?? 0.3,
          ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
          ...(req.json ? { responseMimeType: "application/json" } : {}),
        },
      },
      req.extra,
    );
  }
}

function mapUsage(data: GeminiResponse): TokenUsage | undefined {
  const u = data.usageMetadata;
  if (!u) return undefined;
  return {
    ...(u.promptTokenCount !== undefined ? { inputTokens: u.promptTokenCount } : {}),
    ...(u.candidatesTokenCount !== undefined ? { outputTokens: u.candidatesTokenCount } : {}),
  };
}

export function createGeminiProvider(env: Env): GeminiProvider {
  return new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_BASE_URL, env.GEMINI_DEFAULT_MODEL, env.VEYRA_LLM_TIMEOUT_MS);
}
