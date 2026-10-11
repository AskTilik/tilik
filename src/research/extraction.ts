import { normalizeUrl } from "../sources/collector.js";
import type { ToolOutput } from "../tools/runner.js";

/**
 * Research step "source extraction": choose which pages are worth reading in full.
 *  1. Pages a structured tool pointed to (e.g. a repository's homepage/docs) come first.
 *  2. Then search results that came back as snippets only, highest relevance first.
 * Pages already retrieved as text (e.g. Exa in research mode) and github.com
 * pages (the GitHub tool covers those) are not fetched again. At most `limit`
 * snippet pages, plus up to `limit` related pages.
 */
export function selectPagesToExtract(outputs: ToolOutput[], limit: number): string[] {
  if (limit <= 0) return [];
  const haveText = new Set<string>();
  const related: string[] = [];
  const candidates = new Map<string, { url: string; relevance: number }>();
  const hasGitHubTool = outputs.some((o) => o.capability === "github.repo");

  for (const o of outputs) {
    for (const u of o.related ?? []) if (!related.includes(u)) related.push(u);
    for (const s of o.sources) {
      if (!s.url) continue;
      const key = normalizeUrl(s.url);
      if (!key) continue;
      if (s.evidence === "retrieved_content" || s.evidence === "live_data") {
        haveText.add(key);
        continue;
      }
      if (o.capability !== "web.search" && o.capability !== "news.feed") continue;
      if (hasGitHubTool && /^https?:\/\/github\.com\//i.test(key)) continue;
      const prev = candidates.get(key);
      const relevance = s.relevance ?? 0.5;
      if (!prev || relevance > prev.relevance) candidates.set(key, { url: s.url, relevance });
    }
  }
  const relatedUrls = related.filter((u) => {
    const k = normalizeUrl(u);
    return k !== undefined && !haveText.has(k);
  });
  const relatedKeys = new Set(relatedUrls.map((u) => normalizeUrl(u)));
  const snippetUrls = [...candidates.entries()]
    .filter(([key]) => !haveText.has(key) && !relatedKeys.has(key))
    .sort(([, a], [, b]) => b.relevance - a.relevance)
    .slice(0, limit)
    .map(([, c]) => c.url);
  return [...relatedUrls.slice(0, limit), ...snippetUrls];
}
