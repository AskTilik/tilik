import { topicTerms } from "./files.js";

/** Pieces of repository data VEYRA can fetch. Each maps to one GitHub endpoint (files: raw downloads). */
export const ASPECTS = [
  "metadata",
  "languages",
  "readme",
  "structure",
  "config",
  "files",
  "commits",
  "releases",
  "issues",
  "pulls",
  "contributors",
  "branches",
] as const;
export type Aspect = (typeof ASPECTS)[number];

export interface GitHubQueryPlan {
  aspects: Aspect[];
  /** Files named explicitly ("src/router.ts", a /blob/ URL). */
  paths: string[];
  /** Topic words for finding relevant files by name ("authentication" → auth, login, jwt…). */
  topic: string[];
  /** Directory to focus the structure summary on (from a /tree/ URL). */
  directory?: string;
  mode: "analysis" | "focused";
  issueState: "open" | "closed" | "all";
}

const RULES: [RegExp, Aspect[]][] = [
  [/\b(readme|summar(y|i[sz]e)|what (does|is) (this|the|it)\b.{0,30}\b(do|for|about)|purpose|what is it)\b/i, ["readme"]],
  [/\b(languages?|written in)\b/i, ["languages"]],
  [/\b(tech(nology)? stack|stack|frameworks?|dependencies|depend on|built with|libraries|packages used|toolchain)\b/i, ["languages", "config"]],
  [/\b(active|activity|maintained|alive|abandoned|dead|momentum|health|velocity)\b/i, ["commits", "releases", "pulls", "issues"]],
  [/\b(releases?|versions?|changelog|tags?|latest version)\b/i, ["releases"]],
  [/\b(contribut\w*|maintainers?|authors?|who (wrote|built|made|maintains|works|develops))\b/i, ["contributors"]],
  [/\b(important|key|main|core|entry) (files?|modules?)|\b(structure|layout|folders?|director(y|ies)|tree|organi[sz]ed|organi[sz]ation)\b/i, ["structure", "config"]],
  [/\b(architecture|design|components|how (is|does) (it|this|the (code|project|app)) (work|built|structured|organi[sz]ed))\b/i, ["readme", "structure", "config"]],
  [/\b(changed|changes|latest commits?|commits?|what'?s new|commit history|recent(ly)? (changed|updated|changes|commits|work|development))\b/i, ["commits"]],
  [/\b(issues?|bugs?|problems|tickets?)\b/i, ["issues"]],
  [/\b(pull requests?|prs?|merge requests?|merged)\b/i, ["pulls"]],
  [/\bbranch(es)?\b/i, ["branches"]],
];

const ANALYSIS =
  /\b(analy[sz]e|analysis|overview|review|audit|evaluate|assess|deep dive|research|tell me (about|everything)|explain (this|the) (repo|repository|project|codebase)|what is this (repo|repository|project))\b/i;
const TOPIC_QUESTION = /\b(explain|how (does|do|is|are)|where (is|are|does)|implement\w*|handles?|handling|logic|mechanism|flow|system|module|works?)\b/i;

/** Bare filenames recognized without a "/" (README/LICENSE words are left to the readme/metadata aspects). */
const KNOWN_FILES =
  /^(changelog\.md|contributing\.md|Dockerfile|Makefile|package\.json|tsconfig\.json|pyproject\.toml|requirements\.txt|setup\.py|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|composer\.json|Gemfile|docker-compose\.ya?ml|foundry\.toml|hardhat\.config\.[jt]s)$/;
const PATH_TOKEN = /(?:^|[\s(`'"])(`?)((?:[\w.@-]+\/)*[\w.@-]+(?:\.[A-Za-z][A-Za-z0-9]{0,9})?)\1(?=$|[\s)`'",;:!?]|\.(?:\s|$))/g;

/** Explicit file paths in a question. Paths need a "/" or a known filename (or backticks) to avoid treating "next.js" as a file. */
export function extractPaths(question: string, repo?: { owner: string; repo: string }): string[] {
  const text = question.replace(/https?:\/\/\S+/g, " ").replace(/\S*github\.com\S*/gi, " ");
  const out: string[] = [];
  for (const m of text.matchAll(PATH_TOKEN)) {
    const quoted = m[1] === "`";
    const p = m[2]!.replace(/^\.\//, "");
    const hasExt = /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(p);
    const isKnown = KNOWN_FILES.test(p.split("/").at(-1)!);
    const lower = p.toLowerCase();
    if (repo && (lower === repo.repo.toLowerCase() || lower === `${repo.owner}/${repo.repo}`.toLowerCase())) continue;
    if (/^\d|^v?\d+\.\d+/.test(p)) continue; // versions
    if ((p.includes("/") && (hasExt || quoted)) || isKnown || (quoted && hasExt)) out.push(p);
  }
  return [...new Set(out)];
}

/**
 * Decides which GitHub data a question needs — so "What language is it written
 * in?" costs 2 API calls, not a full repository crawl.
 */
export function planGitHubQuery(
  question: string,
  opts: { research: boolean; owner: string; repoName: string; urlPath?: string; urlKind?: "blob" | "tree" },
): GitHubQueryPlan {
  const aspects = new Set<Aspect>(["metadata"]);
  const paths = extractPaths(question, { owner: opts.owner, repo: opts.repoName });
  if (opts.urlPath && opts.urlKind === "blob" && !paths.includes(opts.urlPath)) paths.unshift(opts.urlPath);
  // A /tree/<ref>/<dir> link: describe that directory.
  const directory = opts.urlKind === "tree" ? opts.urlPath : undefined;
  if (directory) aspects.add("structure");

  const analysis = opts.research || ANALYSIS.test(question);
  if (analysis) for (const a of ["languages", "readme", "structure", "config", "commits", "releases", "issues"] as const) aspects.add(a);
  for (const [re, add] of RULES) if (re.test(question)) add.forEach((a) => aspects.add(a));
  if (paths.length) aspects.add("files");

  // "Explain the authentication system" → find files by name, then read the best few.
  let topic: string[] = [];
  if (!paths.length && TOPIC_QUESTION.test(question)) {
    topic = topicTerms(question).filter((t) => t !== opts.repoName.toLowerCase());
    if (topic.length) {
      aspects.add("structure");
      aspects.add("files");
    }
  }
  // Nothing specific asked: metadata + README answer "what is this?".
  if (aspects.size === 1) aspects.add("readme");

  const issueState = /\bclosed (issues?|bugs?)\b/i.test(question) ? "closed" : /\ball issues\b/i.test(question) ? "all" : "open";
  return {
    aspects: ASPECTS.filter((a) => aspects.has(a)),
    paths,
    topic,
    ...(directory ? { directory } : {}),
    mode: analysis ? "analysis" : "focused",
    issueState,
  };
}
