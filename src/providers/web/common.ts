import { z } from "zod";
import { VeyraError } from "../../core/errors.js";
import type { SourceInput } from "../../sources/types.js";
import type { ToolPlanningContext } from "../../tools/types.js";
import { normalizeDate, safeHost, sourceTypeFor } from "../search/common.js";

/** Shared input for every page-extraction tool (Jina, Firecrawl, …). */
export const ExtractInputSchema = z.object({
  url: z.url().max(2048),
  maxChars: z.number().int().min(500).max(200_000),
});
export type ExtractInput = z.infer<typeof ExtractInputSchema>;

/** VEYRA's provider-independent extracted page. */
export const ExtractedPageSchema = z.object({
  provider: z.string(),
  requestedUrl: z.string(),
  /** Final URL after redirects, when the provider reports it. */
  url: z.string(),
  domain: z.string(),
  title: z.string(),
  description: z.string().optional(),
  publishedAt: z.string().optional(),
  /** Main content as markdown, capped at maxChars. */
  content: z.string(),
  originalChars: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type ExtractedPage = z.infer<typeof ExtractedPageSchema>;

/** Pages with less readable text than this count as a failed extraction (so the fallback gets a turn). */
const MIN_CONTENT_CHARS = 80;

export function planExtraction(ctx: ToolPlanningContext, maxChars: number): ExtractInput | null {
  return ctx.url ? { url: ctx.url, maxChars } : null;
}

/** Normalizes a provider response into an ExtractedPage + one retrieved_content source. */
export function finalizePage(
  provider: string,
  input: ExtractInput,
  raw: { url?: string | undefined; title?: string | undefined; description?: string | undefined; publishedAt?: string | undefined; content: string },
): { data: ExtractedPage; sources: SourceInput[] } {
  const content = raw.content.replace(/\r\n/g, "\n").trim();
  if (content.length < MIN_CONTENT_CHARS) {
    throw new VeyraError("invalid_output", `tool:${provider}`, `No readable content extracted from ${input.url}`);
  }
  // Prefer the provider's final URL only if it is a valid http(s) URL; otherwise keep the one we asked for.
  const finalUrl = raw.url && /^https?:\/\//i.test(raw.url) && safeHost(raw.url) ? raw.url : input.url;
  const { text, truncated } = truncateAtBoundary(content, input.maxChars);
  const publishedAt = normalizeDate(raw.publishedAt);
  const domain = safeHost(finalUrl);
  const title = raw.title?.trim() || domain;

  const page: ExtractedPage = {
    provider,
    requestedUrl: input.url,
    url: finalUrl,
    domain,
    title,
    ...(raw.description?.trim() ? { description: raw.description.trim() } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    content: text,
    originalChars: content.length,
    truncated,
  };
  return {
    data: page,
    sources: [
      {
        title,
        url: finalUrl,
        type: sourceTypeFor(finalUrl, "general"),
        evidence: "retrieved_content",
        snippet: page.description ?? text.slice(0, 300),
        content: truncated ? `${text}\n\n[… page truncated: ${input.maxChars} of ${content.length} characters]` : text,
        ...(publishedAt ? { publishedAt } : {}),
        // A page the user (or research step) explicitly asked for is highly relevant.
        relevance: 0.95,
      },
    ],
  };
}

/** Cuts long pages at a paragraph (or sentence) boundary near the limit, keeping the beginning — where articles put their substance. */
export function truncateAtBoundary(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const slice = text.slice(0, max);
  const para = slice.lastIndexOf("\n\n");
  const sentence = slice.search(/[.!?]\s[^.!?]*$/);
  const cut = para > max * 0.7 ? para : sentence > max * 0.7 ? sentence + 1 : max;
  return { text: slice.slice(0, cut).trimEnd(), truncated: true };
}

/** Firecrawl metadata values may be strings or arrays of strings. */
export function firstString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}
