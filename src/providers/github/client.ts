import type { Env } from "../../config/env.js";
import { cacheKey, TtlCache } from "../../cache/ttl-cache.js";
import { VeyraError } from "../../core/errors.js";
import { httpRequest } from "../../core/http.js";

/** Per-question bookkeeping: API call cap, cache lifetime, notices for the user. */
export interface GitHubSession {
  signal: AbortSignal;
  apiCalls: number;
  maxApiCalls: number;
  /** Set once the repository is known to be private: content is cached only briefly. */
  isPrivate: boolean;
  notices: Set<string>;
}

export interface RateState {
  authenticated: boolean;
  limit?: number;
  remaining?: number;
  /** Epoch ms when the quota resets. */
  resetAt?: number;
}

const SOURCE = "tool:github";

/**
 * Thin GitHub REST client:
 * - token from GITHUB_TOKEN when set; if GitHub rejects it (401) and unauthenticated
 *   access is allowed, retries once without it (public repos keep working);
 * - tracks x-ratelimit-* headers and refuses calls it knows will be rejected;
 * - maps GitHub's 403/429 rate-limit responses to `rate_limit` (with reset time),
 *   404 to `not_found` (which also covers private repos you can't access);
 * - caches responses per endpoint (short TTL for private repositories);
 * - file contents come from raw.githubusercontent.com with a Range header, so a
 *   huge file is never downloaded in full and API quota isn't spent on it.
 */
export class GitHubClient {
  private tokenRejected = false;
  readonly rate: RateState;

  constructor(
    private readonly env: Env,
    private readonly cache = new TtlCache<unknown>(300),
  ) {
    this.rate = { authenticated: Boolean(env.GITHUB_TOKEN) };
  }

  private get token(): string | undefined {
    return this.tokenRejected ? undefined : this.env.GITHUB_TOKEN;
  }

  async api<T>(path: string, session: GitHubSession, opts: { accept?: string } = {}): Promise<T> {
    const key = cacheKey("gh-api", Boolean(this.token), path, opts.accept);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit as T;

    if (session.apiCalls >= session.maxApiCalls) {
      throw new VeyraError("budget", SOURCE, `GitHub request cap per question (${session.maxApiCalls}) reached`);
    }
    if (this.rate.remaining === 0 && this.rate.resetAt && this.rate.resetAt > Date.now()) {
      throw new VeyraError("rate_limit", SOURCE, `GitHub API rate limit exhausted until ${new Date(this.rate.resetAt).toISOString()}`, {
        retryAfterMs: this.rate.resetAt - Date.now(),
      });
    }
    session.apiCalls++;

    let res: Response;
    try {
      res = await this.request(`${this.env.GITHUB_API_URL}${path}`, session, {
        Accept: opts.accept ?? "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      });
    } catch (err) {
      // A bad/expired token: drop it and retry once anonymously if that's allowed.
      if (err instanceof VeyraError && err.status === 401 && this.token && this.env.GITHUB_ALLOW_UNAUTHENTICATED) {
        this.tokenRejected = true;
        this.rate.authenticated = false;
        session.notices.add("GITHUB_TOKEN was rejected by GitHub (401); continuing without it (public repositories only, 60 requests/hour).");
        return this.api<T>(path, session, opts);
      }
      throw err;
    }

    const body = opts.accept?.includes("raw") ? await res.text() : await res.json().catch(() => {
      throw new VeyraError("upstream", SOURCE, "GitHub returned invalid JSON");
    });
    // The repository response itself tells us it is private — before it gets cached.
    if (body && typeof body === "object" && (body as { private?: unknown }).private === true) session.isPrivate = true;
    this.cache.set(key, body, this.ttlMs(session));
    return body as T;
  }

  /** Reads up to maxBytes of a file. Does not count against the API quota. */
  async raw(
    repo: { owner: string; repo: string },
    ref: string,
    path: string,
    maxBytes: number,
    session: GitHubSession,
  ): Promise<{ text: string; truncated: boolean }> {
    const key = cacheKey("gh-raw", Boolean(this.token), repo.owner, repo.repo, ref, path, maxBytes);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit as { text: string; truncated: boolean };

    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const url = `${this.env.GITHUB_RAW_URL}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/${encodeURIComponent(ref)}/${encoded}`;
    const res = await this.request(url, session, { Range: `bytes=0-${maxBytes - 1}` });
    const buf = new Uint8Array(await res.arrayBuffer());
    const total = Number(/\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1] ?? buf.length);
    const slice = buf.length > maxBytes ? buf.slice(0, maxBytes) : buf;
    if (slice.includes(0)) throw new VeyraError("invalid_output", SOURCE, `${path} looks like a binary file`);
    const result = { text: new TextDecoder().decode(slice), truncated: total > slice.length || buf.length > maxBytes };
    this.cache.set(key, result, this.ttlMs(session));
    return result;
  }

  private ttlMs(session: GitHubSession): number {
    return (session.isPrivate ? this.env.GITHUB_PRIVATE_CACHE_TTL_SECONDS : this.env.GITHUB_CACHE_TTL_SECONDS) * 1000;
  }

  private request(url: string, session: GitHubSession, headers: Record<string, string>): Promise<Response> {
    return httpRequest(url, {
      source: SOURCE,
      headers: {
        "User-Agent": "TILIK-intelligence-engine",
        ...headers,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      timeoutMs: this.env.VEYRA_TOOL_TIMEOUT_MS,
      signal: session.signal,
      mapError: (status, body, h) => {
        this.track(h);
        return mapGitHubError(status, body, h);
      },
    }).then((res) => {
      this.track(res.headers);
      return res;
    });
  }

  private track(h: Headers): void {
    const remaining = h.get("x-ratelimit-remaining");
    if (remaining === null) return;
    const resetAt = Number(h.get("x-ratelimit-reset") ?? 0) * 1000 || undefined;
    // Parallel responses arrive out of order: within one quota window keep the lowest count seen.
    const sameWindow = resetAt !== undefined && this.rate.resetAt !== undefined && resetAt <= this.rate.resetAt;
    const value = Number(remaining);
    this.rate.remaining = sameWindow && this.rate.remaining !== undefined ? Math.min(this.rate.remaining, value) : value;
    const limit = h.get("x-ratelimit-limit");
    if (limit) this.rate.limit = Number(limit);
    if (resetAt && (!sameWindow || this.rate.resetAt === undefined)) this.rate.resetAt = resetAt;
  }
}

export function mapGitHubError(status: number, body: string, h: Headers): VeyraError | undefined {
  const message = (() => {
    try {
      return String((JSON.parse(body) as { message?: string }).message ?? "").slice(0, 200);
    } catch {
      return body.slice(0, 200);
    }
  })();
  const rateLimited = (status === 403 || status === 429) && (h.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message));
  if (rateLimited) {
    const retryAfter = Number(h.get("retry-after"));
    const reset = Number(h.get("x-ratelimit-reset")) * 1000;
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : reset > Date.now() ? reset - Date.now() : 60_000;
    return new VeyraError("rate_limit", SOURCE, `GitHub rate limit reached: ${message || status}`, { status, retryAfterMs });
  }
  if (status === 401) return new VeyraError("auth", SOURCE, "GitHub rejected the token (401). Check GITHUB_TOKEN.", { status });
  if (status === 403) return new VeyraError("auth", SOURCE, `GitHub denied access (403): ${message}`, { status });
  if (status === 404) {
    return new VeyraError("not_found", SOURCE, "Not found on GitHub (it may not exist, or be private and not accessible with the configured token).", {
      status,
    });
  }
  if (status === 451) return new VeyraError("bad_request", SOURCE, "Repository unavailable for legal reasons (451).", { status });
  return undefined;
}
