/**
 * Process-local cost and health guards. In-memory is intentional for the MVP;
 * swap for Redis/KV when running more than one instance.
 */

/** Caps requests per key per UTC day. A limit of 0 means unlimited. */
export class DailyBudget {
  private day = currentDay();
  private readonly used = new Map<string, number>();

  constructor(private readonly limits: Record<string, number> = {}) {}

  /** `limit` overrides the configured limit for this key (used by tools that declare their own). */
  tryConsume(key: string, limit = this.limits[key] ?? 0): boolean {
    this.rollover();
    if (limit > 0 && this.limits[key] === undefined) this.limits[key] = limit;
    const used = this.used.get(key) ?? 0;
    if (limit > 0 && used >= limit) return false;
    this.used.set(key, used + 1);
    return true;
  }

  snapshot(): Record<string, { used: number; limit: number }> {
    this.rollover();
    const keys = new Set([...Object.keys(this.limits), ...this.used.keys()]);
    return Object.fromEntries([...keys].map((k) => [k, { used: this.used.get(k) ?? 0, limit: this.limits[k] ?? 0 }]));
  }

  private rollover() {
    const today = currentDay();
    if (today !== this.day) {
      this.day = today;
      this.used.clear();
    }
  }
}

/** Remembers which providers/tools are temporarily unhealthy (rate-limited, out of quota, bad key). */
export class Cooldowns {
  private readonly until = new Map<string, number>();

  mark(key: string, ms: number): void {
    this.until.set(key, Date.now() + ms);
  }

  isCooling(key: string): boolean {
    const t = this.until.get(key);
    if (t === undefined) return false;
    if (Date.now() >= t) {
      this.until.delete(key);
      return false;
    }
    return true;
  }
}

/** Sliding one-minute window rate limiter, used per tool. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  tryAcquire(key: string, perMinute: number): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMinute) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

function currentDay(): string {
  return new Date().toISOString().slice(0, 10);
}
