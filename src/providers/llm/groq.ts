import type { Env } from "../../config/env.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

/** Groq — OpenAI-compatible API with a free tier and very low latency. */
export function createGroqProvider(env: Env): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "groq",
    label: "Groq",
    baseUrl: env.GROQ_BASE_URL,
    apiKey: env.GROQ_API_KEY,
    backupApiKey: env.GROQ_API_KEY_BACKUP,
    defaultModel: env.GROQ_DEFAULT_MODEL,
    timeoutMs: env.VEYRA_LLM_TIMEOUT_MS,
  });
}
