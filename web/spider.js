// A procedural spider (cyan legs, pink joints, blue body) that crawls over the landing page.
// Mouse: it follows the cursor. Touch / no cursor: it wanders. Purely decorative: never takes clicks.
(() => {
  "use strict";
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const canvas = document.createElement("canvas");
  canvas.className = "spider-canvas";
  canvas.setAttribute("aria-hidden", "true");
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");

  let W = 0, H = 0;
  const resize = () => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    W = innerWidth;
    H = innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  addEventListener("resize", resize);
  resize();

  const S = W < 640 ? 0.72 : 1; // smaller on phones
  const COLOR = { leg: "#38D6F5", joint: "#FF4D8D", body: "#4B5BFF", core: "#38D6F5" };
  const L1 = 44 * S, L2 = 56 * S; // thigh, shin
  const REACH = 80 * S; // foot distance from the body when resting
  const STEP = 30 * S; // how far a foot may lag before it steps
  const STEP_TIME = 0.15; // seconds per step

  const dir = (a) => ({ x: Math.cos(a), y: Math.sin(a) });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  const body = { x: W * 0.78, y: H * 0.68, a: Math.PI * 1.1, speed: 0 };
  // Four legs per side, front to back; legs alternate in two groups so the spider always stands on half of them.
  const legs = [];
  for (const side of [-1, 1]) {
    [0.55, 1.15, 1.95, 2.55].forEach((rel, k) => legs.push({ side, rel: side * rel, group: (k + (side > 0 ? 1 : 0)) % 2, foot: null, step: null }));
  }
  const hipOf = (leg) => { const d = dir(body.a + leg.rel); return { x: body.x + d.x * 9 * S, y: body.y + d.y * 9 * S }; };
  const idealOf = (leg, lead = 0) => {
    const d = dir(body.a + leg.rel), f = dir(body.a);
    return { x: body.x + d.x * REACH + f.x * lead, y: body.y + d.y * REACH + f.y * lead };
  };
  for (const leg of legs) leg.foot = idealOf(leg);

  let mouse = null;
  addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") mouse = { x: e.clientX, y: e.clientY }; }, { passive: true });
  document.documentElement.addEventListener("mouseleave", () => { mouse = null; });
  let target = { x: body.x, y: body.y };
  let nextWander = 0;

  const update = (t, dt) => {
    // Where to go: the cursor, or a new random spot every few seconds.
    if (mouse) target = mouse;
    else if (t > nextWander || dist(body, target) < 40) {
      target = { x: 90 + Math.random() * Math.max(1, W - 180), y: 130 + Math.random() * Math.max(1, H - 220) };
      nextWander = t + 4 + Math.random() * 4;
    }
    const want = Math.atan2(target.y - body.y, target.x - body.x);
    let turn = want - body.a;
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    body.a += Math.max(-3.2 * dt, Math.min(3.2 * dt, turn));
    const away = dist(body, target);
    const desired = away > 70 * S ? Math.min(210 * S, away * 1.4) * Math.max(0.2, Math.cos(turn)) : 0;
    body.speed += (desired - body.speed) * Math.min(1, dt * 4);
    const f = dir(body.a);
    body.x += f.x * body.speed * dt;
    body.y += f.y * body.speed * dt;

    // Legs: a foot that falls too far behind steps to a new spot a little ahead (one group at a time).
    const stepping = new Set(legs.filter((l) => l.step).map((l) => l.group));
    for (const leg of legs) {
      if (leg.step) {
        leg.step.t += dt / STEP_TIME;
        const k = Math.min(1, leg.step.t), e = k * k * (3 - 2 * k);
        leg.foot = { x: leg.step.from.x + (leg.step.to.x - leg.step.from.x) * e, y: leg.step.from.y + (leg.step.to.y - leg.step.from.y) * e };
        leg.lift = Math.sin(Math.PI * k);
        if (k >= 1) { leg.step = null; leg.lift = 0; }
      } else if (dist(leg.foot, idealOf(leg)) > STEP && !stepping.has(1 - leg.group)) {
        leg.step = { from: { ...leg.foot }, to: idealOf(leg, Math.min(26 * S, body.speed * 0.22)), t: 0 };
        stepping.add(leg.group);
      }
    }
  };

  const dot = (p, r) => { ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); };
  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 2 * S;
    ctx.lineCap = "round";
    for (const leg of legs) {
      // Two-segment IK: the knee bends outward, and higher while the foot is in the air.
      const hip = hipOf(leg), foot = leg.foot;
      const d = Math.max(Math.abs(L1 - L2) + 1, Math.min(L1 + L2 - 1, dist(hip, foot)));
      const base = Math.atan2(foot.y - hip.y, foot.x - hip.x);
      const bend = Math.acos((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)) * (1 + (leg.lift || 0) * 0.25);
      const knee = { x: hip.x + Math.cos(base - leg.side * bend) * L1, y: hip.y + Math.sin(base - leg.side * bend) * L1 };
      ctx.strokeStyle = COLOR.leg;
      ctx.beginPath();
      ctx.moveTo(hip.x, hip.y);
      ctx.lineTo(knee.x, knee.y);
      ctx.lineTo(foot.x, foot.y);
      ctx.stroke();
      ctx.fillStyle = COLOR.joint;
      dot({ x: (hip.x + knee.x) / 2, y: (hip.y + knee.y) / 2 }, 2.6 * S);
      dot(knee, 4.6 * S);
      dot({ x: (knee.x + foot.x) / 2, y: (knee.y + foot.y) / 2 }, 2.6 * S);
      dot(foot, 4 * S);
    }
    // Body: a tilted frame with a glowing core, like the reference.
    ctx.save();
    ctx.translate(body.x, body.y);
    ctx.rotate(body.a);
    ctx.fillStyle = "rgba(75, 91, 255, 0.18)";
    ctx.strokeStyle = COLOR.body;
    ctx.lineWidth = 2.6 * S;
    ctx.beginPath();
    ctx.rect(-26 * S, -12 * S, 52 * S, 24 * S);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLOR.core;
    ctx.shadowColor = COLOR.core;
    ctx.shadowBlur = 12;
    dot({ x: 13 * S, y: 0 }, 6 * S);
    ctx.restore();
  };

  let last = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(now / 1000, dt);
    draw();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();
