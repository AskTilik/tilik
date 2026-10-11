import { secretValues, type Env } from "./config/env.js";
import { loadRouting, type RoutingConfig } from "./config/routing.js";
import { VeyraEngine } from "./core/engine.js";
import { createLogger, type Logger } from "./core/logger.js";
import { ClientRateLimiter } from "./security/rate-limit.js";
import { createProviderRegistry, type ProviderRegistry } from "./providers/llm/registry.js";
import { ModelRouter } from "./router/model-router.js";
import { OutputGuard } from "./security/output-guard.js";
import { createToolRegistry, type ToolRegistry } from "./tools/registry.js";
import { ToolRunner } from "./tools/runner.js";

export interface Container {
  env: Env;
  logger: Logger;
  routing: RoutingConfig;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  modelRouter: ModelRouter;
  toolRunner: ToolRunner;
  engine: VeyraEngine;
  /** Per-client request limits for /chat (in memory: one process). */
  clientLimiter: ClientRateLimiter;
}

/** Composition root: the only place concrete providers and tools are wired together. */
export function createContainer(env: Env, overrides: Partial<Pick<Container, "logger" | "providers" | "tools">> = {}): Container {
  const logger = overrides.logger ?? createLogger(env.VEYRA_LOG_LEVEL, { secrets: secretValues(env) });
  const routing = loadRouting(env.VEYRA_ROUTING_FILE);
  const providers = overrides.providers ?? createProviderRegistry(env);
  const tools = overrides.tools ?? createToolRegistry(env);
  const modelRouter = new ModelRouter({ env, routing, providers, logger });
  const toolRunner = new ToolRunner({ logger, defaultTimeoutMs: env.VEYRA_TOOL_TIMEOUT_MS });
  const engine = new VeyraEngine({ env, modelRouter, tools, toolRunner, outputGuard: new OutputGuard(env), logger });
  const clientLimiter = new ClientRateLimiter({ windowMs: env.RATE_LIMIT_WINDOW_MS });
  return { env, logger, routing, providers, tools, modelRouter, toolRunner, engine, clientLimiter };
}
