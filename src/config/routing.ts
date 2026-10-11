import { readFileSync } from "node:fs";
import { z } from "zod";
import { INTENTS } from "../router/intent.js";

export const TIERS = ["cheap", "fast", "coding", "reasoning"] as const;
export type Tier = (typeof TIERS)[number];

const CandidateSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** Provider-specific body fields, e.g. Gemini thinkingConfig. */
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type CandidateConfig = z.infer<typeof CandidateSchema>;

const RoutingSchema = z.object({
  /** Ordered candidates per tier. Earlier = preferred; later = fallbacks. */
  tiers: z.record(z.enum(TIERS), z.array(CandidateSchema).min(1)),
  /** Which tier each intent needs. With several intents, the highest in tierRank wins. */
  intentTiers: z.record(z.enum(INTENTS), z.enum(TIERS)),
  /** Highest first. */
  tierRank: z.array(z.enum(TIERS)),
});
export type RoutingConfig = z.infer<typeof RoutingSchema>;

/**
 * OpenRouter is the primary provider in every tier; Gemini is the cross-provider fallback (so an OpenRouter
 * outage doesn't take answers down), then Groq, then a second OpenRouter model. Each model is tried at most
 * once (VEYRA_MAX_MODEL_ATTEMPTS caps the chain). Streaming follows the same order unless
 * VEYRA_STREAM_PREFER_GROQ=true. Groq models verified 2026-10-08: only gpt-oss-120b/20b (no Llama) on new keys.
 *
 * Gemini models verified against the Gemini API on 2026-10-08: the 2.5 family is "no longer available to new
 * users"; gemini-flash-lite-latest is fast and reliable (~4 s) but rejects thinkingBudget: 0; gemini-3.8-flash
 * works but is slower and sometimes 503s under load (fine as a fallback for coding/reasoning); Pro models need
 * a paid quota. Model ids change often — override with VEYRA_ROUTING_FILE rather than editing code.
 */
export const DEFAULT_ROUTING: RoutingConfig = {
  tiers: {
    cheap: [
      { provider: "openrouter", model: "openai/gpt-oss-20b", maxTokens: 800 },
      { provider: "gemini", model: "gemini-flash-lite-latest", maxTokens: 800 },
      { provider: "groq", model: "openai/gpt-oss-20b", maxTokens: 800 },
    ],
    fast: [
      { provider: "openrouter", model: "openai/gpt-oss-120b", maxTokens: 1500 },
      { provider: "gemini", model: "gemini-flash-lite-latest", maxTokens: 1500 },
      { provider: "groq", model: "openai/gpt-oss-120b", maxTokens: 1500 },
      // Same-provider fallback, so OpenRouter-only setups still have one (its default model is the 120b above).
      { provider: "openrouter", model: "openai/gpt-oss-20b", maxTokens: 1500 },
    ],
    coding: [
      { provider: "openrouter", model: "qwen/qwen3-coder", maxTokens: 3000, temperature: 0.2 },
      { provider: "gemini", model: "gemini-3.8-flash", maxTokens: 3000, temperature: 0.2 },
      { provider: "groq", model: "openai/gpt-oss-120b", maxTokens: 3000, temperature: 0.2 },
    ],
    reasoning: [
      { provider: "openrouter", model: "deepseek/deepseek-v4-pro", maxTokens: 4000 },
      { provider: "gemini", model: "gemini-3.8-flash", maxTokens: 4000 },
      { provider: "groq", model: "openai/gpt-oss-120b", maxTokens: 4000 },
    ],
  },
  intentTiers: {
    general: "fast",
    coding: "coding",
    summarize: "cheap",
    web_search: "fast",
    web_extract: "fast",
    research: "reasoning",
    news: "fast",
    github: "coding",
    onchain: "fast",
    market: "fast",
  },
  tierRank: ["reasoning", "coding", "fast", "cheap"],
};

/** Loads DEFAULT_ROUTING, shallow-merged with an optional JSON override file. */
export function loadRouting(file?: string): RoutingConfig {
  if (!file) return DEFAULT_ROUTING;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<RoutingConfig>;
  return RoutingSchema.parse({
    tiers: { ...DEFAULT_ROUTING.tiers, ...raw.tiers },
    intentTiers: { ...DEFAULT_ROUTING.intentTiers, ...raw.intentTiers },
    tierRank: raw.tierRank ?? DEFAULT_ROUTING.tierRank,
  });
}
