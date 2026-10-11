import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LIMITS,
  assistantMessageFrom,
  buildRequestContext,
  createConversationStore,
  createSidebarController,
  extractReferences,
  generateTitle,
  relativeTime,
  summarize,
  type StorageLike,
} from "../web/conversations.js";

const POOL = "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca";
const TOKEN = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

/** In-memory localStorage stand-in that can be told to fail like a real browser. */
class FakeStorage implements StorageLike {
  data = new Map<string, string>();
  writes = 0;
  constructor(private readonly opts: { blocked?: boolean; quotaChars?: number; failWrites?: boolean } = {}) {}
  getItem(k: string) {
    if (this.opts.blocked) throw new DOMExceptionLike("SecurityError");
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.opts.blocked || this.opts.failWrites) throw new DOMExceptionLike("SecurityError");
    if (this.opts.quotaChars !== undefined && v.length > this.opts.quotaChars) throw new DOMExceptionLike("QuotaExceededError");
    this.writes++;
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}
class DOMExceptionLike extends Error {
  constructor(name: string) {
    super(name);
    this.name = name;
  }
}

function setup(storage: StorageLike | null = new FakeStorage(), extra: { onError?: (k: string) => void; limits?: typeof LIMITS } = {}) {
  let t = 1_000_000;
  let n = 0;
  const store = createConversationStore({
    storage,
    now: () => (t += 1000),
    newId: () => `id-${String(++n).padStart(6, "0")}`,
    ...(extra.onError ? { onError: extra.onError } : {}),
    ...(extra.limits ? { limits: extra.limits } : {}),
  }).load();
  return { store, storage };
}

const marketResponse = {
  id: "r1",
  type: "combined",
  answer: "## USDG\nUSDG trades at **$1.00** [1]. Liquidity is deep [2].\n- Pool A [2]",
  grounded: true,
  sources: [
    { id: 1, title: "Market: USDG", url: "https://api.geckoterminal.com/x", domain: "api.geckoterminal.com", authority: "direct", snippet: "s", type: "market" },
    { id: 2, title: "Robinhood Chain", url: "https://robinhoodchain.blockscout.com", domain: "robinhoodchain.blockscout.com", authority: "direct" },
  ],
  plan: { unifiedIntents: ["MARKET"], entities: { urls: [], githubRepos: [], addresses: [], txHashes: [], tickers: ["USDG"] } },
  data: {
    "market.data": [{ tool: "geckoterminal", step: "s", data: { fetchedAt: "2026-10-07T00:00:00Z", tokens: [], pools: [{ name: "USDG / WETH", address: POOL, baseToken: TOKEN, basePriceUsd: 1, liquidityUsd: 24e6, volumeUsd: { h24: 1, m5: 2 }, priceChangePct: { h24: 0.1 }, txns: { huge: "x".repeat(5000) } }] } }],
    "github.repo": [{ tool: "github", step: "g", data: { repo: { fullName: "honojs/hono", url: "https://github.com/honojs/hono", homepage: "https://hono.dev", stars: 1 }, readme: { content: "x".repeat(9000) } } }],
  },
  model: { provider: "dev-mock", model: "m" },
  timings: { totalMs: 1234 },
};

describe("conversations: lifecycle", () => {
  it("new chat gets a fresh, stable id and becomes active; empty chats are not listed", () => {
    const { store } = setup();
    const a = store.create();
    assert.equal(store.activeId, a.id);
    store.addMessage(a.id, { role: "user", content: "hello" });
    const b = store.create();
    assert.notEqual(a.id, b.id);
    assert.equal(store.activeId, b.id);
    assert.deepEqual(store.list().map((c) => c.id), [a.id]); // b has no messages yet
    assert.equal(store.get(a.id)!.id, a.id); // stable
  });

  it("every message belongs to exactly one conversation and has its own id (not its text)", () => {
    const { store } = setup();
    const a = store.create();
    const m1 = store.addMessage(a.id, { role: "user", content: "same text" })!;
    const m2 = store.addMessage(a.id, { role: "user", content: "same text" })!;
    assert.notEqual(m1.id, m2.id);
    assert.equal(m1.conversationId, a.id);
    assert.deepEqual(Object.keys(m1).sort(), ["content", "conversationId", "createdAt", "id", "metadata", "role", "sources"]);
    assert.equal(store.addMessage("missing", { role: "user", content: "x" }), null);
  });

  it("persists and restores conversations, messages, titles, timestamps and the active chat after a reload", () => {
    const storage = new FakeStorage();
    const { store } = setup(storage);
    const a = store.create();
    store.addMessage(a.id, { role: "user", content: "What is the price of USDG on Robinhood Chain?" });
    store.addMessage(a.id, assistantMessageFrom(marketResponse));
    store.flush();
    const { store: reloaded } = setup(storage);
    const c = reloaded.get(a.id)!;
    assert.equal(reloaded.activeId, a.id);
    assert.equal(c.title, "What is the price of USDG on Robinhood Chain");
    assert.equal(c.messages.length, 2);
    assert.equal(c.messages[1]!.type, "combined");
    assert.equal(c.messages[1]!.sources.length, 2);
    assert.ok(c.createdAt > 0 && c.updatedAt >= c.createdAt);
  });

  it("lists conversations newest first", () => {
    const { store } = setup();
    const a = store.create();
    store.addMessage(a.id, { role: "user", content: "first" });
    const b = store.create();
    store.addMessage(b.id, { role: "user", content: "second" });
    assert.deepEqual(store.list().map((c) => c.id), [b.id, a.id]);
    store.addMessage(a.id, { role: "user", content: "a again" });
    assert.deepEqual(store.list().map((c) => c.id), [a.id, b.id]);
  });

  it("renames a conversation; the automatic title never overwrites a user's name", () => {
    const { store } = setup();
    const a = store.create();
    store.addMessage(a.id, { role: "user", content: "Analyze this GitHub repository" });
    assert.equal(store.rename(a.id, "  My   repo  "), true);
    assert.equal(store.get(a.id)!.title, "My repo");
    assert.equal(store.rename(a.id, "   "), false);
    assert.equal(store.get(a.id)!.title, "My repo");
  });

  it("deletes one conversation (and only that one) from memory and storage, immediately", () => {
    const storage = new FakeStorage();
    const { store } = setup(storage);
    const a = store.create();
    store.addMessage(a.id, { role: "user", content: "keep me" });
    const b = store.create();
    store.addMessage(b.id, { role: "user", content: "delete me" });
    store.setActive(a.id);
    assert.equal(store.remove(b.id), false); // not the active one
    assert.deepEqual(store.list().map((c) => c.id), [a.id]);
    assert.ok(!storage.data.get("veyra.conversations.v1")!.includes("delete me"));
  });

  it("deleting the active conversation reports it so the UI opens a new chat", () => {
    const { store } = setup();
    const a = store.create();
    store.addMessage(a.id, { role: "user", content: "x" });
    assert.equal(store.remove(a.id), true);
    assert.equal(store.activeId, null);
    assert.equal(store.active(), null);
  });
});

describe("conversations: titles and time", () => {
  it("generates short deterministic titles without a model", () => {
    assert.equal(generateTitle("Analyze this GitHub repository"), "GitHub repository analysis");
    assert.equal(generateTitle("Can you analyze https://github.com/honojs/hono?"), "honojs/hono repository analysis");
    assert.equal(generateTitle("Please research the Robinhood Chain ecosystem!!"), "Robinhood Chain ecosystem research");
    assert.equal(generateTitle("What's happening on Robinhood Chain?"), "What's happening on Robinhood Chain");
    assert.equal(generateTitle(`Analyze this token ${TOKEN}`), "Token 0x5fc5…d168");
    assert.equal(generateTitle("Summarize https://nodejs.org/en/about"), "nodejs.org summary");
    assert.equal(generateTitle("   "), "New chat");
    const long = generateTitle("Explain in great detail how the consensus mechanism of a modern proof of stake blockchain works today");
    assert.ok(long.length <= 50, long);
    assert.ok(!/[?!.,;:]$/.test(long));
  });

  it("formats relative times", () => {
    const now = Date.UTC(2026, 9, 7, 12);
    assert.equal(relativeTime(now - 10_000, now), "just now");
    assert.equal(relativeTime(now - 2 * 60_000, now), "2 minutes ago");
    assert.equal(relativeTime(now - 3 * 3_600_000, now), "3 hours ago");
    assert.equal(relativeTime(now - 26 * 3_600_000, now), "yesterday");
    assert.equal(relativeTime(now - 4 * 86_400_000, now), "4 days ago");
  });
});

describe("conversations: follow-up context", () => {
  it("sends recent turns (user text + assistant summary) and structured references", () => {
    const { store } = setup();
    const a = store.create();
    store.addMessage(a.id, { role: "user", content: "What is the price of USDG on Robinhood Chain?" });
    store.addMessage(a.id, assistantMessageFrom(marketResponse));
    const ctx = store.contextFor(a.id);
    assert.deepEqual(ctx.history.map((h) => h.role), ["user", "assistant"]);
    assert.equal(ctx.history[1]!.content, "USDG USDG trades at $1.00 . Liquidity is deep . Pool A");
    assert.deepEqual(ctx.context!.entities.tickers, ["USDG"]);
    assert.deepEqual(ctx.context!.entities.addresses, [TOKEN, POOL]);
    assert.deepEqual(ctx.context!.entities.githubRepos, ["honojs/hono"]);
    assert.deepEqual(ctx.context!.entities.urls, ["https://hono.dev"]);
  });

  it("preserves references the user never typed: repo URL, homepage, token and pool addresses, tx hashes", () => {
    const refs = extractReferences({
      plan: { entities: { githubRepos: [{ owner: "acme", repo: "widget" }], txHashes: [`0x${"ab".repeat(32)}`], addresses: [], urls: ["https://acme.example/docs"], tickers: [] } },
      data: {
        "github.repo": [{ data: { repo: { fullName: "acme/widget", homepage: "https://acme.example" } } }],
        "web.extract": [{ data: { url: "https://news.example/unrelated-story" } }], // auto-read story: not a user reference
        "market.data": [{ data: { tokens: [{ address: TOKEN }], pools: [{ address: POOL }] } }],
        "chain.data": [{ data: { targets: [`0x${"cd".repeat(32)}`] } }],
      },
    });
    assert.deepEqual(refs.githubRepos, ["acme/widget"]);
    assert.deepEqual(refs.txHashes, [`0x${"ab".repeat(32)}`, `0x${"cd".repeat(32)}`]);
    assert.deepEqual(refs.addresses, [TOKEN, POOL]);
    assert.deepEqual(refs.urls, ["https://acme.example/docs", "https://acme.example"]);
  });

  it("drops malformed references instead of sending them", () => {
    const refs = extractReferences({ plan: { entities: { addresses: ["0xnope"], urls: ["javascript:alert(1)"], tickers: ["$$"], githubRepos: [{ owner: "..", repo: "../x" }] } } });
    assert.deepEqual(refs, { urls: [], githubRepos: [], addresses: [], txHashes: [], tickers: [] });
  });

  it("is bounded: only the last messages, clipped, with failed turns skipped", () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`, conversationId: "c", role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
      content: "word ".repeat(2000), createdAt: i, sources: [], metadata: {},
    }));
    messages.push({ id: "e", conversationId: "c", role: "assistant", content: "", createdAt: 99, sources: [], metadata: { error: "VEYRA is busy" } as never });
    const { history } = buildRequestContext(messages);
    assert.equal(history.length, LIMITS.contextMessages);
    for (const h of history) assert.ok(h.content.length <= (h.role === "user" ? LIMITS.contextUserChars : LIMITS.contextAssistantChars + 1));
    assert.ok(!history.some((h) => h.content === ""));
    const total = JSON.stringify(history).length;
    assert.ok(total < 6000, `context stays small (${total} chars)`);
  });

  it("summaries contain no markdown or citation markers", () => {
    assert.equal(summarize("**Bold** claim [1, 2]. `code` and _x_."), "Bold claim . code and x.");
  });

  it("stores only the final answer: no reasoning, prompts or raw tool payloads", () => {
    const m = assistantMessageFrom({ ...marketResponse, reasoning: "hidden chain of thought", plan: { ...marketResponse.plan, model: { reasons: ["x"] } } });
    const json = JSON.stringify(m);
    assert.ok(!json.includes("hidden chain of thought"));
    assert.ok(!json.includes("x".repeat(5000)), "raw txns payload not stored");
    assert.ok(!json.includes("x".repeat(9000)), "README not stored");
    assert.ok(json.length < 3000, `compact (${json.length} chars)`);
  });
});

describe("conversations: storage failures and limits", () => {
  it("keeps working in memory when storage is blocked, and reports it once", () => {
    const errors: string[] = [];
    const { store } = setup(new FakeStorage({ blocked: true }), { onError: (k) => errors.push(k) });
    const a = store.create();
    store.addMessage(a.id, { role: "user", content: "still works" });
    store.flush();
    assert.equal(store.persistent, false);
    assert.equal(store.get(a.id)!.messages.length, 1);
    assert.deepEqual(errors, ["unavailable"]);
  });

  it("no storage at all (null) is fine too", () => {
    const { store } = setup(null);
    const a = store.create();
    assert.ok(store.addMessage(a.id, { role: "user", content: "x" }));
    store.flush();
  });

  it("write failures never throw and never delete conversations", () => {
    const errors: string[] = [];
    const { store } = setup(new FakeStorage({ failWrites: true }), { onError: (k) => errors.push(k) });
    const a = store.create();
    store.addMessage(a.id, { role: "user", content: "x" });
    const b = store.create();
    store.addMessage(b.id, { role: "user", content: "y" });
    assert.doesNotThrow(() => store.flush());
    assert.equal(store.list().length, 2);
    assert.deepEqual(errors, ["write"]);
  });

  it("corrupt saved data starts fresh instead of crashing", () => {
    const storage = new FakeStorage();
    storage.data.set("veyra.conversations.v1", "{not json");
    const errors: string[] = [];
    const { store } = setup(storage, { onError: (k) => errors.push(k) });
    assert.deepEqual(store.list(), []);
    assert.deepEqual(errors, ["corrupt"]);
  });

  it("caps the number of conversations, removing the oldest — never the active one", () => {
    const limits = { ...LIMITS, maxConversations: 3 };
    const { store } = setup(new FakeStorage(), { limits });
    const first = store.create();
    store.addMessage(first.id, { role: "user", content: "oldest but active later" });
    const ids = [first.id];
    for (let i = 0; i < 4; i++) {
      const c = store.create();
      store.addMessage(c.id, { role: "user", content: `chat ${i}` });
      ids.push(c.id);
    }
    store.setActive(first.id);
    store.flush();
    const kept = store.list().map((c) => c.id);
    assert.equal(kept.length, 3);
    assert.ok(kept.includes(first.id), "active conversation kept");
    assert.ok(!kept.includes(ids[1]!) && !kept.includes(ids[2]!), "oldest inactive removed");
  });

  it("on a full browser quota, evicts oldest inactive chats until the write fits", () => {
    const storage = new FakeStorage({ quotaChars: 1500 });
    const { store } = setup(storage);
    for (let i = 0; i < 6; i++) {
      const c = store.create();
      store.addMessage(c.id, { role: "user", content: `${i} ${"y".repeat(300)}` });
    }
    store.flush();
    const saved = storage.data.get("veyra.conversations.v1")!;
    assert.ok(saved.length <= 1500);
    assert.ok(store.list().length < 6 && store.list().length >= 1);
    assert.equal(store.list()[0]!.id, store.activeId);
  });

  it("clips oversized messages and caps messages per conversation", () => {
    const limits = { ...LIMITS, maxMessagesPerConversation: 4 };
    const { store } = setup(new FakeStorage(), { limits });
    const a = store.create();
    for (let i = 0; i < 6; i++) store.addMessage(a.id, { role: "user", content: `${i}${"z".repeat(20_000)}` });
    store.flush();
    const msgs = store.get(a.id)!.messages;
    assert.equal(msgs.length, 4);
    assert.ok(msgs.every((m) => m.content.length <= LIMITS.maxContentChars));
    assert.ok(msgs[0]!.content.startsWith("2"));
  });

  it("debounces writes: many changes in a row become one write", () => {
    const storage = new FakeStorage();
    const { store } = setup(storage);
    const a = store.create();
    for (let i = 0; i < 10; i++) store.addMessage(a.id, { role: "user", content: `m${i}` });
    store.rename(a.id, "Renamed");
    assert.equal(storage.writes, 0);
    store.flush();
    assert.equal(storage.writes, 1);
  });
});

describe("conversations: mobile sidebar", () => {
  const make = (mobile: boolean) => {
    const renders: boolean[] = [];
    let isMobile = mobile;
    const s = createSidebarController({ isMobile: () => isMobile, render: (o) => renders.push(o) });
    return { s, renders, setMobile: (v: boolean) => (isMobile = v) };
  };

  it("on mobile the drawer opens, and closes after choosing a conversation", () => {
    const { s } = make(true);
    s.toggle();
    assert.equal(s.open, true);
    s.selected();
    assert.equal(s.open, false);
  });

  it("on desktop the sidebar is part of the layout: no drawer state", () => {
    const { s } = make(false);
    s.toggle();
    assert.equal(s.open, false);
  });

  it("growing past the mobile breakpoint closes a stale drawer", () => {
    const { s, setMobile, renders } = make(true);
    s.toggle();
    setMobile(false);
    s.resized();
    assert.equal(s.open, false);
    assert.equal(renders.at(-1), false);
  });
});
