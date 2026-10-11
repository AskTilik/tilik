import { cacheKey, TtlCache } from "../../cache/ttl-cache.js";
import { VeyraError } from "../../core/errors.js";
import { RateLimiter } from "../../core/guards.js";
import { httpRequest } from "../../core/http.js";

/**
 * GeckoTerminal public API client (https://api.geckoterminal.com/api/v2).
 * Endpoints used were verified live for network "robinhood" on 2026-10-06.
 *
 * - Client-wide sliding-window limiter below the public 30 calls/min.
 * - Per-question call cap, in-flight de-duplication, TTL cache per data class.
 * - Bounded retry on 429/5xx/timeouts; never waits more than ~2 s.
 * - Last good response kept as "stale" for MARKET_STALE_MAX_SECONDS so an outage
 *   can be answered with clearly-labelled last-known data — never as current.
 */

export type TtlClass = "live" | "pools" | "meta";

export interface MarketBudget {
  signal: AbortSignal;
  calls: number;
  maxCalls: number;
}

export interface Fetched<T> {
  body: T;
  /** When this data was fetched from GeckoTerminal. */
  fetchedAt: number;
  /** Served from the stale store because GeckoTerminal failed. */
  stale?: { reason: string };
  url: string;
}

export interface GeckoOptions {
  baseUrl: string;
  timeoutMs: number;
  retries: number;
  ratePerMinute: number;
  ttlSeconds: Record<TtlClass, number>;
  staleMaxSeconds: number;
}

const SOURCE = "tool:geckoterminal";

export class GeckoTerminalClient {
  private readonly cache = new TtlCache<{ body: unknown; fetchedAt: number }>(1000);
  private readonly stale = new TtlCache<{ body: unknown; fetchedAt: number }>(1000);
  private readonly inflight = new Map<string, Promise<{ body: unknown; fetchedAt: number } | null>>();
  private readonly limiter = new RateLimiter();

  constructor(private readonly opts: GeckoOptions) {}

  /** null when GeckoTerminal has no such resource (404). */
  async get<T>(path: string, ttl: TtlClass, budget: MarketBudget): Promise<Fetched<T> | null> {
    const url = `${this.opts.baseUrl}${path}`;
    const key = cacheKey("gt", path);
    const hit = this.cache.get(key);
    if (hit) return { body: hit.body as T, fetchedAt: hit.fetchedAt, url };

    let p = this.inflight.get(key);
    if (!p) {
      p = this.fetchFresh(url, key, ttl, budget).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    try {
      const fresh = await p;
      return fresh ? { body: fresh.body as T, fetchedAt: fresh.fetchedAt, url } : null;
    } catch (err) {
      // Outage / rate limit: fall back to last-known data, explicitly marked stale.
      const old = this.stale.get(key);
      if (err instanceof VeyraError && err.kind !== "aborted" && err.kind !== "budget" && old) {
        return { body: old.body as T, fetchedAt: old.fetchedAt, url, stale: { reason: err.kind } };
      }
      throw err;
    }
  }

  private async fetchFresh(url: string, key: string, ttl: TtlClass, budget: MarketBudget): Promise<{ body: unknown; fetchedAt: number } | null> {
    if (budget.calls >= budget.maxCalls) throw new VeyraError("budget", SOURCE, `Market-data request limit for this question (${budget.maxCalls}) reached`);
    let last: VeyraError | undefined;
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      if (!this.limiter.tryAcquire("geckoterminal", this.opts.ratePerMinute)) {
        throw new VeyraError("rate_limit", SOURCE, `Local GeckoTerminal rate limit (${this.opts.ratePerMinute}/min) reached`);
      }
      budget.calls++;
      try {
        const res = await httpRequest(url, {
          source: SOURCE,
          headers: { Accept: "application/json;version=20230302" },
          timeoutMs: this.opts.timeoutMs,
          signal: budget.signal,
          acceptStatus: [404],
          mapError: (status, _body, headers) => {
            if (status === 429) {
              const ra = Number(headers.get("retry-after"));
              return new VeyraError("rate_limit", SOURCE, "GeckoTerminal is rate-limiting requests (429)", {
                status,
                ...(Number.isFinite(ra) && ra > 0 ? { retryAfterMs: ra * 1000 } : {}),
              });
            }
            return new VeyraError(status >= 500 ? "upstream" : "bad_request", SOURCE, `GeckoTerminal returned ${status}`, { status });
          },
        });
        const fetchedAt = Date.now();
        if (res.status === 404) return null;
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          throw new VeyraError("invalid_output", SOURCE, "Malformed GeckoTerminal response (not JSON)");
        }
        if (!body || typeof body !== "object") throw new VeyraError("invalid_output", SOURCE, "Malformed GeckoTerminal response");
        const entry = { body, fetchedAt };
        this.cache.set(key, entry, this.opts.ttlSeconds[ttl] * 1000);
        if (this.opts.staleMaxSeconds > 0) this.stale.set(key, entry, this.opts.staleMaxSeconds * 1000);
        return entry;
      } catch (err) {
        const e = err instanceof VeyraError ? err : new VeyraError("network", SOURCE, "GeckoTerminal unreachable");
        last = e;
        const retryable = e.kind === "rate_limit" || e.kind === "upstream" || e.kind === "timeout" || e.kind === "network";
        if (!retryable || attempt === this.opts.retries || budget.calls >= budget.maxCalls || budget.signal.aborted) break;
        if (e.retryAfterMs !== undefined && e.retryAfterMs > 2000) break;
        await sleep(e.retryAfterMs ?? 400 * 2 ** attempt, budget.signal);
      }
    }
    throw last ?? new VeyraError("upstream", SOURCE, "GeckoTerminal request failed");
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new VeyraError("aborted", SOURCE, "Aborted"));
      },
      { once: true },
    );
  });
}
