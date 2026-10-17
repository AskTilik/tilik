import { VeyraError } from "../../core/errors.js";
import { httpRequest } from "../../core/http.js";

/**
 * Minimal Upstash Redis REST client: one command per call, or a pipeline.
 * https://upstash.com/docs/redis/features/restapi
 */
export type Cmd = (string | number)[];

export interface Kv {
  cmd<T = unknown>(...args: Cmd): Promise<T>;
  pipeline(cmds: Cmd[]): Promise<unknown[]>;
}

export class UpstashKv implements Kv {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly timeoutMs = 5_000,
  ) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await httpRequest(`${this.url.replace(/\/+$/, "")}${path}`, {
      source: "kv",
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
      body,
      timeoutMs: this.timeoutMs,
      mapError: (status) => new VeyraError(status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limit" : "upstream", "kv", `Upstash returned ${status}`, { status }),
    });
    return res.json();
  }

  async cmd<T = unknown>(...args: Cmd): Promise<T> {
    const out = (await this.post("", args)) as { result?: T; error?: string };
    if (out.error) throw new VeyraError("upstream", "kv", "Upstash command failed");
    return out.result as T;
  }

  async pipeline(cmds: Cmd[]): Promise<unknown[]> {
    if (!cmds.length) return [];
    const out = (await this.post("/pipeline", cmds)) as { result?: unknown; error?: string }[];
    return out.map((r) => (r.error ? undefined : r.result));
  }
}

/** In-memory stand-in with the same semantics for the handful of commands TILIK uses (tests, local runs without Upstash). */
export class MemoryKv implements Kv {
  private readonly strings = new Map<string, { v: string; exp?: number }>();
  private readonly zsets = new Map<string, { score: number; member: string }[]>();
  private readonly sets = new Map<string, Set<string>>();
  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string) {
    const s = this.strings.get(key);
    if (s && s.exp !== undefined && s.exp <= this.now()) this.strings.delete(key);
    return this.strings.get(key);
  }

  async cmd<T = unknown>(...args: Cmd): Promise<T> {
    const [op, key, ...rest] = args.map(String) as [string, string, ...string[]];
    switch (op.toUpperCase()) {
      case "GET":
        return (this.live(key)?.v ?? null) as T;
      case "SET": {
        const nx = rest.includes("NX"), exIdx = rest.findIndex((x) => x.toUpperCase() === "EX");
        if (nx && this.live(key)) return null as T;
        this.strings.set(key, { v: rest[0]!, ...(exIdx >= 0 ? { exp: this.now() + Number(rest[exIdx + 1]) * 1000 } : {}) });
        return "OK" as T;
      }
      case "DEL":
        return (this.strings.delete(key) || this.zsets.delete(key) || this.sets.delete(key) ? 1 : 0) as T;
      case "ZADD": {
        const z = this.zsets.get(key) ?? [];
        for (let i = 0; i < rest.length; i += 2) {
          const member = rest[i + 1]!;
          if (!z.some((x) => x.member === member)) z.push({ score: Number(rest[i]), member });
        }
        z.sort((a, b) => a.score - b.score);
        this.zsets.set(key, z);
        return z.length as T;
      }
      case "ZRANGE":
        return (this.zsets.get(key) ?? []).map((x) => x.member) as T;
      case "ZCARD":
        return (this.zsets.get(key)?.length ?? 0) as T;
      case "ZREMRANGEBYRANK": {
        const z = this.zsets.get(key) ?? [];
        const stop = Number(rest[1]);
        this.zsets.set(key, z.slice(stop < 0 ? z.length + stop + 1 : stop + 1));
        return 0 as T;
      }
      case "SADD": {
        const s = this.sets.get(key) ?? new Set<string>();
        for (const m of rest) s.add(m);
        this.sets.set(key, s);
        return s.size as T;
      }
      case "SMEMBERS":
        return [...(this.sets.get(key) ?? [])] as T;
      case "SREM": {
        const s = this.sets.get(key);
        let n = 0;
        for (const m of rest) if (s?.delete(m)) n++;
        return n as T;
      }
      case "SISMEMBER":
        return (this.sets.get(key)?.has(rest[0]!) ? 1 : 0) as T;
      case "SCARD":
        return (this.sets.get(key)?.size ?? 0) as T;
      case "EXPIRE":
        return 1 as T;
      default:
        throw new Error(`MemoryKv: ${op} not supported`);
    }
  }

  async pipeline(cmds: Cmd[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const c of cmds) out.push(await this.cmd(...c));
    return out;
  }
}
