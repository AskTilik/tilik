import type { Env } from "../../config/env.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

/** OpenRouter — the main model gateway. Any model id from openrouter.ai/models works. */
export function createOpenRouterProvider(env: Env): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: env.OPENROUTER_BASE_URL,
    apiKey: env.OPENROUTER_API_KEY,
    defaultModel: env.OPENROUTER_DEFAULT_MODEL,
    timeoutMs: env.VEYRA_LLM_TIMEOUT_MS,
    // Optional attribution headers recommended by OpenRouter.
    extraHeaders: {
      "X-Title": env.OPENROUTER_APP_NAME,
      ...(env.OPENROUTER_APP_URL ? { "HTTP-Referer": env.OPENROUTER_APP_URL } : {}),
    },
  });
}
