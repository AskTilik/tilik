import { checkUrl } from "../security/url-guard.js";
import { VeyraError, errorFromStatus } from "./errors.js";

/** Redirects are followed by hand so every hop can be safety-checked (no redirect into localhost/private networks). */
const MAX_REDIRECTS = 5;

export interface HttpOptions {
  /** Identifies the caller in errors and logs, e.g. "gemini" or "tool:exa". */
  source: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Serialized as JSON when present. */
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Non-2xx statuses returned as normal responses (e.g. 304 Not Modified for conditional requests). */
  acceptStatus?: number[];
  /** Provider-specific error mapping (e.g. GitHub signals rate limits with 403). Return undefined to use the default. */
  mapError?: (status: number, body: string, headers: Headers) => VeyraError | undefined;
}

/** fetch() with timeout, cancellation and errors mapped to VeyraError. Returns only OK responses. */
export async function httpRequest(url: string, opts: HttpOptions): Promise<Response> {
  const signals = [AbortSignal.timeout(opts.timeoutMs)];
  if (opts.signal) signals.push(opts.signal);

  let res: Response;
  try {
    let current = url;
    let method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
    let body = opts.body === undefined ? null : JSON.stringify(opts.body);
    const signal = AbortSignal.any(signals);
    for (let hop = 0; ; hop++) {
      res = await fetch(current, {
        method,
        headers: {
          ...(body === null ? {} : { "Content-Type": "application/json" }),
          ...opts.headers,
        },
        body,
        signal,
        redirect: "manual",
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      await res.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new VeyraError("upstream", opts.source, "Too many redirects");
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        throw new VeyraError("upstream", opts.source, "Invalid redirect location");
      }
      const check = checkUrl(next);
      if (!check.ok) throw new VeyraError("bad_request", opts.source, `Redirect blocked: ${check.reason}`);
      // Credentials stay with the host they were meant for.
      if (new URL(next).origin !== new URL(current).origin) {
        for (const h of Object.keys(opts.headers ?? {})) {
          if (/^(authorization|x-api-key|api-key|x-goog-api-key|cookie)$/i.test(h)) throw new VeyraError("bad_request", opts.source, "Cross-origin redirect with credentials refused");
        }
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = null;
      }
      current = next;
    }
  } catch (err) {
    if (err instanceof VeyraError) throw err;
    // A caller's signal may itself be a deadline (e.g. the tool runner's); only a non-timeout abort is a cancellation.
    const callerReason: unknown = opts.signal?.aborted ? opts.signal.reason : undefined;
    const isTimeout = (e: unknown) => e instanceof Error && e.name === "TimeoutError";
    if (opts.signal?.aborted && !isTimeout(callerReason)) {
      throw new VeyraError("aborted", opts.source, "Request aborted", { cause: err });
    }
    if (isTimeout(err) || isTimeout(callerReason)) {
      throw new VeyraError("timeout", opts.source, `Timed out after ${opts.timeoutMs}ms`, { cause: err });
    }
    throw new VeyraError("network", opts.source, `Network error: ${(err as Error).message}`, { cause: err });
  }

  if (!res.ok && !opts.acceptStatus?.includes(res.status)) {
    const text = await res.text().catch(() => "");
    throw opts.mapError?.(res.status, text, res.headers) ?? errorFromStatus(opts.source, res.status, text, res.headers.get("retry-after"));
  }
  return res;
}

export async function httpJson<T>(url: string, opts: HttpOptions): Promise<T> {
  const res = await httpRequest(url, opts);
  try {
    return (await res.json()) as T;
  } catch (err) {
    // The body is read under the same deadline/cancellation as the request: a slow body is a timeout and a
    // cancelled caller is an abort (so fallbacks stop) — not "invalid JSON".
    const name = err instanceof Error ? err.name : "";
    const reason: unknown = opts.signal?.aborted ? opts.signal.reason : undefined;
    const isTimeout = name === "TimeoutError" || (reason instanceof Error && reason.name === "TimeoutError");
    if (isTimeout) throw new VeyraError("timeout", opts.source, `Timed out after ${opts.timeoutMs}ms`, { cause: err });
    if (opts.signal?.aborted || name === "AbortError") throw new VeyraError("aborted", opts.source, "Request aborted", { cause: err });
    throw new VeyraError("upstream", opts.source, "Response was not valid JSON", { cause: err });
  }
}
