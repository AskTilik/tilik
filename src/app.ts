import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { chatRoutes } from "./api/chat.js";
import { errorResponse } from "./api/errors.js";
import { clientKey, corsPolicy, requestLog, securityHeaders, tooManyRequests, type AppVariables } from "./api/http-guards.js";
import { addressRoutes } from "./api/address.js";
import { pulseRoutes } from "./api/pulse.js";
import { systemRoutes } from "./api/system.js";
import { rateLimitEnabled } from "./config/env.js";
import type { Container } from "./container.js";
import type { ErrorBody } from "./types/api.js";

export function createApp(container: Container): Hono<{ Variables: AppVariables }> {
  const { env, logger, clientLimiter } = container;
  const production = env.NODE_ENV === "production";
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", requestLog(logger));
  app.use("*", securityHeaders(env));
  app.use("*", corsPolicy(env));

  // /chat spends API budget, so it is protected whenever VEYRA_API_KEY is set.
  app.use("/chat", async (c, next) => {
    if (env.VEYRA_API_KEY && !bearerMatches(c.req.header("authorization"), env.VEYRA_API_KEY)) {
      const body: ErrorBody = { error: { kind: "unauthorized", message: "Missing or invalid bearer token" } };
      return c.json(body, 401);
    }
    await next();
  });
  app.use(
    "/chat",
    bodyLimit({
      maxSize: env.VEYRA_MAX_BODY_BYTES,
      onError: (c) => c.json({ error: { kind: "validation", message: "Request is too large." } } satisfies ErrorBody, 413),
    }),
  );
  // Per-client request rate on the API (expensive workflows get a second, smaller allowance in the route).
  if (rateLimitEnabled(env)) {
    app.use("/chat", async (c, next) => {
      if (c.req.method !== "POST") return next();
      const verdict = clientLimiter.take("chat", clientKey(c, env), env.RATE_LIMIT_MAX_REQUESTS);
      if (!verdict.ok) {
        logger.warn("rate limited", { requestId: c.get("requestId"), bucket: "chat" });
        return tooManyRequests(c, verdict.retryAfterMs);
      }
      await next();
    });
  }
  app.use("/chat", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-store");
  });

  app.route("/", systemRoutes(container));
  app.route("/", pulseRoutes(env, logger));
  app.route("/", addressRoutes(env, logger, clientLimiter));
  app.route("/", chatRoutes(container));
  // Landing page (static files in /web). Same path from src/ (dev) and dist/ (build).
  const webRoot = fileURLToPath(new URL("../web", import.meta.url));
  // Deep link to a conversation: same page; the conversation itself lives in the browser's storage.
  app.get("/chat/:id{[A-Za-z0-9_-]{1,64}}", async (c) => {
    c.header("Cache-Control", "no-cache");
    return c.html(await readFile(join(webRoot, "index.html"), "utf8"));
  });
  // Documentation page.
  app.get("/docs", async (c) => {
    c.header("Cache-Control", "no-cache");
    return c.html(await readFile(join(webRoot, "docs.html"), "utf8"));
  });
  // The web app is small and changes with every release: browsers keep a copy but must revalidate it
  // (cheap 304 via Last-Modified), so visitors never get a stale page after an update.
  app.use("/*", async (c, next) => {
    await next();
    if (c.req.method === "GET" && c.res.ok && !c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-cache");
  });
  app.use("/*", serveStatic({ root: webRoot }));

  app.notFound((c) => c.json({ error: { kind: "not_found", message: "Not found" } }, 404));
  app.onError((err, c) => errorResponse(c, err, logger, { production }));
  return app;
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
