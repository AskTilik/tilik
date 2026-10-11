import type { Env } from "../config/env.js";
import { createRobinhoodChainTool } from "../providers/blockchain/tool.js";
import { createGitHubTool } from "../providers/github/tool.js";
import { createGeckoTerminalTool } from "../providers/market/tool.js";
import { createRssTool } from "../providers/news/tool.js";
import { createExaTool } from "../providers/search/exa.js";
import { createTavilyTool } from "../providers/search/tavily.js";
import { createFirecrawlTool } from "../providers/web/firecrawl.js";
import { createJinaTool } from "../providers/web/jina.js";
import type { AnyTool, Capability } from "./types.js";

const COST_ORDER = { free: 0, low: 1, paid: 2 } as const;

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(tool: AnyTool): this {
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  /** All tools offering a capability, cheapest first. */
  forCapability(capability: Capability): AnyTool[] {
    return this.list()
      .filter((t) => t.capabilities.includes(capability))
      .sort((a, b) => COST_ORDER[a.costTier] - COST_ORDER[b.costTier] || (a.priority ?? 100) - (b.priority ?? 100));
  }
}

export type ToolFactory = (env: Env) => AnyTool;

/**
 * Tools are added here phase by phase. Done: Tavily, Exa (Phase 4), Jina,
 * Firecrawl (Phase 5), GitHub (Phase 6), RSS (Phase 7), Robinhood Chain (Phase 8), GeckoTerminal (Phase 9).
 * Until a capability has a tool, the router reports it as unavailable and the
 * model is told not to invent that data.
 */
const TOOL_FACTORIES: ToolFactory[] = [
  createTavilyTool,
  createExaTool,
  createJinaTool,
  createFirecrawlTool,
  createGitHubTool,
  (env) => createRssTool(env),
  (env) => createRobinhoodChainTool(env),
  (env) => createGeckoTerminalTool(env),
];

export function createToolRegistry(env: Env, factories: ToolFactory[] = TOOL_FACTORIES): ToolRegistry {
  const registry = new ToolRegistry();
  for (const factory of factories) registry.register(factory(env));
  return registry;
}
