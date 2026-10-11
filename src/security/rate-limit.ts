/**
 * Per-client sliding-window limits for the public API (e.g. 20 /chat requests per minute, 5 of them
 * expensive). In memory, single process: behind several instances use a shared store at the proxy/edge.
 * Clients are keyed by IP; the raw IP is never logged or returned.
 */
export class ClientRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private readonly opts: { windowMs: number; now?: () => number; maxKeys?: number }) {}

  private get now() {
    return (this.opts.now ?? Date.now)();
  }

  /** Records a hit if allowed. Returns the wait (ms) until the next request would be allowed when blocked. */
  take(bucket: string, client: string, max: number): { ok: true } | { ok: false; retryAfterMs: number } {
    if (max <= 0) return { ok: true }; // 0 = unlimited for this bucket
    const now = this.now;
    const windowMs = this.opts.windowMs;
    this.sweep(now);
    const key = `${bucket}\u0000${client}`;
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: Math.max(1000, windowMs - (now - recent[0]!)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { ok: true };
  }

  /** Bounded memory: drop idle clients regularly, and the oldest ones if there are too many. */
  private sweep(now: number) {
    if (now - this.lastSweep < this.opts.windowMs && this.hits.size < (this.opts.maxKeys ?? 50_000)) return;
    this.lastSweep = now;
    for (const [key, times] of this.hits) if (!times.length || now - times[times.length - 1]! >= this.opts.windowMs) this.hits.delete(key);
    const max = this.opts.maxKeys ?? 50_000;
    if (this.hits.size > max) for (const key of [...this.hits.keys()].slice(0, this.hits.size - max)) this.hits.delete(key);
  }
}
