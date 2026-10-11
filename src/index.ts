import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { configStatus, loadEnv, productionProblems } from "./config/env.js";
import { createContainer } from "./container.js";

if (existsSync(".env")) process.loadEnvFile(".env");

let env;
try {
  env = loadEnv();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

// Unsafe production configuration stops the server (messages name the setting, never its value).
const problems = productionProblems(env);
if (problems.length) {
  console.error(`Refusing to start in production:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}

const container = createContainer(env);
const { logger, providers, tools } = container;
const app = createApp(container);

// Configuration report: "configured" / "missing" / "default" / "disabled" — never a value.
for (const s of configStatus(env)) logger.info("config", { group: s.group, name: s.name, status: s.status, ...(s.note ? { note: s.note } : {}) });

const configured = providers.list().filter((p) => p.isConfigured()).map((p) => p.id);
if (configured.length === 0) {
  logger.warn("No LLM provider configured — /chat will return 503. Add a key to .env (see .env.example).");
}
if (!env.VEYRA_API_KEY && !["127.0.0.1", "localhost", "::1"].includes(env.HOST)) {
  logger.warn("VEYRA_API_KEY is not set while listening on a non-local interface. Anyone who can reach this server can spend your API budget.");
}

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  logger.info("TILIK core listening", {
    url: `http://${env.HOST}:${info.port}`,
    providers: configured,
    tools: tools.list().filter((t) => t.isConfigured()).map((t) => t.name),
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info("shutting down", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
