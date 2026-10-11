export type SourceType = "web" | "documentation" | "github" | "news" | "onchain" | "market" | "research";

/**
 * How the information was obtained. Lets the UI and the model distinguish a
 * search-engine snippet from fetched page content from live API data. AI
 * analysis is never a Source — it is the answer itself.
 */
export type Evidence = "search_result" | "retrieved_content" | "live_data";

/** What a tool returns. URLs must come from the upstream API, never be constructed by guesswork. */
export interface SourceInput {
  title: string;
  url?: string;
  type: SourceType;
  evidence: Evidence;
  /** Publication / block / data timestamp (ISO-8601) when known. */
  publishedAt?: string;
  /** Short excerpt shown to users (search snippet / highlight). */
  snippet?: string;
  /** Longer text given to the model when available; falls back to snippet. */
  content?: string;
  /** 0..1, higher is more relevant. */
  relevance?: number;
  /** "code" = source file: sanitized without prose/markdown rewriting, whitespace preserved. */
  format?: "text" | "code";
}

export interface Source extends SourceInput {
  /** Citation number used as [n] in answers. */
  id: number;
  domain?: string;
  /** Tool that produced it. */
  provider: string;
  /** Other tools that returned the same source (merged during de-duplication). */
  alsoFoundBy?: string[];
  /** Security findings, e.g. "ignore_instructions" (redacted prompt injection) or "punycode_domain". */
  securityFlags?: string[];
  /** How authoritative this source is: direct data > official > reputable > general. */
  authority?: "direct" | "official" | "reputable" | "general";
  /** Which kind of data it is: onchain, market, github, web. */
  family?: "onchain" | "market" | "github" | "web";
  retrievedAt: string;
}
