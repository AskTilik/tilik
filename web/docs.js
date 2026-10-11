// TILIK Docs: copy buttons, code tabs, section search, contents that follow the scroll, live source status.
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // ── Copy to clipboard (code blocks and example questions) ──
  const copyText = async (text, button) => {
    try {
      await navigator.clipboard.writeText(text);
      const label = button.textContent;
      button.textContent = "Copied";
      button.classList.add("done");
      setTimeout(() => { button.textContent = label; button.classList.remove("done"); }, 1400);
    } catch {
      button.textContent = "Copy failed";
    }
  };
  for (const pre of $$("pre.code")) {
    const button = $(".copy", pre);
    button?.addEventListener("click", () => copyText($("code", pre).textContent, button));
  }

  // ── Example questions: copy, or open TILIK with the question filled in (never sent automatically) ──
  for (const li of $$("#examples li")) {
    const q = li.dataset.q;
    const actions = el("span", "ex-actions");
    const copy = el("button", "", "Copy");
    copy.type = "button";
    copy.addEventListener("click", () => copyText(q, copy));
    const tryIt = el("a", "", "Try →");
    tryIt.href = `/?q=${encodeURIComponent(q)}`;
    actions.append(copy, tryIt);
    li.append(el("span", "ex-text", q), actions);
  }

  // ── Code tabs ──
  for (const box of $$("[data-tabs]")) {
    const tabs = $$("[data-tab]", box);
    for (const tab of tabs) {
      tab.addEventListener("click", () => {
        for (const t of tabs) t.setAttribute("aria-selected", String(t === tab));
        for (const panel of $$("[data-panel]", box)) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
      });
    }
  }

  // ── Contents: highlight the section being read; a drawer on phones ──
  const links = new Map($$(".docs-sidebar a").map((a) => [a.hash.slice(1), a]));
  const sections = $$(".doc");
  const onLine = new Set();
  const spy = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) onLine.add(e.target.id);
      else onLine.delete(e.target.id);
    }
    const current = sections.find((s) => onLine.has(s.id))?.id;
    if (!current) return;
    for (const [id, a] of links) {
      if (id === current) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    }
  }, { rootMargin: "-30% 0px -60% 0px" });
  for (const s of sections) spy.observe(s);

  const tocButton = $("[data-toc]");
  const backdrop = $(".docs-backdrop");
  const setToc = (open) => {
    document.body.classList.toggle("toc-open", open);
    backdrop.hidden = !open;
    tocButton.setAttribute("aria-expanded", String(open));
  };
  tocButton.addEventListener("click", () => setToc(!document.body.classList.contains("toc-open")));
  backdrop.addEventListener("click", () => setToc(false));
  for (const a of links.values()) a.addEventListener("click", () => setToc(false));
  addEventListener("keydown", (e) => { if (e.key === "Escape") setToc(false); });

  // ── Search: dims contents entries that don't match; Enter jumps to the first section that does ──
  const search = $("#docs-search-input");
  const empty = $("#docs-search-empty");
  const index = sections.map((s) => ({ id: s.id, text: s.textContent.toLowerCase() }));
  let firstHit = null;
  search.addEventListener("input", () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = new Set(index.filter((s) => words.every((w) => s.text.includes(w))).map((s) => s.id));
    firstHit = words.length ? sections.find((s) => hits.has(s.id)) ?? null : null;
    for (const [id, a] of links) a.classList.toggle("dim", words.length > 0 && !hits.has(id));
    empty.hidden = !words.length || hits.size > 0;
  });
  search.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !firstHit) return;
    e.preventDefault();
    firstHit.scrollIntoView({ block: "start" });
    firstHit.classList.add("hit");
    setTimeout(() => firstHit?.classList.remove("hit"), 1600);
  });
  addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
    if (e.key === "/" && !typing) { e.preventDefault(); search.focus(); }
  });

  // ── Live source status (booleans only, from /health) ──
  (async () => {
    try {
      const res = await fetch("/health", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const { tools = {} } = await res.json();
      for (const card of $$(".source-card[data-tool]")) {
        const on = tools[card.dataset.tool];
        const dot = $(".dot", card);
        if (typeof on !== "boolean") continue;
        dot.classList.add(on ? "on" : "off");
        dot.setAttribute("title", on ? "Set up on this server" : "Not set up on this server");
      }
      $("#status-when").textContent = `(checked ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`;
    } catch {
      $("#status-when").textContent = "(status unavailable)";
    }
  })();
})();
