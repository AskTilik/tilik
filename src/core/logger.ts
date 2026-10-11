import { REDACTED, redactCredentialPatterns } from "../security/credentials.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** Bearer tokens, `apikey=…`-style query parameters and Authorization-like fields. */
const TOKEN_PATTERNS = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}|([?&](?:api[_-]?key|key|token|access_token|auth)=)[^&\s"']{6,}|("(?:authorization|x-api-key|api[_-]?key|apikey|token|password|secret)"\s*:\s*")[^"]{4,}"/gi;

/**
 * Removes credentials from a finished log line: exact secret values from the environment, common key formats,
 * bearer tokens and key-bearing query parameters. Defence in depth — callers must still never log secrets.
 */
export function redactLogLine(line: string, secrets: readonly string[] = []): string {
  let out = line;
  for (const s of secrets) if (s && out.includes(s)) out = out.split(s).join(REDACTED);
  out = redactCredentialPatterns(out);
  return out.replace(TOKEN_PATTERNS, (_m, bearer?: string, query?: string, field?: string) =>
    bearer ? `${bearer}${REDACTED}` : query ? `${query}${REDACTED}` : `${field}${REDACTED}"`,
  );
}

/** One JSON line per event, scrubbed of secrets. Callers must never pass secrets in `data`. */
export function createLogger(level: LogLevel = "info", opts: { secrets?: readonly string[]; write?: (lvl: LogLevel, line: string) => void } = {}): Logger {
  const secrets = (opts.secrets ?? []).filter((s) => s.length >= 8);
  const write = opts.write ?? ((lvl, line) => (lvl === "error" || lvl === "warn" ? console.error : console.log)(line));
  const log = (lvl: LogLevel) => (msg: string, data?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    let line: string;
    try {
      line = JSON.stringify({ t: new Date().toISOString(), lvl, msg, ...data });
    } catch {
      line = JSON.stringify({ t: new Date().toISOString(), lvl, msg, note: "unserializable log data dropped" });
    }
    write(lvl, redactLogLine(line, secrets));
  };
  return { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** A logger that adds fixed fields (e.g. requestId) to every line. */
export function withFields(logger: Logger, fields: Record<string, unknown>): Logger {
  const wrap = (fn: Logger["info"]) => (msg: string, data?: Record<string, unknown>) => fn(msg, { ...fields, ...data });
  return { debug: wrap(logger.debug), info: wrap(logger.info), warn: wrap(logger.warn), error: wrap(logger.error) };
}
