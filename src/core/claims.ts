/**
 * FACT vs INFERENCE vs UNKNOWN, for the response contract.
 *  - fact: a statement backed by a citation to a retrieved source
 *  - inference: a conclusion drawn from the data (an Analysis section, or hedged language)
 *  - unknown: data that could not be retrieved — stated, never guessed
 *  - uncited: a statement with none of the above (flagged so the UI can de-emphasize it)
 */

export interface Knowledge {
  facts: { count: number; statements: { text: string; sourceIds: number[] }[] };
  inferences: { count: number; examples: string[] };
  unknowns: string[];
  uncited: number;
}

const CITATION = /\[\d{1,3}(?:\s*,\s*\d{1,3})*\]/;
const ANALYSIS_HEADING = /^\s*(#{1,6}\s*|\*\*)?\s*(analysis|ai analysis|interpretation|assessment|opinion|outlook|takeaways?|conclusion|implications?)\b/i;
const OTHER_HEADING = /^\s*(#{1,6}\s+\S|\*\*[^*]+\*\*\s*$)/;
const HEDGE = /\b(likely|unlikely|suggests?|may|might|could|appears?|seems?|probably|possibly|indicates?|implies|in my (view|assessment)|i (think|believe))\b/i;
const UNKNOWN = /\b(unavailable|could not be (retrieved|fetched|found)|not (available|reported|retrieved)|no data|unknown|cannot (confirm|verify|determine))\b/i;

export function analyzeClaims(
  answer: string,
  statements: { text: string; sourceIds: number[] }[],
  unavailable: { capability: string; reason: string; soft?: boolean }[],
): Knowledge {
  let inAnalysis = false;
  let inferences = 0;
  let uncited = 0;
  const examples: string[] = [];
  const unknowns = new Set<string>(unavailable.filter((u) => !u.soft).map((u) => `${u.capability}: ${u.reason}`));

  for (const line of answer.split("\n")) {
    if (ANALYSIS_HEADING.test(line)) {
      inAnalysis = true;
      continue;
    }
    if (OTHER_HEADING.test(line)) {
      inAnalysis = false;
      continue;
    }
    for (const raw of line.split(/(?<=[.!?])\s+/)) {
      const s = raw.replace(/^[-*>\d.\s]+/, "").trim();
      if (s.length < 12) continue;
      if (CITATION.test(s)) continue; // counted via citation statements
      if (UNKNOWN.test(s)) unknowns.add(s.slice(0, 200));
      else if (inAnalysis || HEDGE.test(s)) {
        inferences++;
        if (examples.length < 5) examples.push(s.slice(0, 200));
      } else uncited++;
    }
  }
  return {
    facts: { count: statements.length, statements },
    inferences: { count: inferences, examples },
    unknowns: [...unknowns].slice(0, 20),
    uncited,
  };
}
