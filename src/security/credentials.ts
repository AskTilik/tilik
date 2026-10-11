/**
 * Credential detection shared by the output guard (answers), the sanitizer
 * (retrieved content such as repository files) and error handling.
 */

/** Common credential formats (provider keys, cloud keys, tokens). */
export const CREDENTIAL_PATTERNS =
  /\b(sk-or-v1-[a-f0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|gsk_[A-Za-z0-9]{20,}|tvly-[A-Za-z0-9_-]{16,}|fc-[A-Za-z0-9]{20,}|jina_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[abprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|sk_live_[A-Za-z0-9]{20,})\b/g;

/** PEM private key blocks. */
const PRIVATE_KEY_BLOCK = /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?(-----END \1PRIVATE KEY-----|$)/g;

/** `api_key = "…"`, `"password": "…"`, `SECRET_TOKEN='…'` — keeps the name, removes the value. */
const ASSIGNED_SECRET =
  /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|password|passwd|private[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)[A-Za-z0-9_]*["']?\s*[:=]\s*)(["'])([^"'\s]{12,})\2/gi;

export const REDACTED = "[REDACTED]";

/** Removes key-like strings from arbitrary text (used for upstream error messages). */
export function redactCredentialPatterns(text: string): string {
  return text.replace(CREDENTIAL_PATTERNS, REDACTED);
}

/** Stronger pass for retrieved content (e.g. repository files): also private keys and hard-coded secret assignments. */
export function redactSecretsInContent(text: string): { text: string; redacted: boolean } {
  let out = text.replace(PRIVATE_KEY_BLOCK, `-----BEGIN $1PRIVATE KEY----- ${REDACTED} -----END $1PRIVATE KEY-----`);
  out = out.replace(CREDENTIAL_PATTERNS, REDACTED);
  out = out.replace(ASSIGNED_SECRET, (_m, prefix: string, q: string, value: string) =>
    // Leave obvious placeholders alone (e.g. "your-api-key-here", "${API_KEY}", "xxxxxxxxxxxx").
    /^(\$\{|<|your|xxx|changeme|example|placeholder|process\.env)/i.test(value) ? `${prefix}${q}${value}${q}` : `${prefix}${q}${REDACTED}${q}`,
  );
  return { text: out, redacted: out !== text };
}
