import { z } from "zod";
import type { Logger } from "../core/logger.js";
import type { ChatMessage } from "../providers/llm/types.js";
import type { ModelRouter } from "../router/model-router.js";

export interface QueryPlan {
  queries: string[];
  method: "llm" | "rules";
}

/**
 * Research step 2: turn one question into a small, fixed number of search
 * queries. Single pass, no recursion — the count is capped by
 * VEYRA_RESEARCH_MAX_QUERIES, and the first query is always the main one.
 */
export async function planSearchQueries(
  question: string,
  opts: {
    maxQueries: number;
    useLlm: boolean;
    modelRouter: ModelRouter;
    history: ChatMessage[];
    logger: Logger;
    signal: AbortSignal;
    /** Research about a GitHub repository: searches target the project by name, not the vague question. */
    repo?: { owner: string; repo: string };
  },
): Promise<QueryPlan> {
  const max = Math.max(1, Math.min(opts.maxQueries, 5));
  const main = cleanQuery(question);
  if (opts.repo) {
    const { owner, repo } = opts.repo;
    // "Research this project deeply https://github.com/x/y" → search for x/y itself.
    const rules = dedupe([`${owner}/${repo} GitHub project`, `${repo} ${owner} news announcements`, `${repo} alternatives comparison review`]).slice(0, max);
    if (max === 1 || !opts.useLlm) return { queries: rules, method: "rules" };
  } else if (max === 1 || !opts.useLlm) return { queries: ruleQueries(main, max), method: "rules" };

  const schema = z.object({ queries: z.array(z.string().min(3).max(200)).min(1).max(max) });
  const context = opts.history
    .slice(-2)
    .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
    .join("\n");
  try {
    const plan = opts.modelRouter.plan("cheap", { kind: "auto" });
    const { value } = await opts.modelRouter.structured(
      plan,
      [
        {
          role: "system",
          content:
            `Write up to ${max} distinct web search queries that together answer the user's research question. ` +
            "Query 1 is the core question made self-contained (resolve pronouns like 'this company' from the conversation). " +
            "Others cover recent developments and differing perspectives or risks. Each query under 15 words, no search operators, no invented facts.",
        },
        {
          role: "user",
          content: `${context ? `Conversation so far:\n${context}\n\n` : ""}${opts.repo ? `The question is about the GitHub repository ${opts.repo.owner}/${opts.repo.repo}; name it in the queries.\n` : ""}Research question: ${question.slice(0, 1500)}`,
        },
      ],
      schema,
      opts.signal,
    );
    const queries = dedupe(value.data.queries.map(cleanQuery)).slice(0, max);
    if (queries.length) return { queries, method: "llm" };
  } catch (err) {
    opts.logger.debug("LLM query planning failed; using rules", { error: (err as Error).message });
  }
  if (opts.repo) {
    const { owner, repo } = opts.repo;
    return { queries: dedupe([`${owner}/${repo} GitHub project`, `${repo} ${owner} news announcements`, `${repo} alternatives comparison review`]).slice(0, max), method: "rules" };
  }
  return { queries: ruleQueries(main, max), method: "rules" };
}

/** Deterministic fallback: the question itself plus recency and critical angles. */
function ruleQueries(main: string, max: number): string[] {
  const core =
    main
      .replace(/^(please\s+)?(do\s+)?(a\s+)?(deep\s+)?(research|investigate|deep dive|analy[sz]e|look)(\s+(into|on|about))?\s+/i, "")
      .replace(/^(this\s+(company|project|topic|token)\s*:?\s*)/i, "")
      .replace(/^(the\s+)?(latest|recent)\s+(developments|news|updates)\s+(around|in|on|of|about|for)\s+/i, "")
      .replace(/[?.!]+$/, "")
      .trim() || main;
  return dedupe([main, `${core} latest developments`, `${core} risks and criticism`]).slice(0, max);
}

function cleanQuery(q: string): string {
  return q.replace(/\s+/g, " ").trim().slice(0, 400);
}

function dedupe(queries: string[]): string[] {
  const seen = new Set<string>();
  return queries.filter((q) => {
    const k = q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
