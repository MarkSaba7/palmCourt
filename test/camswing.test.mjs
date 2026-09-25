// Synthetic-webcam tests for the camera swing detector (src/camswing.js). No webcam, no browser:
//   node test/camswing.test.mjs              run everything, print a report, exit 1 on failure
//   node test/camswing.test.mjs --quick      fewer trials
//   node test/camswing.test.mjs --bench      only the play-session benchmark (precision, recall, fh/bh, delay)
//   node test/camswing.test.mjs --bench --det=path/to/camswing.js   the benchmark against another copy of the detector
// Swings are minimum-jerk arm movements (a wind-up, the stroke, then the arm coming back), seen by a simulated camera
// with frame jitter, dropped frames, motion-blur gaps and processing delay. The same frames also go through a copy of
// the previous detector so the report shows before/after numbers.
const DET = (process.argv.find((a) => a.startsWith('--det=')) || '').slice(6);
const { SwingDetector, judgeCameraSwing, strokeDir, segmentColor, lockColorFromPatch, adaptColor, pickHand, palmSize, hsv, peakTime } =
  await import(DET ? new URL(DET, `file://${process.cwd()}/`).href : '../src/camswing.js');

const QUICK = process.argv.includes('--quick'), BENCH_ONLY = process.argv.includes('--bench');
const WHY = (process.argv.find((a) => a.startsWith('--why=')) || '').slice(6), WHY_N = { n: 0 }, MISS = {}, T0B = {};   // print examples of one kind of false swing
const TRACE = (process.argv.find((a) => a.startsWith('--trace=')) || '').slice(8).split(':').map(Number);   // --trace=session:from:to
const N = QUICK ? 60 : 300;
let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log('  FAIL ' + msg); } return ok; };

// ---- helpers ----
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function gaussR(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const mj = (s) => (s <= 0 ? 0 : s >= 1 ? 1 : s * s * s * (10 - 15 * s + 6 * s * s));
const stats = (a) => { if (!a.length) return { n: 0, mean: NaN, sd: NaN, p10: NaN, p90: NaN }; const m = a.reduce((p, q) => p + q, 0) / a.length; const s = a.slice().sort((p, q) => p - q); return { n: a.length, mean: m, sd: Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / a.length), p10: s[Math.floor(a.length * 0.1)], p90: s[Math.floor(a.length * 0.9)] }; };
const ms = (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 1000)} ms`;
const pct = (a, b) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;

// Piecewise minimum-jerk path through waypoints: segs [{t0, t1, to: {x, y}}] in time order.
function path(start, segs) {
  return (t) => {
    let p = start;
    for (const g of segs) {
      if (t < g.t0) return p;
      if (t < g.t1) { const k = mj((t - g.t0) / (g.t1 - g.t0)); return { x: p.x + (g.to.x - p.x) * k, y: p.y + (g.to.y - p.y) * k }; }
      p = g.to;
    }
    return p;
  };
}

// One stroke with its peak racket speed at time T. kind 'fh' | 'bh', handed 'R' | 'L'.
function makeStroke(kind, T, r, o = {}) {
  const handed = o.handed || 'R', s = handed === 'L' ? -1 : 1;   // mirrored image: a right-hander's forehand side is on the right
  const rest = { x: 0.5 + 0.08 * s, y: 0.55 };
  const amp = o.amp ?? 0.3 + r() * 0.2, D = o.dur ?? 0.22 + r() * 0.14, backDur = o.backDur ?? 0.2 + r() * 0.2, pause = o.pause ?? r() * 0.08;
  const side = kind === 'fh' ? s : -s;     // where the racket is taken back to, relative to rest
  const A = { x: rest.x + side * (kind === 'fh' ? 0.2 : 0.22), y: rest.y + 0.03 };
  const B = { x: A.x - side * amp, y: A.y - 0.06 - r() * 0.06 };
  const f0 = T - D / 2, f1 = T + D / 2, b1 = f0 - pause, b0 = b1 - backDur;
  const segs = [];
  if (o.loop) {
    const mid = { x: (rest.x + A.x) / 2, y: rest.y - 0.2 };
    segs.push({ t0: b0 - 0.12, t1: b0 + backDur * 0.5, to: mid }, { t0: b0 + backDur * 0.5, t1: b1, to: A });
  } else segs.push({ t0: b0, t1: b1, to: A });
  segs.push({ t0: f0, t1: f1, to: B });
  const recDur = 0.35 + r() * 0.35;
  segs.push({ t0: f1 + 0.08, t1: f1 + 0.08 + recDur, to: rest });
  const peak = (1.875 * Math.hypot(B.x - A.x, (B.y - A.y) * 0.75)) / D;
  return { traj: path(rest, segs), T, peak, kind, start: b0 - (o.loop ? 0.12 : 0), end: f1 + 0.08 + recDur, rest };
}

// The camera: frames at fps with timing jitter; each frame is seen (position + tracking jitter) or missing.
// real: when the frame was exposed. cap: its captureTime stamp. pres: when the page gets it. done: tracking finished.
function camera(traj, t0, t1, r, o = {}) {
  const fps = o.fps || 30, jit = o.jitter ?? 0.003, out = [];
  for (let k = 0; ; k++) {
    const real = t0 + k / fps + gaussR(r) * 0.0015;
    if (real > t1) break;
    const p = traj(real);
    const lost = (o.drop && r() < o.drop) || (o.loss || []).some(([a, b]) => real >= a && real <= b);
    const pres = real + 0.05 + (o.presJit ? (r() - 0.5) * o.presJit : 0);
    const f = { real, cap: real + 0.02, pres, done: pres + 0.025 + r() * 0.01, miss: lost, x: p.x + gaussR(r) * jit, y: p.y + gaussR(r) * jit };
    if (o.glitch && r() < o.glitch) { f.x += (r() < 0.5 ? -1 : 1) * (0.2 + r() * 0.15); f.y += (r() - 0.5) * 0.1; }
    out.push(f);
  }
  return out;
}

// New pipeline: detector fed with capture (or presentation) timestamps.
function runNew(frames, o = {}) {
  const d = new SwingDetector(), evs = [], ts = o.ts || 'cap';
  for (const f of frames) {
    const t = f[ts];
    const got = f.miss ? d.miss(t) : d.push(t, f.x, f.y, { handed: o.handed || 'R', aspect: 4 / 3, sens: 1, src: 'hand' });
    for (const e of got) {
      if (e.type === 'swing') e.snap = { peak: e.swing.peak, dir: e.swing.dir, t0: e.swing.t0 };
      evs.push({ ...e, wall: f.done });
    }
  }
  return { evs, det: d };
}

// The previous detector (src/input.js before this change), for comparison. Its timestamps were taken when the frame
// reached the page (pres) and it gave up after 4 missing frames.
function runOld(frames, o = {}) {
  const st = { hist: [], swing: null, lastEnd: -9, vx: 0, vy: 0, speed: 0, missing: 0 }, evs = [];
  const handed = o.handed || 'R';
  for (const f of frames) {
    if (f.miss) { if (++st.missing > 4) { st.hist.length = 0; st.vx = st.vy = st.speed = 0; st.swing = null; } continue; }
    st.missing = 0;
    const t = f.pres, x = f.x, y = f.y, h = st.hist;
    h.push({ t, x, y });
    while (h.length > 2 && t - h[0].t > 0.1) h.shift();
    if (h.length >= 2) { const a = h[0], dt = t - a.t; if (dt > 0.012) { st.vx = (x - a.x) / dt; st.vy = (y - a.y) / dt; } }
    st.speed = Math.hypot(st.vx, st.vy);
    const start = 1.3, stop = 0.55;
    if (!st.swing) {
      if (st.speed > start && t - st.lastEnd > 0.22) {
        st.swing = { t0: t, peak: st.speed, vx: st.vx, vy: st.vy };
        const v = Math.hypot(st.vx, st.vy), dir = Math.abs(st.vx) < 0.55 * v ? null : st.vx * (handed === 'R' ? -1 : 1) > 0 ? 'fh' : 'bh';
        evs.push({ type: 'swing', swing: st.swing, snap: { peak: st.speed, dir, t0: t }, wall: f.done });
      }
    } else {
      const s = st.swing;
      if (st.speed > s.peak) { s.peak = st.speed; s.vx = st.vx; s.vy = st.vy; }
      if (st.speed < stop || t - s.t0 > 0.5) { st.swing = null; st.lastEnd = t; evs.push({ type: 'swingEnd', swing: s, wall: f.done }); }
    }
  }
  return { evs };
}

// What the game does with the swings for a ball whose contact is planned at T (the player's peak racket speed).
function gameNew(evs, T, stroke, latency) {
  for (const e of evs) {
    if (e.type !== 'swing') continue;
    const dt = e.snap.t0 - latency - T, j = judgeCameraSwing(dt, e.snap.dir, stroke);
    if (j === 'hit') return { hit: true, dt, ev: e, mismatch: !!e.snap.dir && e.snap.dir !== stroke };
    if (j === 'late') return { hit: false, why: 'late', dt, ev: e };
  }
  return { hit: false, why: 'none' };
}
function gameOld(evs, T, stroke, latency = 0.09) {
  for (const e of evs) {
    if (e.type !== 'swing') continue;
    const dt = e.snap.t0 - latency - T, mismatch = !!e.snap.dir && e.snap.dir !== stroke;
    if (dt < -0.45 || (mismatch && dt < -0.1)) continue;
    if (dt < -0.3 || dt > 0.2) return { hit: false, why: dt < 0 ? 'early' : 'late', dt, ev: e };
    return { hit: true, dt, ev: e, mismatch };
  }
  return { hit: false, why: 'none' };
}

// =====================================================================
// Play-session benchmark: whole sessions of play (rallies of forehands and backhands, pauses between points, serves)
// by simulated players, seen by a simulated hand or paddle tracker and fed to the detector the way input.js does.
// Players differ in handedness, distance from the camera (scale 0.8-1.5), swing speed and style (straight, looped,
// flowing or early wind-ups, high or wrapped follow-throughs, slices, quick or slow returns to the ready position).
// Between strokes they sway, fidget, adjust, step back to the ready position and touch their face. Trackers add
// jitter, wobble, heavy-tailed outliers, dropped frames, motion-blur losses at speed, one-to-four-frame jumps to the
// other hand or a same-coloured object, 30 or 60 fps and frames skipped while the hand tracker is busy.
// Each swing event is matched to what the player really did: a stroke (true positive, or a double) or something else
// (wind-up, follow-through, return to ready, idle...). Also reported: fh/bh accuracy, when the swing was reported
// relative to the true peak racket speed, the error of its predicted peak time, and what the game makes of it.
// =====================================================================
const ASP = 4 / 3, TOSS_Y = 0.24;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const U = (r, a, b) => a + (b - a) * r();
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// A displacement from 0 to e curving through c (a quadratic Bézier), walked at an even pace along its length.
function curve(e, c) {
  if (!c) return (s) => ({ x: e.x * s, y: e.y * s });
  const q = { x: 2 * c.x - e.x / 2, y: 2 * c.y - e.y / 2 };
  const bz = (u) => ({ x: 2 * u * (1 - u) * q.x + u * u * e.x, y: 2 * u * (1 - u) * q.y + u * u * e.y });
  const M = 40, len = new Float64Array(M + 1);
  for (let i = 1, p = bz(0); i <= M; i++) { const b = bz(i / M); len[i] = len[i - 1] + Math.hypot(b.x - p.x, b.y - p.y); p = b; }
  return (s) => {
    const d = s * len[M];
    let lo = 0, hi = M;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (len[m] < d) lo = m; else hi = m; }
    return bz((lo + (d - len[lo]) / Math.max(1e-12, len[hi] - len[lo])) / M);
  };
}
// Overlapping minimum-jerk movements add up (like a real arm blending one movement into the next).
class Mover {
  constructor() { this.p = []; this.tg = { x: 0, y: 0 }; }
  to(t0, dur, to, via, a = 1) {
    const e = { x: to.x - this.tg.x, y: to.y - this.tg.y }, v = via && { x: via.x - this.tg.x, y: via.y - this.tg.y };
    this.p.push({ t0, t1: t0 + dur, f: curve(e, v), e, a });
    this.tg = { ...to };
    return t0 + dur;
  }
  at(t) {
    let x = 0, y = 0;
    for (const m of this.p) {
      if (t <= m.t0) continue;
      if (t >= m.t1) { x += m.e.x; y += m.e.y; continue; }
      const d = m.f(mj(Math.pow((t - m.t0) / (m.t1 - m.t0), m.a)));
      x += d.x; y += d.y;
    }
    return { x, y };
  }
}

// One player's session. Body units: frame widths at the reference distance (so speeds in them are what the detector
// sees after the palm-size scale); x points to the racket side, y down; all hand positions are relative to rest.
function playSession(i, dur) {
  const r = rng(1000 + i * 7919);
  const src = i % 2 ? 'paddle' : 'hand', fps = (i >> 1) % 2 ? 60 : 30, handed = (i >> 2) % 4 === 3 ? 'L' : 'R', s = handed === 'L' ? -1 : 1;
  const st = r(), speedMul = st < 0.25 ? U(r, 0.55, 0.8) : st < 0.75 ? U(r, 0.8, 1.2) : U(r, 1.2, 1.7);
  const scale = U(r, 0.8, 1.5), k = 1 / scale, lev = src === 'paddle' ? U(r, 1.25, 1.4) : 1;
  const winds = ['straight', 'straight', 'flow', 'loop', 'early'], habit = winds[(r() * winds.length) | 0];
  const c = {
    i, src, fps, handed, speedMul, scale, lev, habit, amp: U(r, 0.75, 1.15), wrap: r() < 0.4 ? 0.6 : 0.1, highFin: r() < 0.5,
    retDur: U(r, 0.45, 0.9) / Math.sqrt(speedMul), pres: r() < 0.15,
    scaleIn: src === 'hand' ? clamp(scale * U(r, 0.92, 1.08), 0.8, 1.5) : 1,
    sigma: src === 'hand' ? U(r, 0.0015, 0.005) : U(r, 0.003, 0.01), wob: src === 'hand' ? U(r, 0.002, 0.005) : U(r, 0.003, 0.008),
    drop: U(r, 0, 0.05), blur: src === 'hand' ? U(r, 0.2, 1) : U(r, 0.3, 1), glitch: src === 'hand' ? U(r, 0, 0.008) : U(r, 0, 0.015),
    proc: src === 'hand' ? [U(r, 0.008, 0.014), U(r, 0.015, 0.028)] : null,
    chest: { x: U(r, 0.44, 0.56), y: U(r, 0.32, 0.4) },
  };
  const H = new Mover(), B = new Mover(), labels = [], strokes = [], serves = [];
  const R0 = { x: 0.12 * s, y: 0.16 };                       // the rest position relative to the chest
  const lab = (t0, t1, what) => labels.push({ t0, t1, what });
  const rest = () => ({ x: U(r, -0.03, 0.03), y: U(r, -0.03, 0.03) });
  const jig = (p, a) => ({ x: p.x * a + U(r, -0.03, 0.03), y: p.y * a + U(r, -0.03, 0.03) });
  const sway = [0, 1, 2].map(() => ({ ax: U(r, 0.003, 0.009), ay: U(r, 0.002, 0.007), f: U(r, 0.15, 1.1), px: r() * 6.3, py: r() * 6.3 }));
  const stroke = (T, kind) => {
    const amp = c.amp * U(r, 0.88, 1.12), slice = r() < 0.12, wind = r() < 0.08 ? 'none' : r() < 0.7 ? c.habit : winds[(r() * winds.length) | 0];
    let A, C, F;
    if (kind === 'fh') { A = { x: 0.3 * s, y: -0.02 }; C = { x: 0.02 * s, y: -0.07 }; F = { x: -0.42 * s, y: c.highFin ? -0.42 : -0.3 }; }
    else { A = { x: -0.38 * s, y: 0 }; C = { x: -0.16 * s, y: -0.06 }; F = { x: 0.26 * s, y: c.highFin ? -0.38 : -0.28 }; }
    if (slice) { A.y = -0.2; C.y = -0.07; F.y = 0.02; }
    if (wind === 'none') A = { ...H.tg };   // no wind-up: swinging straight from where the hand is
    F = jig(F, amp);
    if (wind !== 'none') { A = jig(A, amp); C = jig(C, amp); } else C = { x: A.x + (F.x - A.x) * 0.45, y: A.y + (F.y - A.y) * 0.3 };
    const V = 2.8 * c.speedMul * U(r, 0.85, 1.15), Lp = Math.hypot(C.x - A.x, C.y - A.y) + Math.hypot(F.x - C.x, F.y - C.y);
    const D = clamp((1.875 * Lp) / V, 0.2, 0.7), a = U(r, 0.85, 1.12), f0 = T - D * Math.pow(0.5, 1 / a);
    let b0 = f0;
    if (wind === 'none') { /* straight into the swing */ }
    else if (wind === 'loop') {
      const up = { x: A.x * 0.8, y: A.y - 0.24 * amp }, d1 = U(r, 0.28, 0.45) / Math.sqrt(c.speedMul), d2 = U(r, 0.2, 0.3) / Math.sqrt(c.speedMul), ov = U(r, 0.04, 0.1);
      b0 = f0 + ov - d2 - d1 + 0.05;
      H.to(b0, d1, up, { x: A.x * 0.5, y: -0.16 * amp }); H.to(b0 + d1 - 0.05, d2, A);
    } else if (wind === 'flow') {
      const db = U(r, 0.22, 0.42) / Math.sqrt(c.speedMul), ov = U(r, 0.04, 0.12);
      b0 = f0 + ov - db; H.to(b0, db, A, { x: A.x * 0.5, y: A.y * 0.5 + 0.02 });
    } else if (wind === 'early') {
      const db = U(r, 0.6, 1.0);
      b0 = f0 - U(r, 0.2, 0.5) - db; H.to(b0, db, A);
    } else {
      const db = U(r, 0.28, 0.55) / Math.sqrt(c.speedMul);
      b0 = f0 - U(r, 0, 0.15) - db; H.to(b0, db, A, { x: A.x * 0.5, y: A.y * 0.5 + 0.02 });
    }
    const f1 = H.to(f0, D, F, C, a);
    let r0 = f1 + U(r, 0.05, 0.35);
    if (r() < c.wrap) r0 = H.to(f1 - 0.06, U(r, 0.18, 0.3), { x: F.x - Math.sign(F.x) * 0.09 * amp, y: F.y - 0.08 * amp }) + U(r, 0, 0.15);
    const rd = c.retDur * U(r, 0.8, 1.25);
    let r1;
    if (r() < 0.3) { const m = H.to(r0, rd * 0.5, { x: F.x * 0.6, y: 0.08 }); r1 = H.to(m - 0.05, rd * 0.6, rest()); }
    else r1 = H.to(r0, rd, rest());
    lab(b0, f0, 'windup'); lab(f0, f1, 'stroke'); lab(f1, r0, 'follow'); lab(r0, r1, 'return');
    strokes.push({ kind, f0, f1, T, b0, r1, wind });
    return r1;
  };
  const between = (t0, len) => {
    const t1 = t0 + len;
    lab(t0, t1, 'idle');
    let end = t1;
    let t = t0 + U(r, 0.2, 0.6);
    if (r() < 0.4) {   // a step or two back to the ready position: the whole body moves
      const d = U(r, 0.8, 1.3), dx = (r() < 0.5 ? -1 : 1) * U(r, 0.06, 0.2);
      const x = clamp(B.tg.x + dx, -0.12, 0.12);
      B.to(t, d, { x, y: 0 }, { x: (B.tg.x + x) / 2, y: 0.01 });
      lab(t, t + d, 'walk'); t += d + U(r, 0.1, 0.4); end = Math.max(end, t);
    }
    if (r() < 0.5 && t < t1 - 0.6) {   // fidget: a small quick flick out and back
      const d = U(r, 0.12, 0.25), p = { x: U(r, -0.06, 0.06), y: U(r, -0.05, 0.05) }, back = H.tg;
      H.to(t, d, { x: back.x + p.x, y: back.y + p.y }); H.to(t + d, d * 1.2, back);
      lab(t, t + 2.2 * d, 'fidget'); t += 2.2 * d + U(r, 0.1, 0.4);
    }
    if (r() < 0.4 && t < t1 - 1.2) {   // adjust: the hand settles somewhere else, then back
      const d = U(r, 0.35, 0.8), p = { x: U(r, -0.15, 0.15), y: U(r, -0.1, 0.1) };
      H.to(t, d, p); const t2 = t + d + U(r, 0.3, 0.8); H.to(t2, U(r, 0.4, 0.8), rest());
      lab(t, t2 + 0.8, 'adjust'); t = t2 + 0.9;
    }
    if (r() < 0.15 && t < t1 - 1.8) {   // touch the face
      const d = U(r, 0.45, 0.8), p = { x: -0.14 * s, y: -0.34 };
      H.to(t, d, p, { x: -0.02 * s, y: -0.2 }); const t2 = t + d + U(r, 0.2, 0.6); H.to(t2, d, rest());
      lab(t, t2 + d, 'face'); end = Math.max(end, t2 + d);
    }
    return end;
  };
  const serve = (t) => {
    // The toss gesture: the racket hand up above the toss line, held while the ball goes up, then the serve swing
    // down and across the body, then back to rest.
    const yImg = U(r, 0.07, 0.19), top = { x: 0.05 * s, y: ((yImg / ASP - c.chest.y) / k - R0.y) / lev };
    const du = U(r, 0.35, 0.7), up = H.to(t, du, top, { x: 0.1 * s, y: top.y * 0.5 });
    const tc = t + du * 0.55;          // roughly when it crosses the line (measured exactly below)
    const Ts = up + U(r, 0.55, 0.95);
    const Fs = { x: -0.25 * s, y: 0.1 }, Cs = { x: 0, y: top.y * 0.35 }, V = 2.8 * c.speedMul * U(r, 0.9, 1.2);
    const D = clamp((1.875 * (Math.hypot(Cs.x - top.x, Cs.y - top.y) + Math.hypot(Fs.x - Cs.x, Fs.y - Cs.y))) / V, 0.22, 0.7);
    const sf0 = Ts - D / 2;
    if (r() < 0.5) { H.to(sf0 - 0.25, 0.2, { x: top.x + 0.04 * s, y: top.y - 0.06 }); }   // into the trophy position
    const sf1 = H.to(sf0, D, Fs, Cs);
    const r1 = H.to(sf1 + U(r, 0.1, 0.3), c.retDur * 1.2, rest());
    lab(t, sf0, 'raise'); lab(sf0, sf1, 'serve'); lab(sf1, r1, 'return');
    serves.push({ t, tcNom: tc, f0: sf0, f1: sf1, T: Ts, top: up });
    return r1;
  };
  let t = 1;
  while (t < dur - 8) {
    t = between(t, U(r, 2, 5));
    if (r() < 0.5) t = serve(t + U(r, 0.2, 0.6)) + U(r, 0.3, 0.8);
    const n = 2 + ((r() * 6) | 0);
    let T = t + 1.2;
    for (let j = 0; j < n && T < dur - 3; j++) {
      const kind = r() < 0.55 ? 'fh' : 'bh';
      const end = stroke(T, kind);
      t = end; T += U(r, 1.6, 2.6);
      T = Math.max(T, end + 0.5);
    }
    t += 0.5;
  }
  const total = t + 1.5;
  H.p.sort((p, q) => p.t0 - q.t0); B.p.sort((p, q) => p.t0 - q.t0);
  // The tracked point in frame widths (y in width units too; the detector gets y × aspect, like the real tracker).
  const pos = (t) => {
    const h = H.at(t), b = B.at(t);
    let sx = 0, sy = 0;
    for (const w of sway) { sx += w.ax * Math.sin(6.283 * w.f * t + w.px); sy += w.ay * Math.sin(6.283 * w.f * 1.3 * t + w.py); }
    return { x: c.chest.x + b.x * k + k * (R0.x + lev * (h.x + sx)), y: c.chest.y + b.y * k + k * (R0.y + lev * (h.y + sy)) };
  };
  const speedAt = (t) => { const a = pos(t - 0.002), b = pos(t + 0.002); return Math.hypot(b.x - a.x, b.y - a.y) / 0.004; };
  // True peak times, speeds (as the detector would measure them: image speed × the scale it's given) and the toss-line crossings.
  // (The central part of the forward swing: at its ends the wind-up and follow-through overlap it.) The moment of
  // contact is the middle of the fast part: where the speed is within 20% of its peak, weighted by speed.
  for (const x of [...strokes, ...serves]) {
    let best = 0, bt = x.T;
    const t0 = x.f0 + 0.3 * (x.f1 - x.f0), t1 = x.f1 - 0.1 * (x.f1 - x.f0);
    for (let t = t0; t <= t1; t += 0.002) { const v = speedAt(t); if (v > best) { best = v; bt = t; } }
    let sw = 0, st = 0;
    for (let t = bt; t >= t0 && speedAt(t) >= 0.8 * best; t -= 0.002) { const w = speedAt(t) - 0.8 * best; sw += w; st += w * t; }
    for (let t = bt + 0.002; t <= t1 && speedAt(t) >= 0.8 * best; t += 0.002) { const w = speedAt(t) - 0.8 * best; sw += w; st += w * t; }
    x.T = sw > 0 ? st / sw : bt; x.peak = best * c.scaleIn;
  }
  for (const sv of serves) {
    sv.tc = null;
    for (let t = sv.t; t < sv.f0; t += 0.002) if (pos(t).y * ASP < TOSS_Y) { sv.tc = t; break; }
  }
  return { c, pos, speedAt, labels, strokes, serves: serves.filter((sv) => sv.tc !== null), dur: total };
}

// The tracker's view of a session: frames with timing jitter, busy-worker skips, jitter, wobble, outliers, blur losses
// and jumps to the other hand / a same-coloured object.
function trackSession(S) {
  const c = S.c, r = rng(77 + c.i * 131), out = [], s = c.handed === 'L' ? -1 : 1, k = 1 / c.scale;
  let busy = -1, wx = 0, wy = 0, gl = 0, gp = null;
  const spot = { x: U(r, 0.1, 0.9), y: U(r, 0.15, 0.7) };
  for (let n = 0; ; n++) {
    const real = 0.3 + n / c.fps + gaussR(r) * (c.fps === 60 ? 0.0008 : 0.0015);
    if (real > S.dur) break;
    if (c.proc) { if (real < busy) continue; busy = real + U(r, c.proc[0], c.proc[1]); }
    const t = c.pres ? real + U(r, 0, 0.016) : real + gaussR(r) * 0.0005;
    const vi = S.speedAt(real), rho = Math.exp(-1 / c.fps / 0.15);
    wx = rho * wx + gaussR(r) * c.wob * Math.sqrt(1 - rho * rho); wy = rho * wy + gaussR(r) * c.wob * Math.sqrt(1 - rho * rho);
    const lossP = c.drop + c.blur * sstep(1.8, 5.5, vi) * (c.fps === 60 ? 0.45 : 0.8);
    if (!gl && r() < c.glitch) {
      gl = 1 + ((r() * (c.src === 'hand' ? 3 : 4)) | 0);
      const p = S.pos(real);
      gp = c.src === 'hand' ? { x: p.x - (0.24 + U(r, 0, 0.1)) * s * k, y: p.y + U(r, 0, 0.12) * k } : { x: spot.x + U(r, -0.02, 0.02), y: spot.y / ASP };
    }
    if (gl) { gl--; out.push({ t, x: gp.x + gaussR(r) * c.sigma, y: (gp.y + gaussR(r) * c.sigma) * ASP, glitch: true }); continue; }
    if (r() < lossP) { out.push({ t, miss: true }); continue; }
    const p = S.pos(real), tail = r() < 0.04 ? 3 : 1;
    if (p.x < 0.01 || p.x > 0.99 || p.y * ASP < 0.01 || p.y * ASP > 0.99) { out.push({ t, miss: true }); continue; }   // out of the picture
    out.push({ t, x: p.x + wx + gaussR(r) * c.sigma * tail, y: (p.y + wy + gaussR(r) * c.sigma * tail) * ASP });
  }
  return out;
}

// Feed a session to a detector like input.js does; the game cancels the swing in progress when the ball is tossed.
function runSession(S, frames) {
  const c = S.c, d = new SwingDetector(), evs = [];
  if (WHY === 'miss' && d.classify) { const f = d.classify.bind(d); d.cls = []; d.classify = (m, v, t) => { const r = f(m, v, t); d.cls.push({ t, r }); return r; }; S.det = d; }
  const serving = (t) => S.serves.some((sv) => t >= sv.t && t <= sv.f0);
  const tr = TRACE.length === 3 && TRACE[0] === c.i;
  for (const f of frames) {
    const got = f.miss ? d.miss(f.t) : d.push(f.t, f.x, f.y, { handed: c.handed, aspect: ASP, sens: 1, src: c.src, scale: c.scaleIn });
    if (tr && f.t >= TRACE[1] && f.t <= TRACE[2]) {
      const m = d.mv, h = d.home, lab = S.labels.filter((l) => f.t >= l.t0 && f.t <= l.t1).map((l) => l.what).join('/');
      console.log(`  ${f.t.toFixed(3)} ${f.miss ? 'miss' : `(${f.x.toFixed(3)},${(f.y / ASP).toFixed(3)})${f.glitch ? ' GLITCH' : ''}`} true ${(S.speedAt(f.t) * c.scaleIn).toFixed(2)} ` +
        `v ${d.speed.toFixed(2)} thr ${d.thr.toFixed(2)} fresh ${d.fresh.toFixed(2)} home ${h ? `(${h.x.toFixed(2)},${h.y.toFixed(2)})` : '-'} mv ${m ? `${m.cls || '-'} u(${m.ux.toFixed(2)},${m.uy.toFixed(2)}) x0 (${m.x0.toFixed(2)},${m.y0.toFixed(2)}) n${m.n} vmax ${m.vmax.toFixed(2)}${m.turn ? ' turn' : ''}${m.still ? ' still' : ''}${m.sw ? ' SW' : ''}` : '-'}` +
        `${d.held ? ' HELD' : ''}${m && m.home ? ' mhome' : ''}${d.rec ? ` rec(${d.rec.same ? 'same' : ''}${d.rec.back ? 'back' : ''}${d.rec.home ? 'home' : ''})` : ''} ${lab} ${got.map((e) => e.type + (e.swing ? ' ' + e.swing.dir : '')).join(',')}`);
    }
    for (const e of got) {
      if (e.type === 'swing') evs.push({ type: 'swing', te: f.t, t0: e.swing.t0, dir: e.swing.dir, sw: e.swing, peak0: e.swing.peak });
      else if (e.type === 'toss') { evs.push({ type: 'toss', te: f.t }); if (serving(f.t)) { d.cancel(); d.ended = null; } }
      else if (e.type === 'swingStart') evs.push({ type: 'start', te: f.t, t0: e.t0, dir: e.dir });
    }
  }
  return evs;
}

// The game's verdict on the swings around one incoming ball, whose contact is planned at the stroke's true peak plus
// the player's own timing error (off: seconds).
function gameVerdict(evs, st, off) {
  let early = 0;
  const T = st.T + off;
  for (const e of evs) {
    if (e.type !== 'swing' || e.te < T - 0.9 || e.te > T + 0.6) continue;
    const j = judgeCameraSwing(e.t0 - T, e.dir, st.kind);
    if (j === 'ignore' || j === 'windup') continue;
    if (j === 'early') { early++; continue; }
    if (j === 'late') return { v: 'late', early };
    if (e.match !== st) return { v: 'byOther', early };
    return { v: e.dir && e.dir !== st.kind ? 'wrongDir' : 'hit', early };
  }
  return { v: 'none', early };
}

function newStats() {
  return { sessions: 0, secs: 0, strokes: 0, tp: 0, dup: 0, fp: {}, fpN: 0, dirOk: 0, dirNull: 0, delay: [], t0err: [], game: {}, flash: 0,
    pow: [], serves: 0, serveSw: 0, tossOk: 0, tossLate: 0, tossMiss: 0, tossDup: 0, tossFalse: {}, tossFalseN: 0 };
}
function scoreSession(S, evs, G) {
  const labelAt = (t) => { let best = null; for (const l of S.labels) if (t >= l.t0 - 0.02 && t <= l.t1 + 0.05 && (!best || l.t0 > best.t0)) best = l; return best ? best.what : 'idle'; };
  const sw = evs.filter((e) => e.type === 'swing');
  const ro = rng(5 + S.c.i), all = [...S.strokes.map((x) => ({ ...x, serve: false, off: gaussR(ro) * 0.06 })), ...S.serves.map((x) => ({ ...x, kind: null, serve: true }))];
  for (const x of all) {
    const m = sw.filter((e) => !e.match && e.te >= x.f0 - 0.03 && e.te <= x.T + 0.45 && Math.abs(e.t0 - x.T) <= 0.2);
    m.forEach((e, j) => { e.match = x; e.dup = j > 0; });
    x.ev = m[0] || null;
  }
  for (const g of G) {
    g.sessions++; g.secs += S.dur;
    for (const x of all) {
      if (x.serve) { g.serves++; if (x.ev) g.serveSw++; continue; }
      g.strokes++;
      if (x.wind === 'none') { g.noneN = (g.noneN || 0) + 1; if (x.ev) g.noneTp = (g.noneTp || 0) + 1; }
      if (g === G[0] && WHY === 'miss' && !x.ev && ++WHY_N.n) {
        const near = sw.filter((e) => e.te > x.T - 1 && e.te < x.T + 0.6).map((e) => `[${e.te.toFixed(2)} ${e.dir} t0 ${e.t0.toFixed(2)} pk ${e.peak0.toFixed(1)}]`).join(' ');
        const sp = [-0.2, -0.1, 0, 0.1, 0.2].map((d) => (S.speedAt(x.T + d) * S.c.scaleIn).toFixed(1)).join(' ');
        const cl = S.det ? S.det.cls.filter((q) => q.t > x.f0 - 0.05 && q.t < x.T + 0.3).map((q) => q.r) : [];
        MISS[cl.length ? cl[cl.length - 1] : 'never judged'] = (MISS[cl.length ? cl[cl.length - 1] : 'never judged'] || 0) + 1;
        if (WHY_N.n < (+process.env.WHYN || 14)) console.log(`  missed (${cl.join(' ')}) ${x.kind} session ${S.c.i} ${S.c.src} ${S.c.fps}fps ${x.wind} T ${x.T.toFixed(3)} f0 ${x.f0.toFixed(2)} b0 ${x.b0.toFixed(2)} peak ${x.peak.toFixed(2)} · speed ${sp} · events ${near}`);
      }
      if (x.ev) {
        g.tp++;
        if (x.ev.dir === x.kind) g.dirOk++; else if (!x.ev.dir) g.dirNull++;
        g.delay.push(x.ev.te - x.T); g.t0err.push(x.ev.t0 - x.T);
        if (g === G[0] && WHY === 't0') { (T0B[Math.max(-3, Math.min(2, Math.floor((x.ev.te - x.T) / 0.04)))] ||= []).push(x.ev.t0 - x.T); if (Number.isFinite(x.ev.sw.tPeak)) (T0B.final ||= []).push(x.ev.sw.tPeak - x.T); }
        g.pow.push(x.ev.sw.peak / x.peak);
      }
      const v = gameVerdict(sw, x, x.off);
      g.game[v.v] = (g.game[v.v] || 0) + 1; g.flash += v.early;
    }
    for (const e of sw) {
      if (e.match && !e.dup) continue;
      const what = e.dup ? 'double' : labelAt(e.te);
      g.fp[what] = (g.fp[what] || 0) + 1; g.fpN++;
      if (g === G[0] && WHY && WHY === what && WHY_N.n++ < 12) {
        const near = S.labels.filter((l) => l.t1 > e.te - 1.2 && l.t0 < e.te + 0.5).map((l) => `${l.what} ${l.t0.toFixed(2)}-${l.t1.toFixed(2)}`).join(', ');
        const sp = [-0.2, -0.1, 0, 0.1, 0.2].map((d) => (S.speedAt(e.te + d) * S.c.scaleIn).toFixed(1)).join(' ');
        console.log(`  why ${what}: session ${S.c.i} ${S.c.src} ${S.c.fps}fps ${S.c.habit} at ${e.te.toFixed(3)} dir ${e.dir} t0 ${e.t0.toFixed(3)} peak ${e.peak0.toFixed(2)}/${e.sw.peak.toFixed(2)} role ${e.sw.role} · true speed ${sp} · ${near}`);
      }
    }
    // Tosses: once per serve, soon after the hand passes the line; never anywhere else (a high follow-through).
    const tosses = evs.filter((e) => e.type === 'toss');
    for (const sv of S.serves) {
      const m = tosses.filter((e) => !e.used && e.te >= sv.tc - 0.05 && e.te <= sv.f0 + 0.05);
      m.forEach((e) => (e.used = true));
      if (g === G[0] && WHY === 'toss' && !m.length && WHY_N.n++ < 10) {
        const ys = [0, 0.1, 0.2, 0.3, 0.4].map((d) => (S.pos(sv.tc + d).y * ASP).toFixed(2)).join(' ');
        console.log(`  toss missed: session ${S.c.i} ${S.c.src} crossing ${sv.tc.toFixed(2)} swing ${sv.f0.toFixed(2)} · y ${ys} · events ${evs.filter((e) => e.te > sv.t - 1 && e.te < sv.f1 + 0.3).map((e) => `${e.type} ${e.te.toFixed(2)}${e.dir !== undefined ? ' ' + e.dir : ''}`).join(', ')}`);
      }
      if (!m.length) g.tossMiss++; else { if (m[0].te - sv.tc <= 0.35) g.tossOk++; else g.tossLate++; if (m.length > 1) g.tossDup += m.length - 1; }
    }
    for (const e of tosses) if (!e.used) {
      const w = labelAt(e.te); g.tossFalse[w] = (g.tossFalse[w] || 0) + 1; g.tossFalseN++;
      if (g === G[0] && WHY === 'falsetoss' && w !== 'face' && WHY_N.n++ < 10) console.log(`  false toss: session ${S.c.i} ${S.c.src} at ${e.te.toFixed(2)} (${w}) · ${S.labels.filter((l) => l.t1 > e.te - 1.2 && l.t0 < e.te + 0.3).map((l) => `${l.what} ${l.t0.toFixed(2)}-${l.t1.toFixed(2)}`).join(', ')} · swings ${evs.filter((q) => q.type === 'swing' && q.te > e.te - 1.5 && q.te < e.te).map((q) => `${q.te.toFixed(2)} ${q.dir}`).join(', ')}`);
    }
    for (const e of tosses) delete e.used;
  }
}
const med = (a) => { if (!a.length) return NaN; const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
const q90 = (a) => { if (!a.length) return NaN; const s = a.slice().sort((p, q) => p - q); return s[Math.floor(s.length * 0.9)]; };

function bench() {
  const NS = QUICK ? 32 : 128, dur = QUICK ? 50 : 70, groups = new Map();
  for (const g of ['all', 'hand 30 fps', 'hand 60 fps', 'paddle 30 fps', 'paddle 60 fps', 'near (scale<1)', 'mid distance', 'far (scale>1.25)', 'slow swingers',
    'normal speed', 'fast swingers', 'left-handed', 'wind-up: straight', 'wind-up: flow', 'wind-up: loop', 'wind-up: early', 'noisy tracking', 'heavy motion blur', 'no captureTime']) groups.set(g, newStats());
  const group = (name) => { if (!groups.has(name)) groups.set(name, newStats()); return groups.get(name); };
  const t0 = performance.now();
  for (let i = 0; i < NS; i++) {
    const S = playSession(i, dur), c = S.c, frames = trackSession(S), evs = runSession(S, frames);
    const G = [group('all'), group(`${c.src} ${c.fps} fps`), group(c.scale < 1 ? 'near (scale<1)' : c.scale > 1.25 ? 'far (scale>1.25)' : 'mid distance'),
      group(c.speedMul < 0.8 ? 'slow swingers' : c.speedMul > 1.2 ? 'fast swingers' : 'normal speed'), group(`wind-up: ${c.habit}`)];
    if (c.handed === 'L') G.push(group('left-handed'));
    if (c.pres) G.push(group('no captureTime'));
    if ((c.src === 'hand' && c.sigma > 0.0038) || (c.src === 'paddle' && c.sigma > 0.0075)) G.push(group('noisy tracking'));
    if (c.blur > 0.7) G.push(group('heavy motion blur'));
    scoreSession(S, evs, G);
  }
  const P = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}` : '-').padStart(5);
  console.log(`\nPlay-session benchmark${DET ? ` (detector: ${DET})` : ''}: ${NS} sessions of ${dur} s, ${groups.get('all').strokes} strokes, ${groups.get('all').serves} serves (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  console.log('  recall: strokes reported (t0 within 0.2 s of the true peak, by 0.45 s after it: the game can still rewind) · prec: share of swing events that were real strokes · fh/bh: right direction');
  console.log('  delay: when the event came (frame time) − true peak, median/p90 · t0 err: predicted peak − true peak, mean±sd · game: returned with the right stroke');
  console.log('  group                   strokes recall  prec  fh/bh  null   delay ms  t0 err ms  game  early/100  false swings per 100 strokes (by what the player was doing)');
  for (const [name, g] of groups) {
    const e = g.t0err, m = e.reduce((p, q) => p + q, 0) / Math.max(1, e.length), sd = Math.sqrt(e.reduce((p, q) => p + (q - m) ** 2, 0) / Math.max(1, e.length));
    const fp = Object.entries(g.fp).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${((100 * n) / g.strokes).toFixed(1)}`).join(', ');
    console.log(`  ${name.padEnd(22)} ${String(g.strokes).padStart(6)} ${P(g.tp, g.strokes)} ${P(g.tp, g.tp + g.fpN)} ${P(g.dirOk, g.tp)} ${P(g.dirNull, g.tp)}  ${String(Math.round(med(g.delay) * 1000)).padStart(4)}/${String(Math.round(q90(g.delay) * 1000)).padEnd(4)} ${String(Math.round(m * 1000)).padStart(5)}±${String(Math.round(sd * 1000)).padEnd(4)} ${P(g.game.hit || 0, g.strokes)} ${((100 * g.flash) / g.strokes).toFixed(1).padStart(6)}     ${fp}`);
  }
  const a = groups.get('all'), pw = stats(a.pow);
  console.log(`  strokes without a wind-up: ${a.noneTp || 0}/${a.noneN || 0} reported`);
  console.log(`  game outcomes (all): ${Object.entries(a.game).map(([k, v]) => `${k} ${P(v, a.strokes).trim()}%`).join(', ')}`);
  console.log(`  power: reported peak / true peak ${pw.mean.toFixed(2)} ± ${pw.sd.toFixed(2)}; hand ${stats(groups.get('hand 30 fps').pow.concat(groups.get('hand 60 fps').pow)).sd.toFixed(2)} sd, paddle ${stats(groups.get('paddle 30 fps').pow.concat(groups.get('paddle 60 fps').pow)).sd.toFixed(2)} sd`);
  if (WHY === 'miss') console.log('  misses by last verdict on the stroke:', JSON.stringify(MISS));
  if (WHY === 't0') for (const k of Object.keys(T0B).sort((p, q) => p - q)) {
    if (k === 'final') { const st = stats(T0B[k]); console.log(`  peak time measured after the swing: t0 error ${Math.round(st.mean * 1000)} ± ${Math.round(st.sd * 1000)} ms`); continue; } const st = stats(T0B[k]); console.log(`  reported ${k * 40}..${k * 40 + 40} ms from the peak: ${st.n} strokes, t0 error ${Math.round(st.mean * 1000)} ± ${Math.round(st.sd * 1000)} ms`); }
  console.log(`  serves: toss on time ${a.tossOk}/${a.serves}, late ${a.tossLate}, missed ${a.tossMiss}, twice ${a.tossDup}; serve swing reported ${a.serveSw}/${a.serves}; false tosses ${a.tossFalseN} ${JSON.stringify(a.tossFalse)}`);
  return a;
}
const B = bench();
if (BENCH_ONLY) process.exit(0);

// ---- stroke scenarios ----
const LAT_NEW_CAP = 0.04;    // default timing offset with capture timestamps (see report)
function strokeScenario(name, o = {}) {
  const r = rng(o.seed || 1234);
  const res = { name, n: 0, newHit: 0, oldHit: 0, newRight: 0, dtNew: [], dtOld: [], emit: [], emitOld: [], fwd: [], extra: 0, predRatio: [], finalRatio: [], whyNew: {}, whyOld: {} };
  for (let i = 0; i < N; i++) {
    const kind = o.kind || (i % 2 ? 'bh' : 'fh'), handed = o.handed || 'R';
    const T = 2 + r() * 0.03;
    const st = makeStroke(kind, T, r, { handed, loop: o.loop, amp: o.amp, dur: o.dur, backDur: o.backDur, pause: o.pause });
    const loss = o.blur ? [[T - o.blur / 2, T + o.blur / 2]] : [];
    const frames = camera(st.traj, 0.8, st.end + 0.4, r, { fps: o.fps, drop: o.drop, loss, jitter: o.jitter, presJit: o.presJit, glitch: o.glitch });
    const ts = o.ts || 'cap', lat = ts === 'cap' ? LAT_NEW_CAP : LAT_NEW_CAP + 0.03;
    const nw = runNew(frames, { handed, ts }), od = runOld(frames, { handed });
    const gN = gameNew(nw.evs, T, kind, lat), gO = gameOld(od.evs, T, kind);
    res.n++;
    if (gN.hit) {
      res.newHit++; res.dtNew.push(gN.dt); res.emit.push(gN.ev.wall - T);
      if (gN.ev.snap.dir === kind || (!gN.ev.snap.dir && Math.abs(gN.dt) < 0.12)) res.newRight++;
      res.predRatio.push(gN.ev.snap.peak / st.peak); res.finalRatio.push(gN.ev.swing.peak / st.peak);
    } else res.whyNew[gN.why] = (res.whyNew[gN.why] || 0) + 1;
    if (gO.hit) { res.oldHit++; res.dtOld.push(gO.dt); res.emitOld.push(gO.ev.wall - T); } else res.whyOld[gO.why] = (res.whyOld[gO.why] || 0) + 1;
    // Double swings: more than one swing the stroke's way within the stroke itself.
    const fw = nw.evs.filter((e) => e.type === 'swing' && e.snap.dir === kind && Math.abs(e.snap.t0 - T) < 0.25).length;
    res.fwd.push(fw);
    if (fw > 1) res.extra++;
  }
  return res;
}

function report(r, minHit = 0.97) {
  const dn = stats(r.dtNew), dO = stats(r.dtOld), em = stats(r.emit), eo = stats(r.emitOld), pr = stats(r.predRatio), fr = stats(r.finalRatio);
  console.log(`\n${r.name}`);
  console.log(`  returned:  new ${pct(r.newHit, r.n)}  (right swing ${pct(r.newRight, r.newHit)})   old ${pct(r.oldHit, r.n)}` +
    `   misses new ${JSON.stringify(r.whyNew)} old ${JSON.stringify(r.whyOld)}`);
  console.log(`  timing error (swing time the game uses − true peak):  new ${ms(dn.mean)} ± ${Math.round(dn.sd * 1000)}   old ${ms(dO.mean)} ± ${Math.round(dO.sd * 1000)}`);
  console.log(`  game learns of the swing (wall clock − true peak):   new ${ms(em.mean)} (p90 ${ms(em.p90)})   old ${ms(eo.mean)} (p90 ${ms(eo.p90)})`);
  console.log(`  power estimate / true peak speed: at contact ${pr.mean.toFixed(2)} ± ${pr.sd.toFixed(2)}, after the swing ${fr.mean.toFixed(2)} ± ${fr.sd.toFixed(2)}   double swings ${r.extra}`);
  check(r.newHit / r.n >= minHit, `${r.name}: return rate ${pct(r.newHit, r.n)} < ${pct(minHit, 1)}`);
  check(r.extra / r.n <= 0.01, `${r.name}: ${r.extra} double swings`);
  return r;
}

console.log(`Camera swing detector: ${N} swings per scenario (half forehands, half backhands unless noted), 30 fps unless noted.`);
const all = [];
all.push(report(strokeScenario('Clean swings, right-handed')));
all.push(report(strokeScenario('Backhands only', { kind: 'bh', seed: 77 })));
all.push(report(strokeScenario('Forehands only', { kind: 'fh', seed: 78 })));
all.push(report(strokeScenario('Backhands with a quick wind-up flowing straight into the swing', { kind: 'bh', backDur: 0.16, pause: 0, seed: 79 })));
all.push(report(strokeScenario('Left-handed', { handed: 'L', seed: 5 })));
all.push(report(strokeScenario('Loop backswing (racket taken up and back)', { loop: true, seed: 9 }), 0.95));
all.push(report(strokeScenario('15% dropped frames', { drop: 0.15, seed: 11 })));
all.push(report(strokeScenario('Hand lost to motion blur for 100 ms at contact', { blur: 0.1, seed: 13 })));
all.push(report(strokeScenario('Hand lost for 200 ms at contact', { blur: 0.2, seed: 14 }), 0.9));
all.push(report(strokeScenario('15 fps camera', { fps: 15, seed: 15 }), 0.95));
all.push(report(strokeScenario('60 fps camera', { fps: 60, seed: 16 })));
all.push(report(strokeScenario('No captureTime (presentation stamps, ±8 ms jitter)', { ts: 'pres', presJit: 0.016, seed: 17 })));
all.push(report(strokeScenario('Noisy tracking (6 px jitter)', { jitter: 0.009, seed: 18 }), 0.95));
all.push(report(strokeScenario('Slow swings (1.4-2 frame widths/s)', { amp: 0.25, dur: 0.3, seed: 19 }), 0.9));
all.push(report(strokeScenario('Tracker glitches (3% of frames jump to the other hand)', { glitch: 0.03, seed: 20 }), 0.93));

// ---- idle: no swings should come out of jitter, drift, fidgeting or glitches ----
function idle(name, o) {
  const r = rng(o.seed || 99);
  let swings = 0, secs = 0;
  for (let i = 0; i < (QUICK ? 5 : 20); i++) {
    const segs = [];
    let t = 0, p = { x: 0.55, y: 0.55 };
    const start = p;
    while (t < 10) {
      const dur = 0.4 + r() * 1.2, to = { x: 0.4 + r() * 0.3, y: 0.45 + r() * 0.2 };
      const speed = (1.875 * Math.hypot(to.x - p.x, to.y - p.y)) / dur;
      if (speed <= o.maxSpeed) { segs.push({ t0: t, t1: t + dur, to }); p = to; }
      t += dur + r() * 0.5;
    }
    const frames = camera(path(start, segs), 0, 10, r, { jitter: o.jitter, glitch: o.glitch, drop: o.drop });
    const { evs } = runNew(frames);
    swings += evs.filter((e) => e.type === 'swing').length; secs += 10;
  }
  const perMin = (swings * 60) / secs;
  console.log(`\n${name}: ${swings} false swings in ${secs} s (${perMin.toFixed(2)} per minute)`);
  check(perMin <= o.maxPerMin, `${name}: ${perMin.toFixed(2)} false swings per minute`);
}
idle('Idle hand, 3 px jitter, slow drifting (up to 0.8 frame widths/s)', { jitter: 0.003, maxSpeed: 0.8, maxPerMin: 0.1 });
idle('Idle hand, 8 px jitter (dim room), drifting', { jitter: 0.008, maxSpeed: 0.8, maxPerMin: 0.3, seed: 3 });
idle('Idle hand with one-frame tracker glitches (2% of frames)', { jitter: 0.003, maxSpeed: 0.6, glitch: 0.02, maxPerMin: 0.3, seed: 4 });
idle('Idle hand, 20% dropped frames', { jitter: 0.004, maxSpeed: 0.8, drop: 0.2, maxPerMin: 0.2, seed: 6 });

// ---- toss, cancel, clock jumps, rally sequences ----
{
  const r = rng(42), d = new SwingDetector();
  const traj = path({ x: 0.6, y: 0.6 }, [{ t0: 1, t1: 1.4, to: { x: 0.62, y: 0.12 } }, { t0: 2.5, t1: 2.9, to: { x: 0.6, y: 0.6 } }]);
  const tosses = [];
  for (const f of camera(traj, 0, 4, r)) for (const e of d.push(f.cap, f.x, f.y)) if (e.type === 'toss') tosses.push(f.cap);
  console.log(`\nToss: hand raised above the toss line → ${tosses.length} toss at ${tosses.map((t) => t.toFixed(2))} s`);
  check(tosses.length === 1 && tosses[0] > 1.2 && tosses[0] < 1.6, 'toss should fire exactly once, soon after the hand passes the line');
}
{
  // The game cancels the swing in progress on a toss: the upward toss motion must not come back as a new swing,
  // but the serve swing coming down must.
  const r = rng(43), d = new SwingDetector();
  const traj = path({ x: 0.6, y: 0.7 }, [{ t0: 1, t1: 1.25, to: { x: 0.62, y: 0.15 } }, { t0: 1.9, t1: 2.15, to: { x: 0.45, y: 0.7 } }]);
  const sw = [];
  let cancelled = false;
  for (const f of camera(traj, 0, 3, r)) {
    for (const e of d.push(f.cap, f.x, f.y)) {
      if (e.type === 'toss' && !cancelled) { cancelled = true; d.cancel(); }
      if (e.type === 'swing') sw.push(e.swing);
    }
  }
  const after = sw.filter((s) => s.tOn > 1.2);
  console.log(`Cancel on toss: swings after the toss ${after.map((s) => `${s.tOn.toFixed(2)}s vy ${s.vy.toFixed(1)}`).join(', ')}`);
  check(after.length === 1 && after[0].vy > 0, 'exactly one (downward serve) swing after the toss');
}
{
  // A resumed pause makes the game clock jump back: tracking must carry on, not freeze.
  const d = new SwingDetector();
  for (let t = 5; t < 6; t += 1 / 30) d.push(t, 0.5, 0.5);
  let n = 0;
  for (let t = 3; t < 3.5; t += 1 / 30) { d.push(t, 0.5 + (t - 3) * 0.1, 0.5); if (d.lastT === t) n++; }
  check(n > 10, 'detector follows a clock that jumped back');
  console.log(`Clock jump back: ${n}/15 frames accepted after the jump`);
}
{
  // A rally: alternating forehands and backhands 1.6 s apart, all returned, each exactly once.
  const r = rng(7), segsAll = [];
  const d = new SwingDetector(), kinds = [], Ts = [];
  let evs = [];
  const strokes = [];
  for (let k = 0; k < 12; k++) { const T = 1.5 + k * 1.6, kind = k % 3 === 1 ? 'bh' : k % 2 ? 'fh' : 'bh'; kinds.push(kind); Ts.push(T); strokes.push(makeStroke(kind, T, r)); }
  const traj = (t) => { for (let k = strokes.length - 1; k >= 0; k--) if (t >= strokes[k].start) return strokes[k].traj(t); return strokes[0].traj(t); };
  const frames = camera(traj, 0.5, Ts[Ts.length - 1] + 1.5, r, { drop: 0.05 });
  for (const f of frames) for (const e of (f.miss ? d.miss(f.cap) : d.push(f.cap, f.x, f.y, { handed: 'R' }))) { if (e.type === 'swing') e.snap = { peak: e.swing.peak, dir: e.swing.dir, t0: e.swing.t0 }; evs.push({ ...e, wall: f.done }); }
  let ok = 0;
  const line = [];
  for (let k = 0; k < Ts.length; k++) {
    const win = evs.filter((e) => e.wall > Ts[k] - 0.8 && e.wall < Ts[k] + 0.6);
    const g = gameNew(win, Ts[k], kinds[k], LAT_NEW_CAP);
    if (g.hit) ok++;
    line.push(`${kinds[k]}${g.hit ? '✓' : '✗'}`);
  }
  console.log(`Rally of ${Ts.length} alternating strokes: ${line.join(' ')}`);
  check(ok === Ts.length, 'every rally stroke returned');
}

// ---- unit checks ----
check(strokeDir(-2, 0.3, 'R') === 'fh' && strokeDir(2, 0.3, 'R') === 'bh' && strokeDir(2, 0, 'L') === 'fh' && strokeDir(0.3, 2, 'R') === null, 'strokeDir');
check(judgeCameraSwing(-0.3, 'fh', 'bh') === 'windup' && judgeCameraSwing(-0.3, null, 'bh') === 'windup' && judgeCameraSwing(-0.05, 'fh', 'bh') === 'hit' &&
  judgeCameraSwing(-0.35, 'bh', 'bh') === 'early' && judgeCameraSwing(0.3, 'bh', 'bh') === 'late' && judgeCameraSwing(0, null, 'fh') === 'hit', 'judgeCameraSwing');
check(Math.abs(peakTime([{ t: 0, s: 1 }, { t: 0.033, s: 3 }, { t: 0.066, s: 2 }]) - 0.0385) < 0.003, 'peakTime parabola');
{
  // Hand picking: prefer the racket hand, follow continuity, skip frames where only the other hand is visible far away.
  const R = 'Left', Lb = 'Right';
  check(pickHand([{ x: 0.3, y: 0.5, label: Lb }, { x: 0.7, y: 0.5, label: R }], 'R', null) === 1, 'pickHand: racket-hand label');
  check(pickHand([{ x: 0.3, y: 0.5, label: R }, { x: 0.7, y: 0.5, label: R }], 'R', { x: 0.32, y: 0.5, age: 0.03 }) === 0, 'pickHand: continuity');
  check(pickHand([{ x: 0.25, y: 0.55, label: Lb }], 'R', { x: 0.7, y: 0.5, age: 0.05 }) === -1, 'pickHand: skip lone off hand far away');
  check(pickHand([{ x: 0.66, y: 0.5, label: Lb }], 'R', { x: 0.7, y: 0.5, age: 0.05 }) === 0, 'pickHand: keep a mislabelled hand at the right spot');
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  // palm 0.042 frame widths long, knuckles 0.8 of that across (a real adult hand's proportions)
  lm[0] = { x: 0.5, y: 0.6 }; lm[9] = { x: 0.5, y: 0.6 - (0.042 * 4) / 3 }; lm[5] = { x: 0.4832, y: 0.6 - (0.04 * 4) / 3 }; lm[17] = { x: 0.5168, y: 0.6 - (0.034 * 4) / 3 };
  check(Math.abs(palmSize(lm) / 0.042 - 1) < 0.08, `palmSize ${palmSize(lm).toFixed(4)}`);
}

// ---- paddle color segmentation on synthetic frames ----
function frame(W, H, bg, objs, r) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    let c = bg(x, y);
    for (const o of objs) {
      const dx = (x + 0.5 - o.x) / o.rx, dy = (y + 0.5 - o.y) / o.ry;
      if (dx * dx + dy * dy <= 1) c = o.mix ? c.map((v, k) => v * (1 - o.mix) + o.c[k] * o.mix) : o.c;
    }
    const nz = (r() - 0.5) * 16;
    px[i] = c[0] + nz; px[i + 1] = c[1] + nz; px[i + 2] = c[2] + nz; px[i + 3] = 255;
  }
  return px;
}
{
  const r = rng(5), W = 160, H = 120;
  const wall = () => [200, 196, 188], room = (x, y) => [120 + x * 0.4, 110 + y * 0.3, 100];
  const RED = [205, 30, 38], SKIN = [214, 160, 130], DARKRED = [120, 18, 22];
  // Lock the color from the circle: paddle plus some fingers in the patch.
  const lockPx = frame(20, 20, () => SKIN, [{ x: 10, y: 10, rx: 9, ry: 8, c: RED }], r);
  const lock = lockColorFromPatch(lockPx);
  check(lock && (lock.h > 350 || lock.h < 6) && lock.s > 0.7, `lock color from a patch with fingers (got ${lock && lock.h.toFixed(1)}°, s ${lock && lock.s.toFixed(2)})`);
  check(lockColorFromPatch(frame(20, 20, () => [128, 128, 128], [], r)) === null, 'refuse to lock a grey patch');
  const tg = { h: lock.h, s: lock.s, v: lock.v, tol: lock.tol };
  const S = {};
  const cases = [
    ['paddle on a plain wall', frame(W, H, wall, [{ x: 50, y: 60, rx: 6, ry: 7, c: RED }], r), 1 - 50 / W, 60 / H],
    ['paddle next to a face (skin)', frame(W, H, room, [{ x: 80, y: 40, rx: 18, ry: 24, c: SKIN }, { x: 104, y: 70, rx: 6, ry: 7, c: RED }], r), 1 - 104 / W, 70 / H],
    ['paddle plus a small red object', frame(W, H, room, [{ x: 30, y: 30, rx: 3, ry: 3, c: RED }, { x: 110, y: 80, rx: 7, ry: 7, c: RED }], r), 1 - 110 / W, 80 / H],
    ['paddle in dim light', frame(W, H, (x, y) => [60, 58, 55], [{ x: 70, y: 50, rx: 6, ry: 6, c: DARKRED }], r), 1 - 70 / W, 50 / H],
  ];
  for (const [name, px, ex, ey] of cases) {
    const b = segmentColor(px, W, H, tg, { scratch: S });
    const err = b ? Math.hypot(b.x - ex, b.y - ey) : 1;
    console.log(`Paddle: ${name}: ${b ? `found at (${b.x.toFixed(3)}, ${b.y.toFixed(3)}), ${b.n} px, error ${(err * W).toFixed(1)} px` : 'not found'}`);
    check(err < 1.5 / W * 2, `paddle: ${name}`);
  }
  // Motion blur: the paddle smeared across the background at 45% strength. Strict thresholds miss it; with the
  // expected position the looser pass keeps it.
  const blur = frame(W, H, wall, [{ x: 90, y: 60, rx: 16, ry: 5, c: RED, mix: 0.45 }], r);
  const strictOnly = segmentColor(blur, W, H, tg, { scratch: S });
  const withPred = segmentColor(blur, W, H, tg, { scratch: S, pred: { x: 1 - 84 / W, y: 60 / H, r: 0.15 } });
  console.log(`Paddle: motion-blurred: without a prediction ${strictOnly ? 'found' : 'lost'}, with one ${withPred ? `found at x ${(withPred.x * W).toFixed(1)} (true ${W - 90})` : 'lost'}`);
  check(withPred && Math.abs(withPred.x - (1 - 90 / W)) < 3 / W, 'paddle: blurred paddle kept near its predicted spot');
  // Two equal paddles: the one near the prediction wins.
  const two = frame(W, H, wall, [{ x: 40, y: 60, rx: 6, ry: 6, c: RED }, { x: 120, y: 60, rx: 6, ry: 6, c: RED }], r);
  const near = segmentColor(two, W, H, tg, { scratch: S, pred: { x: 1 - 118 / W, y: 0.5, r: 0.1 } });
  check(near && Math.abs(near.x - (1 - 120 / W)) < 2 / W, 'paddle: continuity picks the blob near the prediction');
  // Lighting drift: the working color follows but stays near the locked one.
  let cur = { ...tg };
  for (let k = 0; k < 200; k++) cur = adaptColor(cur, lock, { hue: (lock.h + 12) % 360, sat: lock.s * 0.8, val: lock.v * 0.6 });
  const dh = Math.min(Math.abs(cur.h - lock.h), 360 - Math.abs(cur.h - lock.h));
  check(dh <= 8.01 && cur.v < lock.v * 0.7 && cur.s < lock.s, `adaptColor follows lighting within limits (hue off ${dh.toFixed(1)}°)`);
  // Timing: segmentation cost per frame.
  const t0 = performance.now();
  for (let k = 0; k < 200; k++) segmentColor(cases[1][1], W, H, tg, { scratch: S, pred: { x: 0.35, y: 0.6, r: 0.12 } });
  console.log(`Paddle segmentation: ${((performance.now() - t0) / 200).toFixed(2)} ms per 160×120 frame`);
  check(hsv(255, 0, 0).h === 0 && Math.abs(hsv(0, 255, 0).h - 120) < 1e-9, 'hsv');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
