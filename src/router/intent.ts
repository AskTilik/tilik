export const INTENTS = [
  "general",
  "coding",
  "summarize",
  "web_search",
  "web_extract",
  "research",
  "news",
  "github",
  "onchain",
  "market",
] as const;
export type Intent = (typeof INTENTS)[number];

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  /** Branch/tag/commit from a /blob/ or /tree/ URL. */
  ref?: string;
  /** File or directory path from a /blob/ or /tree/ URL. */
  path?: string;
  /** "blob" = path is a file, "tree" = path is a directory. */
  kind?: "blob" | "tree";
}

export interface Entities {
  urls: string[];
  githubRepos: GitHubRepoRef[];
  /** 20-byte EVM addresses (0x + 40 hex). */
  addresses: string[];
  /** 32-byte hashes (0x + 64 hex) — transaction or block hashes. */
  txHashes: string[];
  /** $TICKER mentions. */
  tickers: string[];
}

export interface IntentResult {
  intents: Intent[];
  primary: Intent;
  entities: Entities;
  /** 0..1 — low values may trigger LLM-assisted classification in hybrid mode. */
  confidence: number;
  method: "rules" | "llm";
  /** Human-readable reasons, useful for debugging routing decisions. */
  signals: string[];
  /**
   * Follow-ups only: the earlier question this one continues ("Can you go deeper?", "What is its liquidity?").
   * Tools plan with it so a bare follow-up still searches/queries the right topic.
   */
  contextQuery?: string;
}

/** Most specific first: decides the response type when several intents match. */
const PRIMARY_ORDER: Intent[] = [
  "onchain",
  "github",
  "market",
  "research",
  "news",
  "web_extract",
  "web_search",
  "summarize",
  "coding",
  "general",
];

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const GITHUB_URL_RE = /(?:https?:\/\/)?(?:www\.)?github\.com\/([^\s/?#"'<>`]+)(?:\/([^\s/?#"'<>`]+))?((?:\/[^\s?#"'<>`]*)?)/gi;
/** "repo vercel/next.js", "github: owner/repo" */
const SHORTHAND_BEFORE = /\b(?:github|repo|repository)\s*:?\s+([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})(?![\w/-])/gi;
/** "the vercel/next.js repo", "owner/repo on GitHub" */
const SHORTHAND_AFTER = /(?<![\w./-])([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\s+(?:repo|repository|project|codebase|on github)\b/gi;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;
/** First path segments on github.com that are not user/org names. */
const GITHUB_RESERVED = new Set(
  "about apps codespaces collections contact customer-stories dashboard enterprise events explore features home issues join login logout marketplace new notifications organizations orgs pricing pulls readme resources search security settings signup site solutions sponsors stars team topics trending users watching".split(
    " ",
  ),
);
const TX_RE = /\b0x[a-fA-F0-9]{64}\b/g;
const ADDRESS_RE = /\b0x[a-fA-F0-9]{40}\b/g;
const TICKER_RE = /(?:^|\s)\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;

/** Parses github.com URLs and explicit owner/repo mentions. Malformed or reserved paths are ignored. */
export function extractGitHubRepos(text: string): GitHubRepoRef[] {
  const found: GitHubRepoRef[] = [];
  const add = (owner: string, rawRepo: string, rest = "") => {
    const repo = rawRepo.replace(/[.,;:!?)\]]+$/, "").replace(/\.git$/, "");
    if (!GITHUB_OWNER.test(owner) || GITHUB_RESERVED.has(owner.toLowerCase())) return;
    if (!GITHUB_REPO.test(repo) || repo === "." || repo === "..") return;
    const [kind, ref, ...path] = rest.replace(/[.,;:!?)\]]+$/, "").split("/").filter(Boolean);
    const location =
      (kind === "blob" || kind === "tree") && ref ? { ref, ...(path.length ? { path: path.join("/"), kind: kind as "blob" | "tree" } : {}) } : {};
    found.push({ owner, repo, ...location });
  };
  for (const m of text.matchAll(GITHUB_URL_RE)) if (m[2]) add(m[1]!, m[2], m[3]);
  const withoutUrls = text.replace(URL_RE, " ").replace(/\S*github\.com\S*/gi, " ");
  for (const m of withoutUrls.matchAll(SHORTHAND_BEFORE)) add(m[1]!, m[2]!);
  for (const m of withoutUrls.matchAll(SHORTHAND_AFTER)) add(m[1]!, m[2]!);
  return uniqueBy(found, (r) => `${r.owner}/${r.repo}`.toLowerCase());
}

export function extractEntities(text: string): Entities {
  const urls = unique([...text.matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, "")));
  const githubRepos = extractGitHubRepos(text);
  const txHashes = unique([...text.matchAll(TX_RE)].map((m) => m[0].toLowerCase()));
  const addresses = unique([...text.matchAll(ADDRESS_RE)].map((m) => m[0].toLowerCase()));
  const tickers = unique([...text.matchAll(TICKER_RE)].map((m) => m[1]!.toUpperCase()));
  return { urls, githubRepos, addresses, txHashes, tickers };
}

interface Rule {
  intent: Intent;
  weight: number;
  label: string;
  test: (text: string, e: Entities) => boolean;
}

const kw = (re: RegExp) => (text: string) => re.test(text);

const RULES: Rule[] = [
  { intent: "github", weight: 3, label: "github url", test: (_, e) => e.githubRepos.length > 0 },
  {
    intent: "github",
    weight: 2,
    label: "github keywords",
    test: kw(/\b(github|repo|repository|pull requests?|commits?|codebase|readme|contributors|open issues)\b/i),
  },

  { intent: "onchain", weight: 3, label: "address/tx hash", test: (_, e) => e.addresses.length + e.txHashes.length > 0 },
  { intent: "onchain", weight: 3, label: "robinhood chain", test: kw(/\brobinhood\s+chain\b/i) },
  {
    intent: "onchain",
    weight: 2,
    label: "on-chain keywords",
    test: kw(
      /\b(on-?chain|wallets?|transactions?|tx|block (number|height)|block #?\d+|latest block|gas fees?|smart contracts?|contract address|(this|that|the) (address|contract|token contract)|explorer|etherscan|blockscout|holders?|bridge[ds]?|mint(ed|ing)?|rpc|token transfers?|transfers?|most active contracts|network activity|recent activity|chain activity)\b/i,
    ),
  },
  { intent: "onchain", weight: 1, label: "tokenized assets", test: kw(/\btokeni[sz]ed (assets|stocks|equities|shares)\b/i) },

  { intent: "market", weight: 2, label: "market keywords", test: kw(/\b(price|market ?cap|mcap|volume|liquidity|pools?|trading|trending|unusual activity|pump(ing)?|dump(ing)?|ohlcv?|fdv|dex|gainers|losers)\b/i) },
  { intent: "market", weight: 2, label: "ticker", test: (_, e) => e.tickers.length > 0 },
  {
    intent: "market",
    weight: 2,
    label: "market keywords (2)",
    test: kw(/\b(price change|how much is|worth|charts?|candles?|ohlcv?|trades|buys and sells|buy pressure|sell pressure|market data|market activity|(most active|top|biggest) pools)\b/i),
  },
  // "Analyze this token 0x…" / "What happened to this token today?" — a token question includes its market.
  { intent: "market", weight: 2, label: "token question", test: (t, e) => /\b(this|the|that) token\b|\btoken\b.*\b(analy[sz]e|today|happened|doing)\b/i.test(t) || (e.addresses.length > 0 && /\btoken\b/i.test(t)) },
  { intent: "market", weight: 1, label: "token mention", test: kw(/\btokens?\b/i) },

  {
    intent: "news",
    weight: 2,
    label: "news/recency",
    test: kw(
      /\b(news|headlines?|announce(d|ment|ments)?|latest(?! (block|transaction|tx|release|releases|version|commit|commits)\b)|today|today'?s|tonight|this morning|this week|yesterday|recent(ly)?|what happened|what'?s happening|happening (with|on|in)|breaking|developments?|top stories|biggest stories|(last|past) \d+ (hours?|days?))\b/i,
    ),
  },

  { intent: "research", weight: 3, label: "research keywords", test: kw(/\b(deep research|research|deep dive|investigate|comprehensive|in-depth|report on|due diligence)\b/i) },
  { intent: "research", weight: 2, label: "comparison", test: kw(/\b(compare|comparison|versus|vs\.?|pros and cons)\b/i) },

  { intent: "web_extract", weight: 3, label: "non-github url", test: (_, e) => e.urls.some((u) => !/github\.com/i.test(u)) },
  { intent: "web_extract", weight: 2, label: "page reference", test: kw(/\b(this|the) (website|web ?page|page|site|article|link|blog post)\b/i) },

  { intent: "web_search", weight: 2, label: "lookup phrasing", test: kw(/\b(who is|who are|search( for)?|look up|find (out|me)|currently|right now|as of|20[2-9]\d)\b/i) },

  { intent: "summarize", weight: 3, label: "summarize", test: kw(/\b(summari[sz]e|summary|tl;?dr|recap|condense)\b/i) },

  { intent: "coding", weight: 2, label: "code keywords", test: kw(/```|\b(code|function|bug|stack ?trace|exception|typescript|javascript|python|rust|solidity|golang|compile|refactor|regex|sql|unit tests?|debug)\b/i) },
];

const THRESHOLD = 2;

/** Zero-cost, deterministic classifier. Runs on every request before any model is called. */
export function classifyIntent(text: string, opts: { forceResearch?: boolean } = {}): IntentResult {
  const entities = extractEntities(text);
  const scores = new Map<Intent, number>();
  const signals: string[] = [];

  for (const rule of RULES) {
    if (rule.test(text, entities)) {
      scores.set(rule.intent, (scores.get(rule.intent) ?? 0) + rule.weight);
      signals.push(`${rule.intent}:${rule.label}`);
    }
  }
  if (opts.forceResearch) {
    scores.set("research", (scores.get("research") ?? 0) + 5);
    signals.push("research:mode");
  }
  // "What happened on Robinhood Chain today?" — chain overviews benefit from market context.
  if ((scores.get("onchain") ?? 0) >= THRESHOLD && /\b(what happened|activity|overview|today|this week)\b/i.test(text)) {
    scores.set("market", Math.max(scores.get("market") ?? 0, THRESHOLD));
    signals.push("market:chain overview");
  }
  // Questions about a GitHub repo's code are GitHub tasks, not generic coding questions.
  if ((scores.get("github") ?? 0) >= THRESHOLD) scores.delete("coding");

  const intents = PRIMARY_ORDER.filter((i) => (scores.get(i) ?? 0) >= THRESHOLD);
  // "What is the price of this token 0x…?" is a market question even though the address also makes it on-chain.
  const oi = intents.indexOf("onchain");
  const mi = intents.indexOf("market");
  if (oi >= 0 && mi >= 0 && (scores.get("market") ?? 0) > (scores.get("onchain") ?? 0)) {
    intents.splice(mi, 1);
    intents.splice(oi, 0, "market");
  }
  if (intents.length === 0) intents.push("general");

  const top = Math.max(0, ...scores.values());
  const confidence = intents[0] === "general" ? (text.length < 200 ? 0.7 : 0.5) : Math.min(1, 0.4 + top * 0.15);

  return { intents, primary: intents[0]!, entities, confidence, method: "rules", signals };
}

const GITHUB_FOLLOWUP =
  /\b(this|that|the|its?)\s+(repo|repository|project|codebase|library|package)\b|\b(readme|releases?|contributors?|maintainers?|commits?|pull requests?|branch(es)?|architecture|written in|important files|open issues|recent issues|stars|forks|tech stack|file structure|folder structure)\b/i;

/**
 * Follow-ups like "Analyze this repo." or "What language is it written in?"
 * refer to a repository mentioned earlier in the conversation. If the current
 * message names no repo but reads like a GitHub question, inherit the most
 * recent repo from history. Deterministic and free.
 */
export function inheritGitHubContext(intent: IntentResult, message: string, history: { content: string }[]): IntentResult {
  if (intent.entities.githubRepos.length) return intent;
  if (!intent.intents.includes("github") && !GITHUB_FOLLOWUP.test(message)) return intent;
  for (let i = history.length - 1; i >= 0; i--) {
    const repo = extractGitHubRepos(history[i]!.content)[0];
    if (!repo) continue;
    const { ref: _r, path: _p, kind: _k, ...bare } = repo; // the earlier file path doesn't carry over
    const intents = orderIntents([...intent.intents.filter((x) => x !== "general" && x !== "coding"), "github"]);
    return {
      ...intent,
      intents,
      primary: intents[0]!,
      entities: { ...intent.entities, githubRepos: [bare] },
      signals: [...intent.signals, `github:repo from conversation (${bare.owner}/${bare.repo})`],
    };
  }
  return intent;
}

const ONCHAIN_FOLLOWUP =
  /\b(this|that|the|its?) (wallet|address|account|transaction|tx|contract|token|transfer)\b|\b(explain|analy[sz]e|decode) (it|this|that)\b|\b(recent|latest) activity\b|\bwhat (is|was) (it|this|that) doing\b/i;

/**
 * "Analyze this wallet." / "Explain this transaction." after an address or
 * transaction hash appeared earlier in the conversation: inherit the most
 * recent one. Deterministic and free.
 */
export function inheritOnchainContext(intent: IntentResult, message: string, history: { role?: string; content: string }[]): IntentResult {
  if (intent.entities.addresses.length || intent.entities.txHashes.length) return intent;
  if (!intent.intents.includes("onchain") && !ONCHAIN_FOLLOWUP.test(message)) return intent;
  for (let i = history.length - 1; i >= 0; i--) {
    const e = extractEntities(history[i]!.content);
    if (!e.addresses.length && !e.txHashes.length) continue;
    // Text: the last mention is the most recent. Client references (context turn) are ordered most relevant first.
    const one = (list: string[]) => (history[i]!.role === CONTEXT_ROLE ? list.slice(0, 1) : list.slice(-1));
    // Prefer what the message names: a transaction for "this transaction", else the address.
    const wantsTx = /\b(transaction|tx)\b/i.test(message);
    const pick = wantsTx && e.txHashes.length ? { txHashes: one(e.txHashes), addresses: [] } : e.addresses.length ? { txHashes: [], addresses: one(e.addresses) } : { txHashes: one(e.txHashes), addresses: [] };
    const intents = orderIntents([...intent.intents.filter((x) => x !== "general"), "onchain"]);
    return {
      ...intent,
      intents,
      primary: intents[0]!,
      entities: { ...intent.entities, ...pick },
      signals: [...intent.signals, `onchain:${pick.txHashes.length ? "transaction" : "address"} from conversation`],
    };
  }
  return intent;
}

const SHORT_FOLLOWUP = /^\s*(and|also|what about|how about|what'?s|whats|how'?s|is it|does it|did it|its|it'?s|their|same for|now|then|ok(ay)?|so)\b/i;
const REFERS_BACK = /\b(it|its|this|that|these|those|they|them|their|same|the (token|pool|repo|repository|project|contract|wallet|address|page|article|site|transaction))\b/i;
/** "Can you go deeper?" / "Tell me more" — continue the previous topic. */
const CONTINUES = /\b(go deeper|dig deeper|deeper|more (detail|details|depth|on (this|that|it))|tell me more|elaborate|expand( on (this|that|it))?|continue|keep going|explain (more|further)|and then\??$)\b/i;
const LIVE_INTENTS: Intent[] = ["web_search", "web_extract", "research", "news", "github", "onchain", "market"];

/** A history entry holding structured references sent by the client (`context.entities`). */
export const CONTEXT_ROLE = "context";

/**
 * Renders client-supplied references as a synthetic, most-recent history entry so the follow-up resolvers
 * treat them like an earlier mention. Only already-validated, strictly formatted values end up here.
 */
export function contextTurn(entities: { urls?: string[]; githubRepos?: string[]; addresses?: string[]; txHashes?: string[]; tickers?: string[] } | undefined) {
  if (!entities) return null;
  const parts = [
    ...(entities.githubRepos ?? []).map((r) => `https://github.com/${r}`),
    ...(entities.addresses ?? []),
    ...(entities.txHashes ?? []),
    ...(entities.urls ?? []),
    ...(entities.tickers ?? []).map((t) => `$${t}`),
  ];
  return parts.length ? { role: CONTEXT_ROLE, content: parts.join(" ") } : null;
}

/**
 * Generic follow-up resolver ("What about liquidity?" after "Analyze this token 0x…").
 * If the message names no entity of its own but reads like a follow-up, inherit the
 * entities of the most recent earlier user turn (or client-supplied references) that had
 * some — bounded to the last 6 messages, entities only (never earlier content). "Go deeper"
 * continuations with no entities at all carry over the previous question's live-data intents.
 * The previous question is kept as `contextQuery` so tools plan with the right topic.
 * Runs after the GitHub/on-chain specific resolvers.
 */
export function inheritFollowUpContext(intent: IntentResult, message: string, history: { role?: string; content: string }[]): IntentResult {
  const e = intent.entities;
  if (e.addresses.length || e.txHashes.length || e.githubRepos.length || e.urls.length) return intent;
  const words = message.trim().split(/\s+/).length;
  const continuation = words <= 12 && CONTINUES.test(message);
  if (!(continuation || SHORT_FOLLOWUP.test(message) || (words <= 8 && REFERS_BACK.test(message)))) return intent;

  const recent = history.slice(-7);
  const lastUser = [...recent].reverse().find((t) => !t.role || t.role === "user");
  const contextQuery = lastUser?.content.slice(0, 300);
  // Keep the new question's intents; if none of them needs live data ("Summarize it", "Go deeper"),
  // carry over the live-data intents of the earlier question.
  const own = intent.intents.filter((i) => i !== "general");
  const withPrevious = (prevText: string) => {
    const prevLive = classifyIntent(prevText).intents.filter((i) => LIVE_INTENTS.includes(i));
    return orderIntents(own.some((i) => LIVE_INTENTS.includes(i)) ? own : [...own, ...prevLive]);
  };

  for (const turn of [...recent].reverse()) {
    if (turn.role && turn.role !== "user" && turn.role !== CONTEXT_ROLE) continue;
    const prev = extractEntities(turn.content);
    if (!prev.addresses.length && !prev.txHashes.length && !prev.githubRepos.length && !prev.urls.length && !prev.tickers.length) continue;
    // Client references: judge the earlier question together with what it referred to (e.g. a page URL).
    const intents = withPrevious(turn.role === CONTEXT_ROLE && lastUser ? `${lastUser.content} ${turn.content}` : turn.content);
    return {
      ...intent,
      intents,
      primary: intents[0]!,
      entities: {
        ...e,
        addresses: prev.addresses.slice(0, 3),
        txHashes: prev.txHashes.slice(0, 3),
        githubRepos: prev.githubRepos.slice(0, 2).map(({ ref: _r, path: _p, kind: _k, ...r }) => r),
        urls: prev.urls.slice(0, 3),
        tickers: e.tickers.length ? e.tickers : prev.tickers.slice(0, 3),
      },
      ...(contextQuery ? { contextQuery } : {}),
      signals: [...intent.signals, "follow-up: entities inherited from the conversation"],
    };
  }
  if (continuation && lastUser) {
    const intents = withPrevious(lastUser.content);
    return { ...intent, intents, primary: intents[0]!, contextQuery: contextQuery!, signals: [...intent.signals, "follow-up: continuing the previous question"] };
  }
  return intent;
}

/** Sorts intents most-specific first (the first one becomes the primary intent). */
export function orderIntents(intents: Intent[]): Intent[] {
  const set = new Set(intents);
  const ordered = PRIMARY_ORDER.filter((i) => set.has(i));
  return ordered.length ? ordered : ["general"];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function uniqueBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
