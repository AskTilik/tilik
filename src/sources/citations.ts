import type { Source } from "./types.js";

export interface CitationReport {
  /** Answer with references to non-existent sources removed. */
  answer: string;
  /** Source ids the answer actually cites, in first-use order. */
  used: number[];
  /** Ids the model cited that don't exist (removed from the answer). */
  invalid: number[];
  /** Each cited statement and the sources supporting it. */
  statements: { text: string; sourceIds: number[] }[];
}

const CITATION_RE = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g;

/**
 * Other ways models write the same citation, e.g. gpt-oss: 【1】, 【1†source】, 【1, 2】; full-width ［1］;
 * [1†L3-L7]. Only the numbers are kept — they are verified against the source list like any [n].
 */
const ALT_CITATION_RE = /(?:【|［|\[)\s*(\d{1,3}(?:\s*[,，、]\s*\d{1,3})*)\s*(?:†[^】］\]\n]{0,40})?\s*(?:】|］|\])/g;

/** Rewrites alternative citation forms to [n] / [n, m]. Text without numbers in such brackets is untouched. */
export function normalizeCitations(answer: string): string {
  return answer.replace(ALT_CITATION_RE, (match, list: string, offset: number, all: string) => {
    // A plain [n] (or a markdown link "[1](…)") is already canonical — leave it exactly as written.
    if (match.startsWith("[") && !match.includes("†") && !/[，、]/.test(match)) return match;
    if (all[offset + match.length] === "(") return match;
    return `[${list.split(/\s*[,，、]\s*/).map((n) => Number(n.trim())).join(", ")}]`;
  });
}

/**
 * Verifies [n] / [n, m] citations against the real source list. Citations to
 * sources that don't exist are stripped — the model cannot invent a source.
 */
export function checkCitations(answer: string, sources: Pick<Source, "id">[]): CitationReport {
  const valid = new Set(sources.map((s) => s.id));
  const used: number[] = [];
  const invalid = new Set<number>();

  const cleaned = normalizeCitations(answer).replace(CITATION_RE, (_match, list: string) => {
    const ids = list.split(",").map((n) => Number(n.trim()));
    const ok = ids.filter((id) => valid.has(id));
    for (const id of ids) if (!valid.has(id)) invalid.add(id);
    for (const id of ok) if (!used.includes(id)) used.push(id);
    return ok.length ? `[${ok.join(", ")}]` : "";
  });

  const statements: CitationReport["statements"] = [];
  for (const sentence of cleaned.split(/(?<=[.!?])\s+|\n+/)) {
    const ids = [...sentence.matchAll(CITATION_RE)].flatMap((m) => m[1]!.split(",").map((n) => Number(n.trim())));
    if (ids.length === 0) continue;
    const text = sentence.replace(CITATION_RE, "").replace(/\s+([.,;:!?])/g, "$1").replace(/^[-*>#\s]+/, "").trim();
    if (text) statements.push({ text, sourceIds: [...new Set(ids)] });
  }

  // Only tidy spacing when something was actually removed, so normal answers are untouched.
  const finalAnswer = invalid.size ? cleaned.replace(/[ \t]+([.,;:!?])/g, "$1") : cleaned;
  return { answer: finalAnswer, used, invalid: [...invalid], statements };
}
