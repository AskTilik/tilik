import { redactCredentialPatterns } from "../security/credentials.js";

export type ErrorKind =
  | "not_configured" // missing API key / endpoint
  | "auth" // key rejected
  | "rate_limit" // 429, temporary
  | "quota" // out of credits / daily quota
  | "budget" // VEYRA's own request cap reached
  | "timeout"
  | "network"
  | "bad_request"
  | "not_found"
  | "upstream" // 5xx or malformed provider response
  | "invalid_output" // response failed validation (empty, bad JSON, schema mismatch)
  | "aborted"; // caller cancelled — never fall back on this

export class VeyraError extends Error {
  readonly kind: ErrorKind;
  /** Which provider/tool raised it, e.g. "groq" or "tool:tavily". */
  readonly source: string;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: ErrorKind,
    source: string,
    message: string,
    opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "VeyraError";
    this.kind = kind;
    this.source = source;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }

  toJSON() {
    return { kind: this.kind, source: this.source, message: this.message, status: this.status };
  }
}

export function toVeyraError(err: unknown, source: string): VeyraError {
  if (err instanceof VeyraError) return err;
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return new VeyraError("timeout", source, "Request timed out", { cause: err });
    if (err.name === "AbortError") return new VeyraError("aborted", source, "Request aborted", { cause: err });
    return new VeyraError("upstream", source, err.message, { cause: err });
  }
  return new VeyraError("upstream", source, String(err));
}

/**
 * Error text that may leave the server (toolRuns, model attempts, dev error details): no credentials,
 * no query strings (keys often live there), no filesystem paths, no network internals, bounded length.
 */
export function publicErrorMessage(message: string): string {
  return redactCredentialPatterns(String(message))
    .replace(/(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, "$1?[…]")
    .replace(/\b[A-Za-z]:\\[^\s"'<>]+|(?<![\w.])\/(?:home|Users|usr|var|opt|etc|tmp|root|app|srv|mnt|proc)\/[^\s"'<>]*/g, "[path]")
    .replace(/\b(getaddrinfo|connect) (E[A-Z]+)\s+\S+/g, "$1 $2")
    .replace(/\s+at\s+\S+\s+\(.*?\)/g, "")
    .slice(0, 300);
}

/** Map an HTTP failure to a VeyraError kind. `body` is a short excerpt of the response. */
export function errorFromStatus(source: string, status: number, body: string, retryAfter: string | null): VeyraError {
  // Upstream error bodies are shown in responses (attempts/toolRuns): never let a key-like string through.
  const excerpt = redactCredentialPatterns(body.slice(0, 300));
  const retryAfterMs = parseRetryAfter(retryAfter);
  const opts = { status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  // Gemini reports a bad key as 400 API_KEY_INVALID.
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid/i.test(body)) return new VeyraError("auth", source, `Authentication failed (${status})`, opts);
  // 432/433: Tavily plan / pay-as-you-go limit exceeded.
  if (status === 402 || status === 432 || status === 433) return new VeyraError("quota", source, `Insufficient credits (${status}): ${excerpt}`, opts);
  if (status === 429) {
    const kind = /quota|exhausted|billing|credits/i.test(body) ? "quota" : "rate_limit";
    return new VeyraError(kind, source, `Rate limited (${status}): ${excerpt}`, opts);
  }
  if (status === 404) return new VeyraError("not_found", source, `Not found (${status}): ${excerpt}`, opts);
  if (status === 408) return new VeyraError("timeout", source, `Upstream timeout (${status})`, opts);
  if (status >= 400 && status < 500) return new VeyraError("bad_request", source, `Bad request (${status}): ${excerpt}`, opts);
  return new VeyraError("upstream", source, `Upstream error (${status}): ${excerpt}`, opts);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
