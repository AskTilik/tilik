import { Hono } from "hono";
import { TIERS } from "../config/routing.js";
import type { Container } from "../container.js";

/**
 * Read-only public status. Booleans only: whether each provider/tool is configured — never keys, key
 * prefixes, environment variable names, models, budgets, usage or any other internal configuration.
 */
export function systemRoutes({ providers, tools, routing }: Container): Hono {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      providers: Object.fromEntries(providers.list().map((p) => [p.id, p.isConfigured()])),
      tools: Object.fromEntries(tools.list().map((t) => [t.name, t.isConfigured()])),
    }),
  );

  /** Options a UI can offer in its model picker (configured providers only; no routing internals). */
  app.get("/models", (c) => {
    const configured = providers.list().filter((p) => p.isConfigured());
    return c.json({
      choices: [
        { value: "auto", label: "Auto" },
        ...configured.map((p) => ({ value: p.id, label: p.label })),
        ...TIERS.flatMap((tier) =>
          routing.tiers[tier]
            .filter((m) => configured.some((p) => p.id === m.provider))
            .map((m) => ({ value: `${m.provider}:${m.model}`, label: `${m.model} (${m.provider})`, tier })),
        ),
      ],
    });
  });

  return app;
}
