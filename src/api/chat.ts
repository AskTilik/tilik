import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { rateLimitEnabled } from "../config/env.js";
import type { Container } from "../container.js";
import { VeyraError } from "../core/errors.js";
import type { EngineEvent } from "../core/events.js";
import { classifyIntent } from "../router/intent.js";
import { ChatRequestSchema, type ChatRequest, type ErrorBody, type VeyraResponse } from "../types/api.js";
import { clientKey, tooManyRequests, type AppVariables } from "./http-guards.js";
import { describeError } from "./errors.js";

/** Intents that fan out into several paid/slow sources. */
const LIVE = new Set(["web_search", "web_extract", "research", "news", "github", "onchain", "market"]);

/** Research mode, research wording, or three or more kinds of live sources: the expensive workflows. */
export function isHeavyRequest(req: Pick<ChatRequest, "message" | "mode">): boolean {
  if (req.mode === "research") return true;
  const intents = classifyIntent(req.message).intents;
  return intents.includes("research") || intents.filter((i) => LIVE.has(i)).length >= 3;
}

export function chatRoutes(
  { env, engine, logger, clientLimiter }: Container,
  /** Called with every finished answer (e.g. to keep it shareable). Never fails the request. */
  onAnswer?: (question: string, response: VeyraResponse) => Promise<void>,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  const production = env.NODE_ENV === "production";
  const limited = rateLimitEnabled(env);

  app.post("/chat", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = ChatRequestSchema.safeParse(body);
    if (!parsed.success) {
      // Field paths and reasons only — never echo the submitted values.
      const details = parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message }));
      const error: ErrorBody = { error: { kind: "validation", message: "Invalid request body", details } };
      return c.json(error, 400);
    }
    const req = parsed.data;

    // Size limits (configurable, checked before any provider or tool is touched).
    if (req.message.length > env.VEYRA_MAX_MESSAGE_CHARS) {
      return c.json({ error: { kind: "validation", message: `Message is too long (max ${env.VEYRA_MAX_MESSAGE_CHARS} characters).` } } satisfies ErrorBody, 400);
    }
    const historyChars = req.history.reduce((n, m) => n + m.content.length, 0);
    if (historyChars > env.VEYRA_MAX_HISTORY_CHARS) {
      return c.json({ error: { kind: "validation", message: "Conversation context is too large. Start a new chat or shorten it." } } satisfies ErrorBody, 413);
    }

    // Expensive workflows have their own, smaller allowance.
    if (limited && isHeavyRequest(req)) {
      const verdict = clientLimiter.take("heavy", clientKey(c, env), env.RATE_LIMIT_HEAVY_MAX_REQUESTS);
      if (!verdict.ok) {
        logger.warn("rate limited", { requestId: c.get("requestId"), bucket: "heavy" });
        return tooManyRequests(c, verdict.retryAfterMs);
      }
    }

    // One deadline for the whole request; a client that disconnects aborts the work (tools and model).
    const deadline = AbortSignal.timeout(env.VEYRA_REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([c.req.raw.signal, deadline]);
    const toPublic = (err: unknown) => describeError(deadline.aborted ? new VeyraError("timeout", "request", "Request deadline reached") : err, logger, { production });
    const runOpts = { requestId: c.get("requestId") };

    if (!req.stream) {
      try {
        const res = await engine.ask(req, signal, runOpts);
        await onAnswer?.(req.message, res).catch(() => {});
        return c.json(res);
      } catch (err) {
        const { status, body: errBody } = toPublic(err);
        return c.json(errBody, status);
      }
    }

    // v2: request.started → intent.detected → plan.created → status / tool.started / tool.completed
    //     → source.discovered → model.selected → response.delta* → response.completed (or error)
    // v1 (legacy): plan → sources → model → delta* → done (or error)
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => logger.info("stream.client_disconnected", { requestId: c.get("requestId") }));
      let completed = false;
      try {
        for await (const event of engine.askStream(req, signal, runOpts)) {
          if (c.req.raw.signal.aborted) break; // client gone: stop (the shared signal already aborted the work)
          if (event.type === "response.completed") {
            completed = true;
            await onAnswer?.(req.message, event.response).catch(() => {});
          }
          for (const out of req.streamFormat === "v1" ? toV1(event) : toV2(event)) {
            await stream.writeSSE({ event: out.event, data: JSON.stringify(out.data) });
          }
        }
        // Deadline reached but the pipeline wound down quietly: the client still gets a clean, final error event.
        if (!completed && deadline.aborted && !c.req.raw.signal.aborted) {
          await stream.writeSSE({ event: "error", data: JSON.stringify(toPublic(new Error("deadline")).body) });
        }
      } catch (err) {
        if (c.req.raw.signal.aborted) return; // nobody is listening any more
        const { body: errBody } = toPublic(err);
        await stream.writeSSE({ event: "error", data: JSON.stringify(errBody) });
      }
    });
  });

  return app;
}

type Out = { event: string; data: unknown }[];

function toV2(e: EngineEvent): Out {
  // context.ready is internal; v2 clients get one source.discovered per source instead.
  return e.type === "context.ready" ? [] : [{ event: e.type, data: e }];
}

function toV1(e: EngineEvent): Out {
  switch (e.type) {
    case "plan.created":
      return [{ event: "plan", data: { type: "plan", plan: e.plan } }];
    case "context.ready":
      return [{ event: "sources", data: { type: "sources", sources: e.sources, toolRuns: e.toolRuns, data: e.data, retrieval: e.retrieval } }];
    case "model.selected":
      return [{ event: "model", data: { type: "model", provider: e.provider, model: e.model } }];
    case "response.delta":
      return [{ event: "delta", data: { type: "delta", text: e.text } }];
    case "response.completed":
      return [{ event: "done", data: { type: "done", response: e.response } }];
    default:
      return [];
  }
}
