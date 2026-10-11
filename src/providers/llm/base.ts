import { z } from "zod";
import { VeyraError } from "../../core/errors.js";
import type {
  ChatMessage,
  GenerateRequest,
  GenerateResult,
  LLMProvider,
  StreamEvent,
  StructuredResult,
} from "./types.js";

/**
 * Shared behaviour for providers. Subclasses implement generate() and stream();
 * structuredGenerate() is built on top of generate() so every provider gets
 * schema-validated JSON output with one self-repair attempt.
 */
export abstract class BaseLLMProvider implements LLMProvider {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly defaultModel: string;
  abstract isConfigured(): boolean;
  abstract generate(req: GenerateRequest): Promise<GenerateResult>;
  abstract stream(req: GenerateRequest): AsyncIterable<StreamEvent>;

  async structuredGenerate<T>(req: Omit<GenerateRequest, "json">, schema: z.ZodType<T>): Promise<StructuredResult<T>> {
    const instruction =
      "Respond with ONLY a single JSON value conforming to this JSON Schema. No prose, no markdown fences.\n" +
      JSON.stringify(z.toJSONSchema(schema));
    let messages = withSystemInstruction(req.messages, instruction);

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.generate({ ...req, messages, json: true });
      const parsed = parseJson(result.text);
      const checked = parsed.ok ? schema.safeParse(parsed.value) : undefined;
      if (checked?.success) {
        const { text, ...rest } = result;
        return { ...rest, data: checked.data, raw: text };
      }
      const problem = checked ? z.prettifyError(checked.error) : "Output was not valid JSON.";
      messages = [
        ...messages,
        { role: "assistant", content: result.text },
        { role: "user", content: `That response was invalid:\n${problem}\nReturn corrected JSON only.` },
      ];
    }
    throw new VeyraError("invalid_output", this.id, "Model did not return schema-valid JSON after a repair attempt");
  }
}

function withSystemInstruction(messages: ChatMessage[], instruction: string): ChatMessage[] {
  const [first, ...rest] = messages;
  if (first?.role === "system") return [{ role: "system", content: `${first.content}\n\n${instruction}` }, ...rest];
  return [{ role: "system", content: instruction }, ...messages];
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    const start = trimmed.search(/[[{]/);
    const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      try {
        return { ok: true, value: JSON.parse(trimmed.slice(start, end + 1)) };
      } catch {
        /* fall through */
      }
    }
    return { ok: false };
  }
}

/** Recursively merges plain objects; arrays and scalars from `extra` win. */
export function deepMerge<T extends Record<string, unknown>>(base: T, extra?: Record<string, unknown>): T {
  if (!extra) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
