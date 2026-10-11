import { randomBytes } from "node:crypto";
import type { Env } from "../config/env.js";
import { normalizeUrl } from "../sources/collector.js";
import { CREDENTIAL_PATTERNS, REDACTED } from "./credentials.js";

export { REDACTED, redactCredentialPatterns } from "./credentials.js";

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|RPC_URL)$/;

/**
 * Last line of defence on everything the model writes:
 *  - our own secrets (any configured *_KEY / *_TOKEN / … value) are redacted,
 *  - common credential formats are redacted,
 *  - a per-process canary planted in the system prompt is redacted and reported,
 *    which reveals attempts to make the model dump its instructions,
 *  - links that are not real sources (or user-supplied URLs) are removed.
 */
export class OutputGuard {
  readonly canary = `VEYRA-CANARY-${randomBytes(8).toString("hex")}`;
  private readonly secrets: string[];

  constructor(env: Env) {
    this.secrets = Object.entries(env)
      .filter(([k, v]) => SECRET_ENV.test(k) && typeof v === "string" && v.length >= 8)
      .map(([, v]) => v as string)
      .sort((a, b) => b.length - a.length);
  }

  redact(text: string): { text: string; findings: ("secret" | "credential_pattern" | "system_prompt")[] } {
    const findings = new Set<"secret" | "credential_pattern" | "system_prompt">();
    let out = text;
    if (out.includes(this.canary)) {
      findings.add("system_prompt");
      out = out.split(this.canary).join(REDACTED);
    }
    for (const s of this.secrets) {
      if (out.includes(s)) {
        findings.add("secret");
        out = out.split(s).join(REDACTED);
      }
    }
    const patterned = out.replace(CREDENTIAL_PATTERNS, REDACTED);
    if (patterned !== out) findings.add("credential_pattern");
    return { text: patterned, findings: [...findings] };
  }

  /** Streaming redactor: holds back a tail so a secret split across chunks is still caught. */
  streamRedactor(): { push(chunk: string): string; flush(): string } {
    const hold = Math.max(256, ...this.secrets.map((s) => s.length + 8));
    let buffer = "";
    return {
      push: (chunk: string) => {
        buffer = this.redact(buffer + chunk).text;
        if (buffer.length <= hold) return "";
        const out = buffer.slice(0, buffer.length - hold);
        buffer = buffer.slice(buffer.length - hold);
        return out;
      },
      flush: () => {
        const out = this.redact(buffer).text;
        buffer = "";
        return out;
      },
    };
  }

  /** Removes URLs that aren't sources or user-supplied. Markdown links keep their text. */
  removeUnverifiedUrls(answer: string, allowed: string[]): { text: string; removed: string[] } {
    const allow = new Set(allowed.map((u) => normalizeUrl(u)).filter(Boolean));
    const removed: string[] = [];
    const ok = (u: string) => {
      const n = normalizeUrl(u.replace(/[.,;:!?]+$/, ""));
      return n !== undefined && allow.has(n);
    };
    let text = answer.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label: string, url: string) => {
      if (ok(url)) return m;
      removed.push(url);
      return label;
    });
    text = text.replace(/(?<!\]\()https?:\/\/[^\s<>()\]"'`]+/g, (url) => {
      if (ok(url)) return url;
      removed.push(url);
      return "[unverified link removed]";
    });
    return { text, removed };
  }
}
