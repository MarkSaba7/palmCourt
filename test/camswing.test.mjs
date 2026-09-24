// Synthetic-webcam tests for the camera swing detector (src/camswing.js). No webcam, no browser:
//   node test/camswing.test.mjs            run everything, print a report, exit 1 on failure
//   node test/camswing.test.mjs --quick    fewer trials
// Swings are minimum-jerk arm movements (a wind-up, the stroke, then the arm coming back), seen by a simulated camera
// with frame jitter, dropped frames, motion-blur gaps and processing delay. The same frames also go through a copy of
// the previous detector so the report shows before/after numbers.
import { SwingDetector, judgeCameraSwing, strokeDir, segmentColor, lockColorFromPatch, adaptColor, pickHand, palmSize, hsv, peakTime } from '../src/camswing.js';

const QUICK = process.argv.includes('--quick');
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
