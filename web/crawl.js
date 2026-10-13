// TILIK crawler: a tentacled crawler walks a question's sources one cluster at a time,
// reading words, linking claims to sources and flagging vague ones. Purely a visual demo.
(() => {
  "use strict";

  // ---------- Content: one cluster per source (word or word:kind) ----------
  const SECTIONS = [
    { id: "question", short: "QST", color: "#f3e9dc", sub: "what · where · today", pos: [1520, 520],
      words: "what is moving on robinhood chain today which pools:claim have real liquidity:claim and who:owner builds there show me the sources:source please keep it short:spec now:vague" },
    { id: "web", short: "WEB", color: "#2fe6cf", sub: "docs · launches · posts", pos: [960, 300],
      words: "docs launch mainnet:claim announcement bridge:source testnet faucet explorer:source blog:source ecosystem partners:owner roadmap fees:claim wallet setup guide stablecoin:claim listing integrations:owner sdk tutorial soon:vague official:source" },
    { id: "code", short: "COD", color: "#ff2e93", sub: "repos · commits · contracts", pos: [500, 760],
      words: "repo commits contracts:claim router factory pair pool:claim swap:claim deploy:claim audit:source tests:spec readme license fork:vague stars issues:owner pull maintainers:owner release:claim changelog:source abi verified:source solidity foundry hardhat typescript client indexer subgraph:source events logs schema docs:source examples ci" },
    { id: "news", short: "NEW", color: "#ffb21e", sub: "headlines · dates · outlets", pos: [1080, 1200],
      words: "robinhood chain launch:claim partners:owner tokenized stocks:claim layer arbitrum:source orbit rollup report:source analysts:owner rumor:vague exchange listing regulators:owner europe access users wallets:claim fees growth:vague builders grants:claim hackathon interview:source ceo:owner statement:source date published:spec updated outlet:source wire:source desk:source journal:source blog post thread:vague recap weekly sources:source quotes:claim" },
    { id: "chain", short: "CHN", color: "#33f07a", sub: "blocks · pools · swaps", pos: [1500, 940],
      words: "block:source height gas txs:claim pool:claim WETH USDG swap:claim reserves:claim liquidity:claim factory:source router pair price:claim fee tick volume:claim holders:owner contract:source verified:source events logs rpc:source latest finalized:spec" },
    { id: "markets", short: "MKT", color: "#b44dff", sub: "price · volume · depth", pos: [420, 1260],
      words: "price:claim volume:claim depth spread tvl:claim 24h change:claim high low candles trend:vague pump:vague dex:source pairs listed:claim market cap" },
    { id: "verify", short: "VER", color: "#ff4b2b", sub: "cite · cross-check · flag", pos: [940, 760],
      words: "cite:source cross-check:spec match:claim conflict:vague outdated:vague confirm:claim source:source date:spec owner:owner flag:vague ask:spec drop:vague keep:claim answer:spec" },
  ];
  const R = 190; // cluster radius in world units
  for (const s of SECTIONS) s.list = s.words.split(" ").map((w) => { const [word, kind] = w.split(":"); return { word, kind }; });
  const TOTAL = SECTIONS.reduce((n, s) => n + s.list.length, 0);
  const CREAM = [243, 233, 220];
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (const s of SECTIONS) s.rgb = rgb(s.color);
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // ---------- Seeded world ----------
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;

  const linkUp = (pts, maxD, k) => {
    const edges = [];
    for (let i = 0; i < pts.length; i++) {
      const near = [];
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue;
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
        if (d < maxD) near.push([d, j]);
      }
      near.sort((a, b) => a[0] - b[0]);
      for (const [, j] of near.slice(0, k)) if (i < j) edges.push([i, j]);
    }
    return edges;
  };

  for (const s of SECTIONS) {
    const lobes = [...Array(7)].map(() => ({ x: s.pos[0] + gauss() * R * 0.75, y: s.pos[1] + gauss() * R * 0.75, r: R * (0.7 + rnd() * 0.6) }));
    s.nodes = [...Array(950)].map(() => {
      const l = lobes[Math.floor(rnd() * lobes.length)];
      return { x: l.x + gauss() * l.r, y: l.y + gauss() * l.r, big: rnd() < 0.05 };
    });
    s.edges = linkUp(s.nodes, 30, 3);
    // The order in which nodes light up while the section is read.
    const order = s.nodes.map((_, i) => i).sort(() => rnd() - 0.5);
    order.forEach((n, rank) => (s.nodes[n].rank = rank));
  }
  const dust = [...Array(2600)].map(() => ({ x: -300 + rnd() * 2600, y: -200 + rnd() * 1900 }));
  const dustEdges = linkUp(dust, 48, 2);

  // ---------- Canvas + camera ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $("world"), ctx = canvas.getContext("2d");
  let W = 0, H = 0;
  const fit = (c, cx) => {
    const r = c.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return r;
  };
  const cam = { x: 1000, y: 800, z: 0.5 };
  const toScreen = (p) => ({ x: (p.x - cam.x) * cam.z + W / 2, y: (p.y - cam.y) * cam.z + H / 2 });

  // ---------- Run state ----------
  let state;
  const reset = () => {
    state = {
      idx: 0, phase: "walk", t: 0, clock: 0, frame: 0,
      read: SECTIONS.map(() => 0), links: 0, flags: 0, kinds: { claim: 0, source: 0, owner: 0 },
      tags: [], squares: [], trail: [], log: [], stamps: [],
      crawler: { x: 1900, y: 300, a: 0 }, from: { x: 1900, y: 300 }, next: 0, codeChars: 0,
    };
    for (const s of SECTIONS) s.tentacles = null;
    pushLog("walk", "→ " + SECTIONS[0].id, "c0");
  };

  const pushLog = (verb, word, color) => {
    const d = new Date();
    state.log.unshift({ time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`, verb, word, color });
    state.log.length = Math.min(state.log.length, 16);
  };

  // A free node for a word tag: not on top of another tag of the same section.
  const spotFor = (s) => {
    let best = null;
    for (let tries = 0; tries < 30; tries++) {
      const n = s.nodes[Math.floor(Math.random() * s.nodes.length)];
      if (Math.hypot(n.x - s.pos[0], n.y - s.pos[1]) > R * 1.15) continue;
      const clash = state.tags.some((t) => t.sec === s && Math.abs(t.x - n.x) < 70 && Math.abs(t.y - n.y) < 14);
      if (!clash) return n;
      best = n;
    }
    return best || s.nodes[0];
  };

  const readWord = () => {
    const s = SECTIONS[state.idx], item = s.list[state.read[state.idx]];
    state.read[state.idx]++;
    state.stamps.push(state.clock);
    const n = spotFor(s);
    const flagged = item.kind === "vague";
    state.tags.push({ sec: s, x: n.x, y: n.y, text: item.kind ? `${item.word} · ${item.kind}` : item.word, flagged, born: state.clock });
    state.crawler.goal = { x: s.pos[0] + (n.x - s.pos[0]) * 0.55, y: s.pos[1] + (n.y - s.pos[1]) * 0.55 };
    if (flagged) {
      state.flags++;
      pushLog("flag", item.word, `c${state.idx}`);
      state.squares.push({ x: n.x + gauss() * 60, y: n.y + gauss() * 60, size: 6 + Math.random() * 7, born: state.clock, red: true });
    } else if (item.kind) {
      state.links++;
      if (state.kinds[item.kind] !== undefined) state.kinds[item.kind]++;
      pushLog("link", item.word, `c${state.idx}`);
    } else pushLog("read", item.word, `c${state.idx}`);
    if (Math.random() < 0.35) {
      const a = Math.random() * Math.PI * 2, d = R * (1.1 + Math.random() * 1.4);
      state.squares.push({ x: state.crawler.x + Math.cos(a) * d, y: state.crawler.y + Math.sin(a) * d, size: 6 + Math.random() * 9, born: state.clock });
    }
    if (state.squares.length > 46) state.squares.shift();
  };

  const startWalk = () => {
    const s = SECTIONS[state.idx];
    state.phase = "walk";
    state.t = 0;
    state.from = { x: state.crawler.x, y: state.crawler.y };
    state.trail = [];
    pushLog("walk", "→ " + s.id, `c${state.idx}`);
  };

  const step = (dt) => {
    state.clock += dt;
    state.frame++;
    const c = state.crawler;
    if (state.phase === "walk") {
      const s = SECTIONS[state.idx];
      state.t = Math.min(1, state.t + dt / 1.7);
      const e = state.t < 0.5 ? 2 * state.t * state.t : 1 - (-2 * state.t + 2) ** 2 / 2;
      const to = { x: s.pos[0], y: s.pos[1] + R * 0.25 };
      const mid = { x: (state.from.x + to.x) / 2 + (to.y - state.from.y) * 0.35, y: (state.from.y + to.y) / 2 - (to.x - state.from.x) * 0.35 };
      const px = (1 - e) ** 2 * state.from.x + 2 * (1 - e) * e * mid.x + e * e * to.x;
      const py = (1 - e) ** 2 * state.from.y + 2 * (1 - e) * e * mid.y + e * e * to.y;
      c.a = Math.atan2(py - c.y, px - c.x) || c.a;
      c.x = px; c.y = py;
      state.trail.push({ x: px, y: py });
      if (state.t >= 1) { state.phase = "read"; state.next = state.clock + 0.25; state.trailEnd = state.clock; }
    } else if (state.phase === "read") {
      const s = SECTIONS[state.idx];
      if (state.clock >= state.next) {
        if (state.read[state.idx] < s.list.length) {
          readWord();
          state.next = state.clock + 0.07 + Math.random() * 0.11;
        } else if (state.idx < SECTIONS.length - 1) {
          state.idx++;
          startWalk();
        } else {
          state.phase = "ship";
          state.shipAt = state.clock;
          state.crawler.goal = { x: 940, y: 760 };
          pushLog("walk", "→ answer", "c0");
        }
      }
    } else if (state.phase === "ship" && state.clock - state.shipAt > 7) reset();
    if (c.goal && state.phase !== "walk") {
      const k = 1 - Math.exp(-dt * 1.6);
      c.x += (c.goal.x - c.x) * k;
      c.y += (c.goal.y - c.y) * k;
    }
    // Camera: close on the crawler while working, wide for the final overview.
    const near = Math.min(W, H) * 0.36 / R;
    let tx = c.x, ty = c.y, tz = state.phase === "walk" ? near * 0.82 : near;
    if (state.phase === "read") { const s = SECTIONS[state.idx]; tx = (s.pos[0] * 2 + c.x) / 3; ty = (s.pos[1] * 2 + c.y) / 3; }
    if (state.phase === "ship") { tx = 980; ty = 770; tz = Math.min(W / 2050, H / 1550); }
    const k = 1 - Math.exp(-dt * 2.2);
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;
    cam.z += (tz - cam.z) * k;
    state.stamps = state.stamps.filter((t) => state.clock - t < 4);
    state.codeChars += dt * 38;
  };

  // ---------- Drawing ----------
  const sectionState = (i) => (state.phase === "ship" || i < state.idx ? "done" : i === state.idx ? (state.phase === "read" ? "on" : "next") : "queued");

  const drawCluster = (s, i) => {
    const st = sectionState(i);
    const lit = st === "done" ? s.nodes.length : st === "on" ? Math.floor((s.nodes.length * state.read[i]) / s.list.length) : 0;
    const col = s.rgb, active = st === "on";
    const batches = [[false, rgba(CREAM, active ? 0.22 : 0.16), rgba(CREAM, 0.5)], [true, rgba(col, active ? 0.5 : 0.3), rgba(col, active ? 1 : 0.75)]];
    for (const [isLit, edgeC, nodeC] of batches) {
      if (isLit && !lit) continue;
      ctx.strokeStyle = edgeC;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (const [a, b] of s.edges) {
        const A = s.nodes[a], B = s.nodes[b];
        if ((A.rank < lit && B.rank < lit) !== isLit) continue;
        const p = toScreen(A), q = toScreen(B);
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
      ctx.fillStyle = nodeC;
      for (const n of s.nodes) {
        if ((n.rank < lit) !== isLit) continue;
        const p = toScreen(n);
        if (p.x < -4 || p.y < -4 || p.x > W + 4 || p.y > H + 4) continue;
        const r = n.big ? 2.4 : 1.2;
        ctx.fillRect(p.x - r / 2, p.y - r / 2, r, r);
      }
    }
    // Section label above the cluster.
    const top = toScreen({ x: s.pos[0], y: s.pos[1] - R * 1.08 });
    ctx.textAlign = "center";
    ctx.fillStyle = st === "queued" ? rgba(CREAM, 0.75) : s.color;
    ctx.font = `700 ${active ? 17 : 13}px "JetBrains Mono", monospace`;
    ctx.fillText(s.id, top.x, top.y);
    ctx.font = '400 10px "JetBrains Mono", monospace';
    ctx.fillStyle = rgba(CREAM, 0.4);
    const label = st === "done" ? "done" : st === "on" ? "reading" : "queued";
    ctx.fillText(`${state.read[i]}/${s.list.length} words · ${label}`, top.x, top.y + 14);
  };

  const drawGlow = (s, strength) => {
    const p = toScreen({ x: s.pos[0], y: s.pos[1] }), r = R * 1.5 * cam.z;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    g.addColorStop(0, rgba(s.rgb, 0.28 * strength));
    g.addColorStop(1, rgba(s.rgb, 0));
    ctx.fillStyle = g;
    ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
  };

  const drawTags = () => {
    ctx.font = '500 11px "JetBrains Mono", monospace';
    ctx.textAlign = "left";
    const ship = state.phase === "ship";
    for (const t of state.tags) {
      const i = SECTIONS.indexOf(t.sec);
      if (!ship && i !== state.idx) continue;
      const p = toScreen(t);
      const age = state.tags.length - state.tags.indexOf(t);
      const w = ctx.measureText(t.text).width + 10, h = 16;
      const fresh = Math.min(1, (state.clock - t.born) / 0.18);
      ctx.globalAlpha = (ship ? 0.8 : age > 16 ? 0.35 : 1) * fresh;
      ctx.fillStyle = t.flagged ? "#ff2e93" : "rgba(12,9,7,0.82)";
      ctx.fillRect(p.x, p.y - h / 2, w, h);
      ctx.strokeStyle = t.flagged ? "#ff2e93" : t.sec.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x + 0.5, p.y - h / 2 + 0.5, w - 1, h - 1);
      ctx.fillStyle = t.flagged ? "#fff" : t.sec.color;
      ctx.fillText(t.text, p.x + 5, p.y + 4);
    }
    ctx.globalAlpha = 1;
  };

  const drawSquares = () => {
    for (const q of state.squares) {
      const age = state.clock - q.born, p = toScreen(q);
      const a = Math.min(1, age * 4) * (age > 9 ? Math.max(0, 1 - (age - 9)) : 1) * (0.75 + 0.25 * Math.sin(age * 9));
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      ctx.fillStyle = q.red ? "#ff3b3b" : "#ffe11a";
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 10;
      ctx.fillRect(p.x - q.size / 2, p.y - q.size / 2, q.size, q.size);
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  };

  const drawTrail = () => {
    if (state.trail.length < 2) return;
    const s = SECTIONS[state.idx];
    const fade = state.phase === "walk" ? 1 : Math.max(0, 1 - (state.clock - state.trailEnd) / 5);
    if (fade <= 0) return;
    ctx.strokeStyle = rgba(s.rgb, 0.85 * fade);
    ctx.lineWidth = 2;
    ctx.shadowColor = s.color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    state.trail.forEach((pt, i) => { const p = toScreen(pt); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
    ctx.stroke();
    ctx.shadowBlur = 0;
  };

  const TENTACLES = 22, LEGS = 16;
  const drawCrawler = () => {
    const c = state.crawler, s = SECTIONS[Math.min(state.idx, SECTIONS.length - 1)];
    const color = state.phase === "ship" ? "#33f07a" : s.color;
    const p = toScreen(c), k = Math.max(0.5, Math.min(1.05, cam.z * 0.8)), T = state.clock;
    const rx = 22 * k, ry = 28 * k;

    // Long dotted feelers to the newest tags.
    if (state.phase === "read") {
      ctx.setLineDash([2, 5]);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      for (const t of state.tags.filter((t) => t.sec === s).slice(-5)) {
        const q = toScreen(t);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.quadraticCurveTo((p.x + q.x) / 2 + 20, (p.y + q.y) / 2 - 20, q.x, q.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Tentacles: long, curling, each ending in a bead; legs: short bristles all around.
    ctx.lineCap = "round";
    for (let i = 0; i < TENTACLES + LEGS; i++) {
      const leg = i >= TENTACLES;
      const base = (i / (leg ? LEGS : TENTACLES)) * Math.PI * 2 + (leg ? 0.14 : 0) + Math.sin(T * 1.3 + i) * 0.08;
      const len = (leg ? 12 + 6 * Math.sin(T * 6 + i * 2) : 44 + 20 * Math.sin(T * 0.9 + i * 1.7)) * k;
      const sx = p.x + Math.cos(base) * rx, sy = p.y + Math.sin(base) * ry;
      const ex = sx + Math.cos(base) * len, ey = sy + Math.sin(base) * len;
      const bend = Math.sin(T * 2.2 + i) * 14 * k;
      ctx.strokeStyle = leg ? rgba(rgb(color), 0.9) : "rgba(225,255,235,0.8)";
      ctx.lineWidth = leg ? 1.6 : 1.1;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo((sx + ex) / 2 - Math.sin(base) * bend, (sy + ey) / 2 + Math.cos(base) * bend, ex, ey);
      ctx.stroke();
      ctx.fillStyle = leg ? color : "#ffffff";
      ctx.beginPath();
      ctx.arc(ex, ey, (leg ? 1.6 : 2.2) * k, 0, Math.PI * 2);
      ctx.fill();
    }

    // Body: a glowing shell with a mesh, a magenta core and a small head.
    ctx.save();
    ctx.translate(p.x, p.y);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, ry * 2.4);
    g.addColorStop(0, rgba(rgb(color), 0.35));
    g.addColorStop(1, rgba(rgb(color), 0));
    ctx.fillStyle = g;
    ctx.fillRect(-ry * 2.4, -ry * 2.4, ry * 4.8, ry * 4.8);
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(8,30,28,0.85)";
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = rgba(rgb(color), 0.45);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let x = -rx; x <= rx; x += 5 * k) { ctx.moveTo(x, -ry); ctx.lineTo(x, ry); }
    for (let y = -ry; y <= ry; y += 5 * k) { ctx.moveTo(-rx, y); ctx.lineTo(rx, y); }
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.ellipse(0, ry + 9 * k, 8 * k, 7 * k, 0, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(225,255,235,0.85)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.rotate(Math.PI / 4 + Math.sin(T * 2) * 0.25);
    ctx.fillStyle = "#ff2e93";
    ctx.shadowColor = "#ff2e93";
    ctx.shadowBlur = 16;
    const d = 7 * k;
    ctx.fillRect(-d, -d, d * 2, d * 2);
    ctx.restore();

    ctx.fillStyle = color;
    ctx.font = '500 11px "JetBrains Mono", monospace';
    ctx.textAlign = "left";
    ctx.fillText(`crawler · ${state.phase === "ship" ? "answer" : s.id}`, p.x + rx + 34 * k, p.y + ry + 6 * k);
  };

  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    // Background dust network.
    ctx.strokeStyle = "rgba(243,233,220,0.07)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (const [a, b] of dustEdges) { const p = toScreen(dust[a]), q = toScreen(dust[b]); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
    ctx.stroke();
    ctx.fillStyle = "rgba(243,233,220,0.4)";
    for (const n of dust) { const p = toScreen(n); ctx.fillRect(p.x - 0.8, p.y - 0.8, 1.6, 1.6); }

    SECTIONS.forEach((s, i) => {
      const st = sectionState(i);
      if (st === "on") drawGlow(s, 1);
      else if (st === "done") drawGlow(s, state.phase === "ship" ? 0.55 : 0.25);
    });
    ctx.globalCompositeOperation = "lighter";
    SECTIONS.forEach(drawCluster);
    ctx.globalCompositeOperation = "source-over";
    drawTrail();
    drawSquares();
    drawTags();
    drawCrawler();
  };

  // ---------- Dashboard ----------
  const tabs = $("tabs"), secList = $("sections"), heat = $("heat");
  tabs.innerHTML = [...SECTIONS.map((s) => s.id), "answer"].map((n) => `<span>${n}</span>`).join("");
  secList.innerHTML = SECTIONS.map(() => "<li><span></span><span></span><i></i></li>").join("");
  heat.innerHTML = SECTIONS.map((s) => `<div><span>${s.short}</span>${"<i></i>".repeat(12)}</div>`).join("");
  SECTIONS.forEach((s, i) => secList.children[i].style.setProperty("--c", s.color));
  $("sec-count").textContent = String(SECTIONS.length);
  $("heat-total").textContent = String(TOTAL);
  $("kinds").innerHTML = ["claims", "sources", "owners"].map((k) => `<li><span>${k}</span><i></i><b>0</b></li>`).join("");

  const CODE = [
    ["c", "// tilik.ts · reads a question"],
    ["", 'graph = load("asktilik.question")'],
    ["", "spider = Crawler({ legs: 16, tentacles: 22 })"],
    ["", ""],
    ["k", "for (const source of graph.sources)"],
    ["", "  spider.walkTo(source)"],
    ["k", "  for (const word of spider.read())"],
    ["", "    kind = classify(word)"],
    ["k", '    if (kind === "vague") flags.push(word)'],
    ["", "    else cite(word, source)"],
    ["", ""],
    ["", "answer = graph.ship({ guessed: 0 })"],
  ];
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");

  const radar = $("radar"), rctx = radar.getContext("2d");
  const wave = $("wave"), wctx = wave.getContext("2d");
  const gauge = $("gauge"), gctx = gauge.getContext("2d");
  let rBox, wBox, gBox;

  const score = () => Math.round((80 * state.read.reduce((a, b) => a + b, 0)) / TOTAL + (state.phase === "ship" ? 2 : 0));

  const drawRadar = () => {
    const { width: w, height: h } = rBox;
    rctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2 + 2, r = Math.min(w, h) / 2 - 18, n = SECTIONS.length;
    const at = (i, f) => [cx + Math.sin((i / n) * Math.PI * 2) * r * f, cy - Math.cos((i / n) * Math.PI * 2) * r * f];
    rctx.strokeStyle = "rgba(243,233,220,0.12)";
    rctx.lineWidth = 1;
    for (const f of [0.33, 0.66, 1]) {
      rctx.beginPath();
      for (let i = 0; i <= n; i++) { const [x, y] = at(i % n, f); i ? rctx.lineTo(x, y) : rctx.moveTo(x, y); }
      rctx.stroke();
    }
    rctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const j = i % n, [x, y] = at(j, Math.max(0.04, state.read[j] / SECTIONS[j].list.length));
      i ? rctx.lineTo(x, y) : rctx.moveTo(x, y);
    }
    rctx.fillStyle = "rgba(43,217,107,0.85)";
    rctx.fill();
    rctx.strokeStyle = "#33f07a";
    rctx.lineWidth = 1.5;
    rctx.stroke();
    rctx.fillStyle = "rgba(243,233,220,0.55)";
    rctx.font = '400 9px "JetBrains Mono", monospace';
    rctx.textAlign = "center";
    SECTIONS.forEach((s, i) => { const [x, y] = at(i, 1.2); rctx.fillText(s.short, x, y + 3); });
  };

  const drawWave = () => {
    const { width: w, height: h } = wBox;
    wctx.clearRect(0, 0, w, h);
    wctx.strokeStyle = "#ffd21e";
    wctx.lineWidth = 2;
    wctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const y = h / 2 + Math.sin(x / 26 + state.clock * 2.4) * h * 0.22 + Math.sin(x / 11 - state.clock * 1.3) * h * 0.06;
      x ? wctx.lineTo(x, y) : wctx.moveTo(x, y);
    }
    wctx.stroke();
  };

  const drawGauge = () => {
    const { width: w, height: h } = gBox, v = score();
    gctx.clearRect(0, 0, w, h);
    const r = Math.min(w / 2, h / 2) - 8, cx = w / 2, cy = h / 2 + 4;
    const a0 = Math.PI * 0.75, span = Math.PI * 1.5;
    gctx.lineCap = "round";
    gctx.lineWidth = 9;
    gctx.strokeStyle = "rgba(243,233,220,0.08)";
    gctx.beginPath();
    gctx.arc(cx, cy, r, a0, a0 + span);
    gctx.stroke();
    gctx.strokeStyle = v < 40 ? "#ff2e93" : v < 80 ? "#ffd21e" : "#4df0b8";
    gctx.beginPath();
    gctx.arc(cx, cy, r, a0, a0 + (span * v) / 100);
    gctx.stroke();
    gctx.fillStyle = "#f3e9dc";
    gctx.textAlign = "center";
    gctx.font = `800 ${Math.round(r * 0.55)}px "JetBrains Mono", monospace`;
    gctx.fillText(String(v), cx, cy + r * 0.12);
    gctx.font = '400 9px "JetBrains Mono", monospace';
    gctx.fillStyle = "rgba(243,233,220,0.5)";
    gctx.fillText("confidence", cx, cy + r * 0.42);
  };

  let lastDom = 0;
  const updateDom = () => {
    const read = state.read.reduce((a, b) => a + b, 0), active = SECTIONS[state.idx];
    const color = state.phase === "ship" ? "#f3e9dc" : active.color;
    document.documentElement.style.setProperty("--accent", color);
    const wps = state.stamps.length / 4;
    $("stats").innerHTML =
      `<span>SWARM <b>tilik-crawler</b></span><span>LEGS <b>${LEGS}</b></span><span>TENTACLES <b class="g">${TENTACLES}</b></span>` +
      `<span>WORDS READ <b>${read}/${TOTAL}</b></span><span>LINKS <b class="y">${state.links}</b></span><span>FLAGS <b class="p">${state.flags}</b></span>` +
      `<span>T <b class="y">${state.clock.toFixed(2)}</b></span><span>FRAME <b>${state.frame}</b></span>`;
    [...tabs.children].forEach((el, i) => {
      const on = state.phase === "ship" ? i === SECTIONS.length : i === state.idx;
      el.className = on ? "on" : i < state.idx || state.phase === "ship" ? "done" : "";
    });
    const num = state.phase === "ship" ? SECTIONS.length + 1 : state.idx + 1;
    $("title-name").textContent = `${String(num).padStart(2, "0")} ${state.phase === "ship" ? "ANSWER" : active.id.toUpperCase()}`;
    $("title-sub").textContent = state.phase === "ship" ? `${read} words read · ${state.flags} flagged · 0 guessed` : active.sub;

    $("wps").textContent = `${wps.toFixed(0)} w/s`;
    $("log").innerHTML = state.log
      .map((l) => `<li><time>${l.time}</time><span class="v ${l.verb}">${l.verb}</span><span class="${l.color}">${esc(l.word)}</span></li>`)
      .join("");
    SECTIONS.forEach((s, i) => {
      const li = secList.children[i], st = sectionState(i);
      li.className = st === "on" ? "on" : st === "done" ? "done" : "";
      li.children[0].textContent = s.id;
      li.children[1].textContent = `${state.read[i]}/${s.list.length}`;
      li.children[2].style.setProperty("--w", `${(100 * state.read[i]) / s.list.length}%`);
      [...heat.children[i].querySelectorAll("i")].forEach((cell, j) => {
        const filled = (state.read[i] / s.list.length) * 12 > j;
        const hot = !filled && sectionState(i) === "on" && Math.random() < 0.25;
        cell.style.background = filled ? s.color : hot ? "#ff6a3d" : "";
      });
    });
    const kinds = [state.kinds.claim, state.kinds.source, state.kinds.owner];
    [...$("kinds").children].forEach((li, i) => {
      li.querySelector("i").style.setProperty("--w", `${Math.min(100, kinds[i] * 3)}%`);
      li.querySelector("b").textContent = String(kinds[i]);
    });
    $("wpm").textContent = `${Math.round(wps * 60)}/m`;
    $("tally").innerHTML =
      `<dt>read</dt><dd>${read}</dd><dt>linked</dt><dd class="y">${state.links}</dd>` +
      `<dt>flagged</dt><dd class="p">${state.flags}</dd><dt>guessed</dt><dd class="g">0</dd>`;
    $("flags").textContent = `flags to ask · ${state.flags}`;

    // Code panel types itself out, line by line.
    let left = Math.floor(state.codeChars), html = "";
    for (const [cls, line] of CODE) {
      if (left <= 0) break;
      const part = line.slice(0, left);
      left -= line.length + 1;
      html += (cls ? `<span class="${cls}">${esc(part)}</span>` : esc(part)) + (left > 0 ? "\n" : "");
    }
    $("code").innerHTML = html + '<span class="cursor"></span>';
    $("lps").textContent = `${Math.min(CODE.length, Math.ceil(state.codeChars / 30))} l/s`;
  };

  // ---------- Loop ----------
  const resize = () => {
    const r = fit(canvas, ctx);
    W = r.width;
    H = r.height;
    rBox = fit(radar, rctx);
    wBox = fit(wave, wctx);
    gBox = fit(gauge, gctx);
  };
  addEventListener("resize", resize);
  resize();
  reset();
  cam.x = state.crawler.x;
  cam.y = state.crawler.y;
  cam.z = Math.min(W, H) * 0.3 / R;

  let last = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!document.hidden) {
      step(dt);
      draw();
      drawRadar();
      drawWave();
      drawGauge();
      if (now - lastDom > 90) { lastDom = now; updateDom(); }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();
