import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { VeyraError, publicErrorMessage } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { AllModelsFailedError } from "../router/model-router.js";
import type { ErrorBody } from "../types/api.js";

/**
 * Public error bodies: a kind and a clean message. Never stack traces, keys, environment values, paths
 * or prompts. In production even the sanitized `details` are omitted; full detail stays in server logs.
 */
export function describeError(err: unknown, logger: Logger, opts: { production?: boolean } = {}): { status: ContentfulStatusCode; body: ErrorBody } {
  if (err instanceof AllModelsFailedError) {
    // Distinguish "nothing configured" from "configured but temporarily unusable" — the fixes differ.
    const cooling = err.skipped.filter((s) => /cooling down/.test(s.reason));
    const message = err.attempts.length
      ? "No model could answer right now. All configured providers failed."
      : cooling.length
        ? `All configured LLM providers are temporarily paused after recent failures (${[...new Set(cooling.map((s) => s.provider))].join(", ")}): an invalid API key pauses a provider for 10 minutes, a rate limit until it resets. Check the keys or retry later.`
        : "No LLM provider is available. Set at least one of OPENROUTER_API_KEY, GEMINI_API_KEY or GROQ_API_KEY.";
    logger.warn("all models failed", { attempts: err.attempts.map((a) => ({ provider: a.provider, ok: a.ok, kind: a.error?.kind })), skipped: err.skipped.length });
    if (opts.production) {
      return { status: 503, body: { error: { kind: err.kind, message: "The AI service is temporarily unavailable. Please try again shortly." } } };
    }
    const attempts = err.attempts.map((a) => (a.error ? { ...a, error: { kind: a.error.kind, message: publicErrorMessage(a.error.message) } } : a));
    return { status: 503, body: { error: { kind: err.kind, message, details: { attempts, skipped: err.skipped } } } };
  }
  if (err instanceof VeyraError && err.kind === "aborted") {
    return { status: 499 as ContentfulStatusCode, body: { error: { kind: "aborted", message: "Request cancelled" } } };
  }
  if (err instanceof VeyraError && err.kind === "timeout") {
    logger.warn("request timed out", { source: err.source });
    return { status: 504, body: { error: { kind: "timeout", message: "The request took too long. Please try again." } } };
  }
  // Unknown failures: log details server-side, return a generic message.
  logger.error("unhandled error", { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  return { status: 500, body: { error: { kind: "internal", message: "Internal error" } } };
}

export function errorResponse(c: Context, err: unknown, logger: Logger, opts: { production?: boolean } = {}) {
  const { status, body } = describeError(err, logger, opts);
  return c.json(body, status);
}
