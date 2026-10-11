/**
 * Everything retrieved from the web (titles, snippets, page text) is UNTRUSTED
 * DATA. This module cleans it before it reaches the model:
 *  - strips invisible/bidi control characters used to hide instructions,
 *  - strips HTML comments, script/style blocks and leftover tags,
 *  - removes markdown images (tracking/exfiltration beacons) and link targets,
 *  - redacts instruction-like sentences ("ignore previous instructions…",
 *    "reveal your API keys…", role spoofing) and flags the source.
 * The prompt additionally fences sources with unforgeable delimiters, so even
 * text that slips through is presented to the model as data.
 */

import { redactSecretsInContent } from "./credentials.js";

export const REDACTION_NOTE = "[TILIK removed instruction-like text from this source]";

const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

const INJECTION_PATTERNS: [flag: string, re: RegExp][] = [
  [
    "ignore_instructions",
    /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|system|the)\b[^.\n]{0,30}\b(instructions?|prompts?|rules|directions|guidelines|guardrails)\b/i,
  ],
  [
    "secret_request",
    /\b(reveal|print|show|output|display|repeat|leak|send|expose|share|tell me|give me|list)\b[^\n]{0,60}?(\b(api[ _-]?keys?|secrets?|passwords?|credentials?|access tokens?|env(ironment)?( variables?)?|system prompt|hidden (instructions|prompt)|initial (instructions|prompt))\b|\.env\b)/i,
  ],
  ["role_override", /\b(you are now|from now on,? (you|act)|act as (an?|the) |pretend (to be|you are)|new instructions?:|system override|developer mode|jailbreak|do anything now)\b/i],
  [
    "role_spoof",
    /^\s*(system|assistant|developer)\s*:\s*(you|ignore|from now|new|override|the user|always|never|do not)\b|<\|im_(start|end)\|>|\[\/?INST\]|<\/?(system|instructions?)>|#{2,}\s*(system|instructions?)\s*(prompt|override|:)/i,
  ],
  ["delimiter_spoof", /<<<\s*(END\s+)?SOURCE\b|END OF CONTEXT SOURCES|CONTEXT SOURCES:/i],
];

export interface Sanitized {
  text: string;
  /** Distinct injection pattern names that were found and redacted. */
  flags: string[];
}

/**
 * `mode: "code"` (repository files) keeps the text verbatim apart from the
 * security passes: no HTML/markdown stripping (it would mangle `List<T>` or
 * `a[i](x)`) and no whitespace collapsing (indentation matters).
 */
export function sanitizeUntrusted(input: string, opts: { mode?: "text" | "code" } = {}): Sanitized {
  const code = opts.mode === "code";
  const flags = new Set<string>();
  // Forged source delimiters are caught before tag stripping (which would otherwise mangle them unflagged).
  let text = input.replace(INVISIBLE, "").replace(/<{2,}\s*(END\s+)?SOURCE\b[^\n>]*>{2,}/gi, () => {
    flags.add("delimiter_spoof");
    return REDACTION_NOTE;
  });
  // Secrets that appear in retrieved content (e.g. a key committed to a repo) never reach the model.
  const secrets = redactSecretsInContent(text);
  if (secrets.redacted) flags.add("secret_redacted");
  text = secrets.text;
  if (!code) {
    text = text
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|iframe|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<\/?[a-z][^>]{0,500}>/gi, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // markdown images (possible exfiltration beacons)
      .replace(/\[([^\]]{0,300})\]\((?:[^()\s]|\([^)]*\))+\)/g, "$1") // keep link text, drop target
      .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "");
  }

  text = text
    .split("\n")
    .map((line) => {
      const redact = (segment: string) => {
        const hit = INJECTION_PATTERNS.find(([, re]) => re.test(segment));
        if (!hit) return segment;
        flags.add(hit[0]);
        // Keep indentation in code so the surrounding structure stays readable.
        return code ? `${/^\s*/.exec(segment)?.[0] ?? ""}${REDACTION_NOTE}` : REDACTION_NOTE;
      };
      // Code is checked line by line so whitespace is preserved exactly; prose sentence by sentence.
      return code ? redact(line) : line.split(/(?<=[.!?])\s+/).map(redact).join(" ");
    })
    .join("\n")
    .replace(new RegExp(`(${escape(REDACTION_NOTE)}\\s*){2,}`, "g"), `${REDACTION_NOTE} `);
  text = code ? text.replace(/\n{4,}/g, "\n\n\n").replace(/\s+$/, "") : text.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  return { text, flags: [...flags] };
}

/** Titles become a single short line; an instruction-like title is replaced entirely. */
export function sanitizeTitle(input: string, fallback: string): Sanitized {
  const { text, flags } = sanitizeUntrusted(input.replace(/\s+/g, " "));
  if (flags.length) return { text: `${fallback} (title removed)`, flags };
  const line = text.replace(/\s+/g, " ").trim().slice(0, 300);
  return { text: line || fallback, flags };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
