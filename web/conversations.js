// TILIK conversations: browser-local history, titles and bounded follow-up context.
// Pure logic (no DOM): the storage, clock and id generator are injected, so it runs in Node tests too.

export const LIMITS = Object.freeze({
  maxConversations: 50,
  maxMessagesPerConversation: 100,
  maxContentChars: 12_000,
  maxSourcesPerMessage: 20,
  /** Serialized size budget (characters ≈ bytes for this mostly-ASCII data); localStorage is ~5 MB per origin. */
  maxStoreChars: 2_000_000,
  maxTitleChars: 50,
  /** Follow-up context sent with each request. */
  contextMessages: 6,
  contextUserChars: 1_000,
  contextAssistantChars: 600,
});

const STORAGE_KEY = "veyra.conversations.v1";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const TICKER = /^[A-Za-z][A-Za-z0-9]{0,14}$/;

/** Conversation/message ids: 122 random bits (UUIDv4), or 128 bits from getRandomValues on older browsers. Never guessable. */
const defaultId = () => {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = c.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};
/** Ids end up in the URL (/chat/<id>): anything else in storage is ignored. */
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

// ── Titles ─────────────────────────────────────────────────────────────────
const NOUN_FOR_VERB = {
  analyze: "analysis", analyse: "analysis", research: "research", summarize: "summary", summarise: "summary",
  explain: "explained", review: "review", compare: "comparison", check: "check", investigate: "investigation",
  audit: "audit", explore: "exploration", track: "tracking", monitor: "monitoring",
};
const LEADING_FILLER = /^(?:(?:hey|hi|hello|please|pls|ok(?:ay)?|so|tilik|veyra)[,!.]?\s+|(?:can|could|would|will) you\s+|i (?:want|need|would like) (?:you )?to\s+|tell me\s+(?=about\b)|help me\s+)+/i;
const ARTICLES = /^(?:this|that|the|a|an|my|our|these|those)\s+/i;

/** Short, deterministic conversation title from the first user message (no model call). */
export function generateTitle(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "New chat";
  const repo = raw.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
  const tx = raw.match(/0x[0-9a-fA-F]{64}/);
  const address = raw.match(/0x[0-9a-fA-F]{40}/);
  const url = raw.match(/https?:\/\/([^/\s?#]+)/i);
  const short = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`;
  if (repo) return clip(`${repo[1]}/${repo[2].replace(/\.git$/, "")} repository analysis`);
  if (tx) return clip(`Transaction ${short(tx[0])}`);
  if (address) return clip(`${/\btoken\b/i.test(raw) ? "Token" : "Address"} ${short(address[0])}`);

  let s = raw.replace(/https?:\/\/\S+/gi, url ? url[1].replace(/^www\./, "") : "");
  s = s.replace(LEADING_FILLER, "");
  const verb = s.match(/^([A-Za-z]+)\s+(.+)$/);
  const noun = verb && NOUN_FOR_VERB[verb[1].toLowerCase()];
  if (noun) s = `${verb[2].replace(ARTICLES, "")} ${noun}`;
  s = s
    .replace(/[?!.;:,]+(\s|$)/g, "$1") // sentence punctuation
    .replace(/["'`*_#()[\]{}<>]/g, (c) => (c === "'" ? c : "")) // keep apostrophes ("What's")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "New chat";
  // Capitalize the first word, unless it is a domain/path or has its own casing ("nodejs.org", "iPhone").
  const first = s.split(" ")[0];
  const keep = /[./]/.test(first) || /[A-Z]/.test(first.slice(1));
  return clip(keep ? s : s.charAt(0).toUpperCase() + s.slice(1));
}

function clip(s) {
  if (s.length <= LIMITS.maxTitleChars) return s;
  const cut = s.slice(0, LIMITS.maxTitleChars + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 20 ? cut.slice(0, space) : cut.slice(0, LIMITS.maxTitleChars)).trim();
}

// ── Relative time ──────────────────────────────────────────────────────────
export function relativeTime(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d > 300 ? { year: "numeric" } : {}) });
}

// ── Structured references (what a follow-up can point back to) ─────────────
const emptyRefs = () => ({ urls: [], githubRepos: [], addresses: [], txHashes: [], tickers: [] });
const REF_CAPS = { urls: 3, githubRepos: 2, addresses: 4, txHashes: 2, tickers: 3 };

function addRef(refs, kind, value) {
  if (typeof value !== "string" || !value) return;
  const ok =
    kind === "addresses" ? ADDRESS.test(value) :
    kind === "txHashes" ? TX_HASH.test(value) :
    kind === "githubRepos" ? REPO.test(value) :
    kind === "tickers" ? TICKER.test(value) :
    /^https?:\/\/\S+$/i.test(value) && value.length <= 2048;
  if (!ok) return;
  const norm = kind === "tickers" ? value.toUpperCase() : value;
  if (!refs[kind].some((v) => v.toLowerCase() === norm.toLowerCase()) && refs[kind].length < REF_CAPS[kind]) refs[kind].push(norm);
}

/**
 * References worth keeping from a completed response: what the request resolved (plan.entities, including
 * anything inherited) first, then what the tools found (repo + homepage, token/pool addresses, chain targets).
 * Bounded and strictly formatted — the backend validates them again.
 */
export function extractReferences(response) {
  const refs = emptyRefs();
  const e = response?.plan?.entities ?? {};
  for (const r of e.githubRepos ?? []) addRef(refs, "githubRepos", r && `${r.owner}/${r.repo}`);
  for (const a of e.addresses ?? []) addRef(refs, "addresses", a);
  for (const t of e.txHashes ?? []) addRef(refs, "txHashes", t);
  for (const u of e.urls ?? []) addRef(refs, "urls", u);
  for (const t of e.tickers ?? []) addRef(refs, "tickers", t);
  const data = response?.data ?? {};
  for (const { data: d } of data["github.repo"] ?? []) {
    const full = d?.repo?.fullName;
    addRef(refs, "githubRepos", full);
    addRef(refs, "urls", d?.repo?.homepage);
  }
  for (const { data: d } of data["market.data"] ?? []) {
    for (const t of d?.tokens ?? []) addRef(refs, "addresses", t?.address);
    const top = d?.pools?.[0];
    if (top) {
      addRef(refs, "addresses", top.baseToken);
      addRef(refs, "addresses", top.address);
    }
  }
  for (const { data: d } of data["chain.data"] ?? []) {
    for (const t of d?.targets ?? []) addRef(refs, typeof t === "string" && TX_HASH.test(t) ? "txHashes" : "addresses", typeof t === "string" ? t : t?.value ?? t?.address);
  }
  // Pages TILIK chose to read on its own (e.g. top news stories) are not references the user made;
  // pages the user named are already in plan.entities.urls.
  return refs;
}

const hasRefs = (r) => r && Object.values(r).some((v) => v.length);

// ── Compact snapshot of a response (enough to re-render cards and sources after a reload) ──
export function compactData(data) {
  const out = {};
  const market = (data?.["market.data"] ?? []).map(({ tool, data: d }) => ({
    tool,
    data: {
      fetchedAt: d?.fetchedAt,
      pools: (d?.pools ?? []).slice(0, 3).map((p) => ({
        name: p.name, address: p.address, dex: p.dex, basePriceUsd: p.basePriceUsd, liquidityUsd: p.liquidityUsd,
        volumeUsd: { h24: p.volumeUsd?.h24 }, priceChangePct: { h24: p.priceChangePct?.h24 },
      })),
    },
  }));
  if (market.length) out["market.data"] = market;
  const chain = (data?.["chain.data"] ?? []).map(({ tool, data: d }) => ({ tool, data: { chain: d?.chain, dataSources: d?.dataSources } }));
  if (chain.length) out["chain.data"] = chain;
  const gh = (data?.["github.repo"] ?? []).map(({ tool, data: d }) => {
    const r = d?.repo ?? {};
    return { tool, data: { repo: { fullName: r.fullName, url: r.url, description: r.description, stars: r.stars, forks: r.forks, language: r.language, pushedAt: r.pushedAt, license: r.license } } };
  });
  if (gh.length) out["github.repo"] = gh;
  const news = (data?.["news.feed"] ?? []).map(({ tool, data: d }) => ({
    tool,
    data: { stories: (d?.stories ?? []).slice(0, 4).map((s) => ({ title: s.title, publishedAt: s.publishedAt, sources: (s.sources ?? []).slice(0, 1).map((x) => ({ url: x.url, source: x.source })) })) },
  }));
  if (news.length) out["news.feed"] = news;
  return out;
}

const compactSources = (sources) =>
  (sources ?? []).slice(0, LIMITS.maxSourcesPerMessage).map((s) => ({
    id: s.id, title: typeof s.title === "string" ? s.title.slice(0, 300) : s.title, url: s.url, domain: s.domain, authority: s.authority,
  }));

/** Assistant message from a completed /chat response. Only the final answer — never reasoning, prompts or raw tool payloads. */
export function assistantMessageFrom(response) {
  return {
    role: "assistant",
    content: String(response?.answer ?? ""),
    type: response?.type ?? "normal",
    sources: compactSources(response?.sources),
    metadata: {
      intents: response?.plan?.unifiedIntents ?? [],
      provider: response?.model?.provider,
      model: response?.model?.model,
      grounded: response?.grounded !== false,
      data: compactData(response?.data),
      references: extractReferences(response),
      timings: response?.timings ? { totalMs: response.timings.totalMs } : undefined,
      responseId: typeof response?.id === "string" ? response.id : undefined,
      sharedFrom: typeof response?.sharedFrom === "string" ? response.sharedFrom : undefined,
    },
  };
}

// ── Follow-up context sent with each request ───────────────────────────────
/** Plain-text summary of an answer: no markdown, no citation markers, first sentences only. */
export function summarize(text, max = LIMITS.contextAssistantChars) {
  const plain = String(text ?? "")
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut.trimEnd() + "…");
}

/**
 * Bounded context for the next request: the last few exchanges (user text clipped, assistant answers
 * summarized), plus structured references from the most recent answers. Failed turns are skipped.
 */
export function buildRequestContext(messages, opts = {}) {
  const n = opts.maxMessages ?? LIMITS.contextMessages;
  const usable = (messages ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && !m.metadata?.error && m.content);
  const recent = usable.slice(-n);
  const history = recent.map((m) =>
    m.role === "user"
      ? { role: "user", content: m.content.slice(0, LIMITS.contextUserChars) }
      : { role: "assistant", content: summarize(m.content) },
  );
  const refs = emptyRefs();
  for (const m of [...recent].reverse()) {
    const r = m.metadata?.references;
    if (!r) continue;
    for (const kind of Object.keys(refs)) for (const v of r[kind] ?? []) addRef(refs, kind, v);
  }
  const entities = Object.fromEntries(Object.entries(refs).filter(([, v]) => v.length));
  return { history, ...(Object.keys(entities).length ? { context: { entities } } : {}) };
}

// ── Store ──────────────────────────────────────────────────────────────────
/**
 * Conversations in browser storage. Never throws: if storage is unavailable or full, everything keeps
 * working in memory and `onError` is called once per kind of failure (the UI shows a quiet warning).
 */
export function createConversationStore({ storage, now = () => Date.now(), newId = defaultId, onError = () => {}, limits = LIMITS } = {}) {
  let state = { activeId: null, conversations: [] };
  let persistent = Boolean(storage);
  let timer = null;
  const reported = new Set();
  const fail = (kind, err) => {
    if (reported.has(kind)) return;
    reported.add(kind);
    onError(kind, err);
  };

  const sanitizeMessage = (m, conversationId) =>
    m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
      ? {
          id: typeof m.id === "string" && SAFE_ID.test(m.id) ? m.id : newId(),
          conversationId,
          role: m.role,
          content: m.content.slice(0, limits.maxContentChars),
          createdAt: Number.isFinite(m.createdAt) ? m.createdAt : now(),
          ...(m.type ? { type: m.type } : {}),
          sources: Array.isArray(m.sources) ? m.sources.slice(0, limits.maxSourcesPerMessage) : [],
          metadata: m.metadata && typeof m.metadata === "object" ? m.metadata : {},
        }
      : null;

  const load = () => {
    if (!storage) return;
    let raw = null;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch (err) {
      persistent = false;
      fail("unavailable", err);
      return;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const conversations = (Array.isArray(parsed?.conversations) ? parsed.conversations : [])
        .filter((c) => c && typeof c.id === "string" && SAFE_ID.test(c.id))
        .map((c) => ({
          id: c.id,
          title: typeof c.title === "string" && c.title ? c.title.slice(0, 120) : "New chat",
          titleEdited: Boolean(c.titleEdited),
          createdAt: Number.isFinite(c.createdAt) ? c.createdAt : now(),
          updatedAt: Number.isFinite(c.updatedAt) ? c.updatedAt : now(),
          messages: (Array.isArray(c.messages) ? c.messages : []).map((m) => sanitizeMessage(m, c.id)).filter(Boolean),
        }))
        .filter((c) => c.messages.length);
      state = { activeId: conversations.some((c) => c.id === parsed.activeId) ? parsed.activeId : null, conversations };
    } catch (err) {
      fail("corrupt", err); // unreadable data: start fresh in memory, don't overwrite until something changes
    }
  };

  const serialize = () =>
    JSON.stringify({ version: 1, activeId: state.activeId, conversations: state.conversations.filter((c) => c.messages.length) });

  /** Oldest conversations go first, never the active one. Returns false when nothing else can go. */
  const evictOldest = () => {
    const candidates = state.conversations.filter((c) => c.id !== state.activeId && c.messages.length).sort((a, b) => a.updatedAt - b.updatedAt);
    if (!candidates.length) return false;
    state.conversations = state.conversations.filter((c) => c.id !== candidates[0].id);
    return true;
  };

  const enforceLimits = () => {
    for (const c of state.conversations) if (c.messages.length > limits.maxMessagesPerConversation) c.messages = c.messages.slice(-limits.maxMessagesPerConversation);
    while (state.conversations.filter((c) => c.messages.length).length > limits.maxConversations && evictOldest());
    let json = serialize();
    while (json.length > limits.maxStoreChars && evictOldest()) json = serialize();
    return json;
  };

  const isQuota = (err) => err?.name === "QuotaExceededError" || err?.name === "NS_ERROR_DOM_QUOTA_REACHED" || err?.code === 22 || err?.code === 1014;
  const writeNow = () => {
    clearTimeout(timer);
    timer = null;
    let json = enforceLimits();
    if (!persistent) return;
    for (;;) {
      try {
        storage.setItem(STORAGE_KEY, json);
        return;
      } catch (err) {
        // Full: drop the oldest inactive conversation and retry. If only the active one is left, keep it in memory.
        if (isQuota(err) && evictOldest()) {
          json = serialize();
          continue;
        }
        // Still full with only the active chat left: keep it in memory (later writes retry).
        // Blocked/other failure: nothing is deleted; history simply stays in memory for this session.
        if (!isQuota(err)) persistent = false;
        fail(isQuota(err) ? "quota" : "write", err);
        return;
      }
    }
  };
  /** Debounced: several changes in a row (title + message + active id) become one write. */
  const save = () => {
    if (timer) return;
    timer = setTimeout(writeNow, 150);
  };

  const find = (id) => state.conversations.find((c) => c.id === id) ?? null;

  const api = {
    get persistent() { return persistent; },
    load() { load(); return api; },
    /** Newest first; only conversations with at least one message. */
    list() {
      return state.conversations.filter((c) => c.messages.length).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    get(id) { return find(id); },
    get activeId() { return state.activeId; },
    active() { return find(state.activeId); },
    /** A fresh conversation (kept in memory until its first message, so empty chats never clutter history). */
    create() {
      const t = now();
      const c = { id: newId(), title: "New chat", titleEdited: false, createdAt: t, updatedAt: t, messages: [] };
      state.conversations = state.conversations.filter((x) => x.messages.length); // drop other empty drafts
      state.conversations.push(c);
      state.activeId = c.id;
      save();
      return c;
    },
    setActive(id) {
      if (!find(id)) return null;
      state.activeId = id;
      save();
      return find(id);
    },
    /** Adds a message; the first user message titles the conversation. Returns the stored message. */
    addMessage(conversationId, message) {
      const c = find(conversationId);
      if (!c) return null;
      const m = sanitizeMessage({ ...message, id: newId(), createdAt: now() }, conversationId);
      if (!m) return null;
      c.messages.push(m);
      c.updatedAt = m.createdAt;
      if (m.role === "user" && !c.titleEdited && c.messages.filter((x) => x.role === "user").length === 1) c.title = generateTitle(m.content);
      save();
      return m;
    },
    rename(id, title) {
      const c = find(id);
      const t = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (!c || !t) return false;
      c.title = t;
      c.titleEdited = true;
      save();
      return true;
    },
    /** Deletes one conversation. Returns whether it was the active one (the UI then opens a new chat). */
    remove(id) {
      const wasActive = state.activeId === id;
      const before = state.conversations.length;
      state.conversations = state.conversations.filter((c) => c.id !== id);
      if (wasActive) state.activeId = null;
      if (state.conversations.length !== before) writeNow(); // deletes are written immediately
      return wasActive;
    },
    /** Writes pending changes now (e.g. on pagehide). */
    flush() { if (timer) writeNow(); },
    contextFor(conversationId, opts) {
      return buildRequestContext(find(conversationId)?.messages ?? [], opts);
    },
  };
  return api;
}

// ── Sidebar (desktop: always visible; mobile: drawer) ──────────────────────
export function createSidebarController({ isMobile, render }) {
  let open = false;
  const set = (v) => {
    open = Boolean(v) && isMobile();
    render(open);
  };
  return {
    get open() { return open; },
    toggle() { set(!open); },
    close() { set(false); },
    /** After choosing a conversation (or New chat) the mobile drawer gets out of the way. */
    selected() { if (open) set(false); },
    /** Leaving mobile layout never leaves a stale drawer/backdrop behind. */
    resized() { if (open && !isMobile()) set(false); },
  };
}

/** Browser storage, or null when the browser blocks it (private mode, disabled site data). */
export function browserStorage() {
  try {
    const s = globalThis.localStorage;
    const probe = "veyra.probe";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}
