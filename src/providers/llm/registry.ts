import type { Env } from "../../config/env.js";
import { DevMockProvider } from "./dev-mock.js";
import { createGeminiProvider } from "./gemini.js";
import { createGroqProvider } from "./groq.js";
import { createOpenRouterProvider } from "./openrouter.js";
import type { LLMProvider } from "./types.js";

export class ProviderRegistry {
  private readonly providers = new Map<string, LLMProvider>();

  register(provider: LLMProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  list(): LLMProvider[] {
    return [...this.providers.values()];
  }
}

/** Add a provider here (one line) to make it available to routing. */
export function createProviderRegistry(env: Env): ProviderRegistry {
  const registry = new ProviderRegistry()
    .register(createOpenRouterProvider(env))
    .register(createGeminiProvider(env))
    .register(createGroqProvider(env));
  if (env.VEYRA_DEV_MOCK_LLM) registry.register(new DevMockProvider());
  return registry;
}
