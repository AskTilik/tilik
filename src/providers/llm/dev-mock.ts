import { BaseLLMProvider } from "./base.js";
import type { GenerateRequest, GenerateResult, StreamEvent } from "./types.js";

export const DEV_MOCK_PREFIX = "[DEV MOCK — not a real model response]";

/**
 * DEVELOPMENT MOCK. Registered only when VEYRA_DEV_MOCK_LLM=true. Lets the
 * pipeline be exercised without API keys. It never claims facts: it only
 * echoes what the engine sent it, and every response carries DEV_MOCK_PREFIX.
 */
export class DevMockProvider extends BaseLLMProvider {
  readonly id = "dev-mock";
  readonly label = "Development mock (not a real model)";
  readonly defaultModel = "dev-mock-echo";

  isConfigured(): boolean {
    return true;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return { text: this.render(req), provider: this.id, model: req.model, finishReason: "stop" };
  }

  async *stream(req: GenerateRequest): AsyncGenerator<StreamEvent> {
    for (const word of this.render(req).split(/(?<= )/)) yield { type: "delta", text: word };
    yield { type: "done", finishReason: "stop" };
  }

  private render(req: GenerateRequest): string {
    if (req.json) return "{}";
    const last = req.messages.at(-1)?.content ?? "";
    const titles = [...last.matchAll(/^<<<SOURCE (\d+) [0-9a-f]+>>>\nTitle: (.+)$/gm)].map((m) => `- Received source: ${m[2]} [${m[1]}]`);
    return [
      DEV_MOCK_PREFIX,
      `The engine sent ${req.messages.length} message(s) with ${titles.length} context source(s). Configure a real provider key to get answers.`,
      ...titles,
    ].join("\n");
  }
}
