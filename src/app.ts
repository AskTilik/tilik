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
import { addressRoutes, createAddressLookup } from "./api/address.js";
import { createTokenIntel, tokenRoutes } from "./api/token.js";
import { createPortfolio, portfolioRoutes } from "./api/portfolio.js";
import { createRecap, recapRoutes } from "./api/recap.js";
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
  const lookup = createAddressLookup(env, logger);
  const intel = createTokenIntel(env, logger, lookup);
  app.route("/", addressRoutes(env, logger, clientLimiter, lookup));
  app.route("/", tokenRoutes(env, clientLimiter, intel));
  const portfolio = createPortfolio(env, logger);
  app.route("/", portfolioRoutes(env, clientLimiter, portfolio));
  app.route("/", recapRoutes(env, clientLimiter, createRecap(env, logger, portfolio.prices)));
  app.route("/", chatRoutes(container));
  // Landing page (static files in /web). Same path from src/ (dev) and dist/ (build).
  const webRoot = fileURLToPath(new URL("../web", import.meta.url));
  // Deep link to a conversation: same page; the conversation itself lives in the browser's storage.
  app.get("/chat/:id{[A-Za-z0-9_-]{1,64}}", async (c) => {
    c.header("Cache-Control", "no-cache");
    return c.html(await readFile(join(webRoot, "index.html"), "utf8"));
  });
  // Shareable lookup pages: /address/0x…, /token/0x…, /tx/0x… — the landing page with its own title and
  // preview text (link previews on X/Telegram show what was shared); the page runs the lookup itself.
  const page = async (title: string, description: string, path: string) => {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    return (await readFile(join(webRoot, "index.html"), "utf8"))
      .replace(/<title>[^<]*<\/title>/, () => `<title>${esc(title)}</title>`)
      .replace(/(<meta name="description" content=")[^"]*/, (_, a: string) => a + esc(description))
      .replace(/(<meta property="og:title" content=")[^"]*/, (_, a: string) => a + esc(title))
      .replace(/(<meta property="og:description" content=")[^"]*/, (_, a: string) => a + esc(description))
      .replace(/(<meta property="og:url" content=")[^"]*/, (_, a: string) => a + "https://asktilik.com" + path);
  };
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const quick = <T,>(p: Promise<T>) => Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), 2500))]).catch(() => undefined);
  app.get("/compare/:a{0x[0-9a-fA-F]{40}}/:b{0x[0-9a-fA-F]{40}}", async (c) => {
    c.header("Cache-Control", "no-cache");
    const [a, b] = [c.req.param("a"), c.req.param("b")];
    const [pa, pb] = env.ONCHAIN_ENABLED ? await Promise.all([quick(lookup.get(a)), quick(lookup.get(b))]) : [undefined, undefined];
    const n = (p: typeof pa, x: string) => (p?.token?.symbol ? "$" + p.token.symbol : short(x));
    return c.html(await page(`${n(pa, a)} vs ${n(pb, b)} on Robinhood Chain · TILIK`, "Two tokens side by side: liquidity, holders, safety signals and market data, read live from Robinhood Chain.", c.req.path));
  });
  app.get("/portfolio/:addr{0x[0-9a-fA-F]{40}}", async (c) => {
    c.header("Cache-Control", "no-cache");
    const addr = c.req.param("addr");
    return c.html(await page(`Portfolio ${short(addr)} on Robinhood Chain · TILIK`, "Everything this wallet holds and what it's worth in USD, read live from Robinhood Chain.", c.req.path));
  });
  app.get("/:kind{address|token}/:addr{0x[0-9a-fA-F]{40}}", async (c) => {
    c.header("Cache-Control", "no-cache");
    const addr = c.req.param("addr");
    const p = env.ONCHAIN_ENABLED ? await quick(lookup.get(addr)) : undefined;
    const name = p?.token?.symbol ? "$" + p.token.symbol : p?.kind === "wallet" ? `Wallet ${short(addr)}` : short(addr);
    const facts = p?.token
      ? [p.token.holders !== undefined ? `${p.token.holders.toLocaleString("en-US")} holders` : "", p.token.totalSupply ? `supply ${p.token.totalSupply}` : ""].filter(Boolean).join(" · ")
      : p?.balance ? `balance ${p.balance.value} ${p.balance.symbol}` : "";
    return c.html(await page(`${name} on Robinhood Chain · TILIK`, `${facts ? facts + ". " : ""}Pools, holders, safety signals and live activity, read straight from Robinhood Chain.`, c.req.path));
  });
  app.get("/tx/:hash{0x[0-9a-fA-F]{64}}", async (c) => {
    c.header("Cache-Control", "no-cache");
    const hash = c.req.param("hash");
    return c.html(await page(`Transaction ${short(hash)} on Robinhood Chain · TILIK`, "Status, value, fee, parties and every token that moved, read straight from Robinhood Chain.", c.req.path));
  });
  // Coming-soon page: a preview of the next update.
  app.get("/soon", async (c) => {
    c.header("Cache-Control", "no-cache");
    return c.html(await readFile(join(webRoot, "soon.html"), "utf8"));
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
