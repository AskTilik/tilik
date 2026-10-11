import { randomUUID } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { corsOrigins, type Env } from "../config/env.js";
import type { Logger } from "../core/logger.js";
import type { ErrorBody } from "../types/api.js";

export type AppVariables = { requestId: string };

/**
 * Content-Security-Policy for the bundled web app: own scripts only (no inline script, no eval),
 * Google Fonts for typography, same-origin API calls, no framing, no plugins.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Security headers on every response. HSTS only in production (it is meaningless — and sticky — on plain-HTTP localhost). */
export function securityHeaders(env: Env): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    h.set("X-Content-Type-Options", "nosniff");
    h.set("X-Frame-Options", "DENY");
    // Cross-origin links (sources) get the origin only, never a /chat/<conversationId> path.
    h.set("Referrer-Policy", "strict-origin-when-cross-origin");
    h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
    h.set("Cross-Origin-Opener-Policy", "same-origin");
    h.set("Cross-Origin-Resource-Policy", "same-origin");
    if (env.NODE_ENV === "production") h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    h.delete("X-Powered-By");
  };
}

/**
 * CORS: explicit allow-list from VEYRA_CORS_ORIGIN / CORS_ORIGIN. Without one, development allows localhost
 * origins and production allows none (the bundled app is same-origin and needs no CORS). "*" is refused in
 * production at startup (see productionProblems).
 */
export function corsPolicy(env: Env): MiddlewareHandler {
  const allowed = corsOrigins(env);
  const devLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
  return cors({
    origin: (origin) => {
      if (!origin) return null;
      if (allowed.includes("*")) return "*";
      if (allowed.includes(origin.replace(/\/$/, ""))) return origin;
      if (!allowed.length && env.NODE_ENV !== "production" && devLocal.test(origin)) return origin;
      return null;
    },
    allowMethods: ["GET", "POST"],
    allowHeaders: ["Content-Type", "Authorization", "Accept"],
    exposeHeaders: ["X-Request-Id", "Retry-After"],
    maxAge: 600,
  });
}

/** Request id (returned as X-Request-Id) + one structured access-log line per request. No headers, bodies or IPs are logged. */
export function requestLog(logger: Logger): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const requestId = randomUUID();
    c.set("requestId", requestId);
    const started = Date.now();
    let failed = false;
    try {
      await next();
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      c.res.headers.set("X-Request-Id", requestId);
      const status = failed ? 500 : c.res.status;
      // Static assets are noise; the API and app pages are what matter.
      if (!/\.(js|css|svg|png|ico|map|woff2?|d\.ts)$/.test(c.req.path)) {
        logger.info("http.request", { requestId, method: c.req.method, endpoint: routeName(c.req.path), status, ms: Date.now() - started, ok: status < 400 });
      }
    }
  };
}

/** Logged endpoint names never include conversation ids or other path data. */
function routeName(path: string): string {
  if (/^\/chat\/[^/]+$/.test(path)) return "/chat/:id";
  return path.length > 64 ? `${path.slice(0, 64)}…` : path;
}

/** Rate-limit key: the client IP (from X-Forwarded-For only when TRUST_PROXY is set). Never logged. */
export function clientKey(c: Context, env: Env): string {
  if (env.TRUST_PROXY) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // not running on a Node socket (e.g. in-process tests)
  }
}

export function tooManyRequests(c: Context, retryAfterMs: number) {
  c.header("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
  const body: ErrorBody = { error: { kind: "rate_limit", message: "Too many requests. Please try again shortly." } };
  return c.json(body, 429);
}
