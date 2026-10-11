import type { z } from "zod";

/** Open string so new providers can be added without touching shared types. */
export type ProviderId = string;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for a JSON object response where supported. */
  json?: boolean;
  /** Provider-specific request body fields, deep-merged (e.g. Gemini thinkingConfig). */
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface GenerateResult {
  text: string;
  provider: ProviderId;
  model: string;
  usage?: TokenUsage;
  finishReason?: string;
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; usage?: TokenUsage; finishReason?: string };

export interface StructuredResult<T> extends Omit<GenerateResult, "text"> {
  data: T;
  raw: string;
}

/** The single contract every model backend implements. */
export interface LLMProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly defaultModel: string;
  isConfigured(): boolean;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  stream(req: GenerateRequest): AsyncIterable<StreamEvent>;
  structuredGenerate<T>(req: Omit<GenerateRequest, "json">, schema: z.ZodType<T>): Promise<StructuredResult<T>>;
}
