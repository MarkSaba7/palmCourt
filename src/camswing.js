import { clamp } from './core.js';

// =====================================================================
// CAMSWING: webcam hand / paddle positions → swings, plus paddle color segmentation.
// No DOM in here, so test/camswing.test.mjs can drive it from Node with synthetic swings.
// Positions are normalised to the mirrored camera image: x 0..1 left to right as the player sees it, y 0..1 top to bottom.
// Speeds are in frame widths per second (y is converted to width units with the image aspect).
// =====================================================================
const SWING = {
  start: 1.3,         // speed that starts a swing, before sensitivity
  stopK: 0.35,        // a movement ends when its speed drops below this share of the start speed
  backK: 0.5,         // the sample before the start must move the same way at this share of it (rejects one-frame glitches)
  noiseK: 4,          // the start speed stays this many times above the noise (sd) of the measured speed
  maxGap: 0.3,        // tracking lost for longer than this (seconds) breaks the trajectory
  refractory: 0.4,    // a movement the same way this soon after a stroke is its follow-through
  maxDur: 0.9,
  maxAcc: 110,        // frame widths per second², above a real hand; a point further off the track than this allows is a glitch
  rise: 0.1,          // first guess at the time from the start speed to peak speed (then learned per player)
  horiz: 0.5,         // sideways share of the swing needed to call forehand or backhand
  across: 0.65,       // sideways share a movement needs to be a stroke (steeper: raising or dropping the hand, a loop)
  windupWait: 0.25,   // a movement away from rest is the wind-up if the hand swings back within this after it stops
  tossLine: 0.24,     // hand above this fraction of the frame height tosses the ball
  tossHold: 0.12,
  tossBlock: 0.6,     // ...unless it got there within this after a stroke (a high follow-through)
};

const median = (a) => { if (!a.length) return NaN; const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
const keep = (a, v, n) => { a.push(v); if (a.length > n) a.shift(); };

// Forehand or backhand from the swing's direction in the mirrored image: a right-hander's forehand sweeps right to left.
// Returns null when the swing is mostly up or down.
function strokeDir(vx, vy, handed, horiz = SWING.horiz) {
  const v = Math.hypot(vx, vy);
  if (v < 1e-9 || Math.abs(vx) < horiz * v) return null;
  return (vx < 0) === (handed !== 'L') ? 'fh' : 'bh';
}

// What a camera swing means for the ball that's coming (dt: swing time minus the planned contact time, seconds).
// Taking the racket back is a swing the other way before the ball arrives: it must not use up the shot, and neither
// must a swing whose direction can't be read, so the real swing that follows still counts. A swing that's clearly
// too early says so but also leaves the shot open. Near the ball, any swing hits the stroke the ball needs.
function judgeCameraSwing(dt, dir, stroke) {
  if (dt < -0.45) return 'ignore';
  if (dir !== stroke && dt < -0.1) return 'windup';
  if (dt < -0.3) return 'early';
  if (dt > 0.22) return 'late';
  return 'hit';
}

// One-Euro filter (Casiez et al.) for a 2D point: smooth when still, nearly lag-free when moving fast.
class OneEuro2 {
  constructor(minCut = 1.2, beta = 3, dCut = 1.5) { this.minCut = minCut; this.beta = beta; this.dCut = dCut; this.reset(); }
  reset() { this.t = null; this.x = 0; this.y = 0; this.dx = 0; this.dy = 0; }
  filter(t, x, y) {
    if (this.t === null || t - this.t > 0.5 || t <= this.t) { this.t = t; this.x = x; this.y = y; this.dx = this.dy = 0; return this; }
    const dt = t - this.t, a = (cut) => { const r = 2 * Math.PI * cut * dt; return r / (r + 1); };
    const ad = a(this.dCut);
    this.dx += ad * ((x - this.x) / dt - this.dx); this.dy += ad * ((y - this.y) / dt - this.dy);
    const k = a(this.minCut + this.beta * Math.hypot(this.dx, this.dy));
    this.x += k * (x - this.x); this.y += k * (y - this.y); this.t = t;
    return this;
  }
}

// Turns tracked positions into swing events. The hand's path is cut into movements (a new one starts when the hand
// sets off, turns round or turns sharply), and each movement is judged by what it looks like in context:
// - a stroke: reported once, as soon as it's confirmed (usually a frame or two after it passes the start speed, well
//   before its peak), with t0 = the predicted moment of peak speed, which is when the racket meets the ball;
// - the wind-up: a movement away from rest that stops and swings back. It's held back, not reported, and the swing
//   back is the stroke. If nothing swings back it was a stroke after all and is reported late (t0 still its peak);
// - the arm coming back to the ready position after a stroke, or the follow-through carrying on: never reported;
// - up/down movements: not strokes (except the serve swing after a toss).
// A movement that turns out faster than expected for its role (well past the player's usual speed, or faster than the
// stroke before it) is reported as a stroke at once. Glitches (the tracker jumping to the other hand or a same-colored
// thing for a few frames) are cut out of the path before any of this.
class SwingDetector {
  constructor(opts = {}) {
    this.o = { ...SWING, ...opts };
    this.filt = new OneEuro2();
    this.rises = []; this.ratios = []; this.peaks = []; this.winds = []; this.noise = []; this.gaps = [];
    this.frameDt = 1 / 30; this.sigma = 0.003; this.thr = this.o.start; this.sc = 1; this.fresh = -9;
    this.home = null; this.highSince = 0; this.tossFired = false; this.tossBlock = false; this.tossT = -9; this.swingT = -9; this.glitches = 0;
    this.ignored = null;   // the last movement fast enough to be a swing that wasn't one: {role, dir, peak, t}
    this.reset();
  }
  reset() {
    this.pts = []; this.alt = []; this.lastV = null; this.vh = []; this.mv = null; this.hold = null; this.ended = null; this.rec = null; this.pend = null;
    this.held = null; this.stillSince = 0; this.stillFor = 0; this.stillEnd = -9; this.lastMove = null; this.lastFrame = null;
    this.x = 0.5; this.y = 0.5; this.vx = this.vy = this.speed = 0; this.valid = false; this.lastT = -9;
    this.filt.reset();
  }
  get active() { return this.mv && this.mv.sw ? this.mv.sw : null; }
  // Drop the swing in progress (the game does this on a toss). No new swing starts until the hand slows or turns.
  cancel() {
    const m = this.mv;
    if (m) this.hold = { ux: m.ux, uy: m.uy };
    this.mv = null; this.ended = null; this.rec = null; this.held = null;
  }
  // Tracking jitter (sd of a position, frame widths) from second differences of the position while the hand is still.
  // Speed noise of the measured speed (frame widths per second, one axis) for the velocity window in use.
  noiseSpeed() {
    const W = this.win(), dt = Math.max(this.frameDt, 0.008), m = Math.max(2, Math.floor(W / dt + 1e-6) + 1);
    return (this.sigma * this.sc) / (dt * Math.sqrt((m * (m * m - 1)) / 12));
  }
  threshold(sens) {
    const base = this.o.start / (sens || 1);
    return clamp(this.o.noiseK * this.noiseSpeed(), base, base * 1.6);
  }
  // Velocity window (seconds): about one frame interval, longer when tracking is jittery (a paddle in dim light).
  win() { return clamp((0.034 * this.sigma * this.sc) / 0.0035, Math.max(0.03, 1.05 * this.frameDt), 0.075); }
  // Where the tracked point should be at time t (for picking the right hand in a frame with two).
  predict(t) {
    const b = this.pts[this.pts.length - 1];
    if (!b) return null;
    const age = t - b.t, v = this.lastV, k = Math.min(Math.max(age, 0), 0.1);
    return { x: b.x + (v ? (v.vx / b.sc) * k : 0), y: (b.yw + (v ? (v.vy / b.sc) * k : 0)) * b.asp, age };
  }
  // How far (frame widths) a point dt after the last one may land from where the track was heading, and still be it.
  gate(dt, sc) {
    const acc = this.o.maxAcc * (this.src === 'paddle' ? 1.4 : 1);
    const h = dt + 0.5 * this.win();   // the velocity it extrapolates is from half a window back
    return 4.5 * this.sigma + 0.004 + Math.min(0.5 * acc * h * h, 7 * dt) / sc;
  }
  // A tracked position. Returns the events it caused: swing, swingEnd, toss.
  push(t, x, y, o = {}) {
    const out = (this.out = []), O = this.o, asp = o.aspect || 4 / 3, sc = o.scale || 1, yw = y / asp;
    this.src = o.src || 'hand'; this.handed = o.handed; this.sc = sc;
    let last = this.pts[this.pts.length - 1];
    if (this.lastFrame !== null && t < this.lastFrame - 0.05) { this.breakTrack(out); last = null; this.lastFrame = null; }   // the clock jumped back
    if (this.lastFrame !== null && t <= this.lastFrame + 1e-4) return out;                                                  // a repeated frame
    if (this.lastFrame !== null && t - this.lastFrame < 0.2) { keep(this.gaps, t - this.lastFrame, 15); this.frameDt = median(this.gaps); }
    this.lastFrame = t;
    if (last && t - last.t > O.maxGap) { this.breakTrack(out); last = null; }
    this.thr = this.threshold(o.sens);
    const p = { t, x, yw, sc, asp }, a = this.alt, al = a[a.length - 1];
    const gAlt = al ? this.gate(t - al.t, sc) : 0, dAlt = al ? Math.hypot(x - al.x, yw - al.yw) : Infinity, off = last ? this.offTrack(p, last) : 0;
    if (last && (off > 1 || (dAlt < gAlt && dAlt < off * this.gate(t - last.t, sc)))) {
      // Off the track (or next to the last point that was): the tracker jumped to something else (skip it), unless it
      // stays there: then it re-found the hand somewhere new, and the track starts again there without counting the
      // jump as movement.
      if (dAlt > gAlt) a.length = 0;
      a.push(p);
      if (a.length < 4 || t - a[0].t < 0.1) { this.glitches++; this.pendingCheck(t, out); this.tossCheck(t, out); return out; }
      this.breakTrack(out);
      this.pts = a.slice(); this.alt = []; this.fresh = a[0].t;
      last = null;
    } else this.alt.length = 0;
    if (!last && this.pts[this.pts.length - 1] !== p) this.fresh = t;
    if (!last || this.pts[this.pts.length - 1] !== p) this.pts.push(p);
    while (this.pts.length > 12) this.pts.shift();
    this.filt.filter(t, x, y);
    this.x = this.filt.x; this.y = this.filt.y; this.valid = true; this.lastT = t;
    const v = this.velocity();
    // Jitter: second differences of evenly spaced points while the hand is slow.
    const P = this.pts, n = P.length;
    if (n >= 3 && (!this.mv || !this.mv.sw) && (!v || v.s < 0.4 * this.thr)) {
      const a = P[n - 3], b = P[n - 2], d1 = b.t - a.t, d2 = t - b.t;
      if (d1 < 1.5 * this.frameDt && d2 < 1.5 * this.frameDt && Math.abs(d1 - d2) < 0.3 * this.frameDt) {
        keep(this.noise, Math.hypot(x - 2 * b.x + a.x, yw - 2 * b.yw + a.yw), 45);
        if (this.noise.length >= 8) this.sigma = Math.max(0.0012, median(this.noise) / 2.884);
      }
    }
    this.vx = v ? v.vx : 0; this.vy = v ? v.vy : 0; this.speed = v ? v.s : 0;
    if (v) this.step(v, t, p, o, out);
    this.lastV = v;
    if (v) keep(this.vh, v, 6);
    this.pendingCheck(t, out);
    this.tossCheck(t, out);
    return out;
  }
  // How far p is from where the track was heading, as a share of what a hand could do since the last point (over 1:
  // not the hand).
  offTrack(p, last) {
    const dt = p.t - last.t, v = this.lastV && p.t - this.lastV.t < 0.2 ? this.lastV : null;
    const px = last.x + (v ? (v.vx / last.sc) * dt : 0), py = last.yw + (v ? (v.vy / last.sc) * dt : 0);
    return Math.hypot(p.x - px, p.yw - py) / this.gate(dt, p.sc);
  }
  // Velocity from a least-squares line through the last points (frame widths per second, scaled). After a tracking
  // gap it is the average over the gap.
  velocity() {
    const P = this.pts, n = P.length;
    if (n < 2) return null;
    const b = P[n - 1], gap = b.t - P[n - 2].t > 2.5 * this.frameDt, W = this.win();
    let i0 = n - 2;
    if (!gap) while (i0 > 0 && b.t - P[i0 - 1].t <= W + 0.004 && P[i0].t - P[i0 - 1].t <= 2.5 * this.frameDt) i0--;
    const m = n - i0;
    let st = 0, sx = 0, sy = 0, stt = 0, stx = 0, sty = 0;
    for (let i = i0; i < n; i++) { st += P[i].t; sx += P[i].x; sy += P[i].yw; }
    st /= m; sx /= m; sy /= m;
    for (let i = i0; i < n; i++) { const d = P[i].t - st; stt += d * d; stx += d * (P[i].x - sx); sty += d * (P[i].yw - sy); }
    const vx = (stx / stt) * b.sc, vy = (sty / stt) * b.sc;
    return { t: st, vx, vy, s: Math.hypot(vx, vy), gap, x0: P[i0].x, y0: P[i0].yw };
  }
  // No position this frame (hand or paddle not found).
  miss(t) {
    const out = [], last = this.pts[this.pts.length - 1];
    if (this.lastFrame !== null && t > this.lastFrame && t - this.lastFrame < 0.2) { keep(this.gaps, t - this.lastFrame, 15); this.frameDt = median(this.gaps); }
    if (this.lastFrame === null || t > this.lastFrame) this.lastFrame = t;
    if (last && t - last.t > this.o.maxGap) this.breakTrack(out);
    if (t - this.lastT > 0.15) { this.valid = false; this.vx = this.vy = this.speed = 0; }
    this.pendingCheck(t, out);
    return out;
  }
  breakTrack(out) {
    if (this.mv) this.endMove(this.mv, this.lastT, out, 'lost');
    this.pts = []; this.alt = []; this.lastV = null; this.filt.reset(); this.stillSince = 0;
  }
  step(v, t, p, o, out) {
    const O = this.o, thr = this.thr, on = 0.45 * thr;
    if (v.s < O.stopK * thr) {
      if (!this.stillSince) this.stillSince = t;
      this.hold = null;
      // At rest between strokes: that's the ready position (not the finish of a stroke, nor a held-back racket).
      const h = this.home;
      if (!h || (!this.held && t - this.stillSince > 0.2 && !(this.ended && t - this.ended.t < 0.5))) {
        const k = h ? Math.min(1, (t - this.homeT) / 0.8) : 1;
        this.home = h ? { x: h.x + (p.x - h.x) * k, y: h.y + (p.yw - h.y) * k } : { x: p.x, y: p.yw };
      }
      this.homeT = t;
    } else if (this.stillSince) { this.stillFor = t - this.stillSince; this.stillEnd = t; this.stillSince = 0; }
    // After a stroke the arm has come back once it rests at the ready position, or 40% of the way back along the
    // stroke's path.
    const R = this.rec, h = this.home;
    if (R && this.stillSince && t - this.stillSince > 0.1 &&
      ((h && Math.hypot(p.x - h.x, p.yw - h.y) * this.sc < 0.1) || ((p.x - R.x1) * (R.x0 - R.x1) + (p.yw - R.y1) * (R.y0 - R.y1)) / R.len2 > 0.4)) this.rec = null;
    if (R && t - R.end > 1.3) this.rec = null;
    let m = this.mv, why = null;
    // A movement seen only across a tracking gap: this frame tells whether it was real (the hand carries on, or stays
    // where it turned up: the whole swing was a blur) or a glitch (it jumps back).
    if (m && m.cls === 'gap?' && !v.gap) {
      if (Math.hypot(p.x - m.gx, p.yw - m.gy) < 0.5 * m.jump || (v.s > 0.25 * this.thr && v.vx * m.ux + v.vy * m.uy < -0.3 * v.s)) m.cls = 'glitch?';
      else {
        // Its peak: the average speed across the gap, more so the more of the swing the gap hid.
        m.gapK = clamp(1.875 - 0.7 * Math.max(m.preS, v.s) / m.pk[1].s, 1.15, 1.875);
        m.cls = 'gap';
        this.judge(m, v, t, p, o, out);
      }
    }
    if (m) {
      const along = v.vx * m.ux + v.vy * m.uy;
      if (v.s >= on && along < -0.25 * v.s) why = 'reversal';
      else if (!m.sw && m.rx !== undefined && v.s >= on && v.vx * m.rx + v.vy * m.ry < 0.45 * v.s) why = 'turn';
      else if (v.s < O.stopK * thr) why = 'stop';
      else if (t - m.t0 > O.maxDur) why = 'long';
      if (why) { this.endMove(m, t, out, why); m = null; }
      else this.track(m, v, p);
    }
    // A movement never starts across a tracking gap: the jump could be the tracker re-finding the hand elsewhere. And
    // just after one, where a movement set off from isn't known.
    if (v.gap && v.s >= on) this.fresh = t;
    const pre = this.lastV;
    if (!m && v.s >= on && !v.gap) m = this.startMove(v, t, p, why);
    // A swing hidden by motion blur: the hand turns up much further on after the gap, and it was either already heading
    // that way or set off from where the racket was held back. (Reported only if the next frame carries on, see judge.)
    else if (!m && v.gap && v.s >= 0.6 * thr && this.gapSwing(v, pre, p)) { m = this.startMove(v, t, p, 'gap'); this.gapMark(m, v, p, pre); }
    if (m && !m.sw && (v.s >= thr || m.cls === 'windup?') && m.cls !== 'gap?') this.judge(m, v, t, p, o, out);
  }
  gapSwing(v, pre, p) {
    if (Math.hypot(p.x - v.x0, p.yw - v.y0) * this.sc < 0.12) return false;
    if (pre && !pre.gap && pre.s >= 0.3 * this.thr && pre.vx * v.vx + pre.vy * v.vy > 0.5 * pre.s * v.s) return true;
    const ux = v.vx / v.s, uy = v.vy / v.s, h = this.home, H = this.held;
    if (H && !H.next && ux * H.m.ux + uy * H.m.uy < -0.5) return true;
    return !!h && ((v.x0 - h.x) * ux + (v.y0 - h.y) * uy) * this.sc < -0.07;
  }
  serving(m, t) { return t - this.tossT < 2 && !this.served && m.uy > 0.3 && m.y0 * (this.pts.length ? this.pts[this.pts.length - 1].asp : 4 / 3) < this.o.tossLine + 0.15; }
  gapMark(m, v, p, pre) { m.cls = 'gap?'; m.gx = v.x0; m.gy = v.y0; m.jump = Math.hypot(p.x - v.x0, p.yw - v.y0); m.preS = pre && !pre.gap ? pre.s : 0; }
  startMove(v, t, p, why) {
    const turned = why === 'reversal' || why === 'turn', lm = this.lastMove;
    const dx = p.x - v.x0, dy = p.yw - v.y0, d = Math.hypot(dx, dy);
    const ux = d > 1e-6 ? dx / d : v.vx / v.s, uy = d > 1e-6 ? dy / d : v.vy / v.s;
    const pv = this.lastV && !turned && t - this.lastV.t < 0.1 ? this.lastV : null;
    const m = {
      t0: v.t, x0: v.x0, y0: v.y0, ux, uy, n: 0, vmax: 0, pk: null, prev: pv, pprev: null, tOn: null, v0: 0, cls: null, sw: null,
      hist: this.vh.filter((q) => q.t > v.t - 0.2 && !q.gap),   // (the samples just before it: where its speed took off)
      turn: turned, from: turned && lm && lm.t > t - 0.12 ? lm.m : null,
      still: !turned && this.stillEnd > t - 0.2 && this.stillFor >= 0.12,
    };
    // Setting off back the other way (or sharply turned) soon after a held-back movement from rest: if this one is about
    // as fast, that was the wind-up and this is the swing; if it's much slower, that was the swing and this is the arm
    // coming back (decided in classify / resolveHeld).
    const h = this.held;
    if (h && !h.next && ux * h.m.ux + uy * h.m.uy < 0.5) { h.next = m; m.turn = true; m.from = h.m; m.still = false; }
    this.mv = m;
    this.track(m, v, p);
    return m;
  }
  track(m, v, p) {
    // Direction: from where the movement started, until it's reported.
    if (!m.sw) { const dx = p.x - m.x0, dy = p.yw - m.y0, d = Math.hypot(dx, dy); if (d > 0.015) { m.ux = dx / d; m.uy = dy / d; } }
    if (m.tOn === null && v.s >= this.thr) {
      const pv = m.prev;
      m.tOn = pv && pv.s < this.thr && !v.gap ? pv.t + ((this.thr - pv.s) / (v.s - pv.s)) * (v.t - pv.t) : v.t;
    }
    // A sample more than 3× the one before (and above the start speed) mid-swing is a glitch, not the racket.
    if (!(m.sw && m.prev && v.s > 3 * m.prev.s && m.prev.s > this.thr)) {
      if (v.s > m.vmax) { m.vmax = v.s; m.pk = [m.prev, v, null]; m.gapPk = v.gap; if (m.sw) { m.sw.vx = v.vx; m.sw.vy = v.vy; } }
      else if (m.pk && !m.pk[2]) m.pk[2] = v;
    }
    m.pprev = m.prev; m.prev = v; m.n++; m.last = { x: p.x, y: p.yw, t: p.t };
    if (!v.gap && m.hist.length < 40) m.hist.push(v);
    const H = this.held;
    if (H && H.next === m && !m.sw && this.heldVerdict(H, m, false)) this.resolveHeld(p.t, this.out);
    // The way it set off (for telling when it turns: a loop's drop turning into the swing).
    if (m.n === 2) { m.rx = m.ux; m.ry = m.uy; }
    if (m.sw) {
      const sw = m.sw, passed = m.pk && m.pk[2] && m.pk[2].s < 0.95 * m.vmax;
      if (passed) { sw.tPeak = this.peakAt(m); sw.peak = m.vmax * (m.gapPk ? m.gapK || 1.15 : 1); }
      else sw.peak = Math.max(m.vmax * (m.gapPk ? m.gapK || 1.15 : 1), m.pred || 0);
    }
  }
  // Decide what a movement fast enough to be a swing is (again every frame until it's reported, so it can be upgraded).
  judge(m, v, t, p, o, out) {
    const O = this.o, thr = this.thr, b = m.pprev;
    if (m.cls === 'glitch?') return;
    // First, two samples in a row moving the same way: a one-frame glitch can't do that. (A gap needs the next frame.)
    if (!m.cls && !(b && b.s >= (v.gap ? 0.3 : O.backK) * thr && b.vx * v.vx + b.vy * v.vy > 0.3 * b.s * v.s)) return;
    const cls = this.classify(m, v, t);
    if (cls !== 'stroke') { if (m.cls !== 'gap') m.cls = cls; return; }
    if (v.gap) { this.gapMark(m, v, p, m.pprev); return; }
    this.begin(m, v, t, p, o, out);
  }
  classify(m, v, t) {
    const O = this.o, thr = this.thr, ax = Math.abs(m.ux), h = this.home, H = this.held;
    if (H && H.next === m) return 'pending';   // (see track)
    // Did it set off from around the ready position (not from behind it, where the racket is taken back to)? Unknown
    // just after the track started again.
    m.home = !!h && m.t0 - this.fresh >= 0.12 && ((m.x0 - h.x) * m.ux + (m.y0 - h.y) * m.uy) * this.sc >= -0.07;
    // After a cancel (toss): the same movement carrying on isn't a new swing.
    if (this.hold && m.ux * this.hold.ux + m.uy * this.hold.uy > 0) return 'cancelled';
    // Straight after a stroke: going back the other way is the arm returning to ready, carrying on the same way is the
    // follow-through, unless it's faster than the stroke was (then that was the wind-up and this is the stroke).
    const R = this.rec;
    if (R) {
      const dot = m.ux * R.ux + m.uy * R.uy;
      // (Not after a stroke that set off from the ready position: that may have been a quick wind-up, and swinging back is the stroke.)
      // (Nor once it sweeps on past where that stroke set off: the arm coming back stops at the ready position.)
      const past = ((m.last.x - R.x1) * (R.x0 - R.x1) + (m.last.y - R.y1) * (R.y0 - R.y1)) / R.len2 > 1.1 && v.s >= thr;
      if (dot < -0.2 && !R.same && !R.home && !past) return m.vmax > (m.t0 - R.end < 0.6 ? 1.1 : 0.85) * R.peak ? 'stroke' : 'return';
      if (dot > 0.3 && t - R.end < O.refractory) return m.vmax > 0.9 * R.peak ? 'stroke' : 'follow';
    }
    // The serve swing comes down from up by the toss line, soon after the toss.
    if (this.serving(m, t)) return 'stroke';
    // Up or down: raising the hand, a loop's drop... A groundstroke goes across. (From the ready position a stroke without
    // a wind-up may rise steeply to its finish: that's judged once it's over, see heldVerdict.)
    if (ax < (m.home ? O.horiz : O.across)) return m.uy > 0 && m.vmax > 2.5 * thr && m.vmax > 1.3 * median(this.peaks) ? 'stroke' : 'vertical';
    // Setting off from behind the ready position toward it: a stroke. Setting off from around it: maybe the wind-up,
    // held back unless it carries on further than a racket is taken back.
    if (!m.home) return 'stroke';
    if (ax >= 0.75 && v.s >= thr && Math.hypot(m.last.x - m.x0, m.last.y - m.y0) * this.sc > 0.6) return 'stroke';
    // Clearly faster than this player's wind-ups and near their stroke speed: a stroke without a wind-up. (If it was a
    // quick wind-up after all, the swing back still counts: see recovery.) Or past its peak, having risen like a topspin
    // finish.
    const typ = this.peaks.length >= 3 ? median(this.peaks) : 0, tw = this.winds.length >= 3 ? median(this.winds) : 0;
    if (ax >= 0.75 && (typ ? m.vmax >= Math.max(0.6 * typ, 1.3 * tw, 1.5 * thr) : m.vmax >= 2.2 * thr)) return 'stroke';
    return typ && m.vmax >= 0.8 * typ && m.pk[2] && v.s < 0.85 * m.vmax && (m.y0 - m.last.y) * this.sc > 0.12 ? 'stroke' : 'windup?';
  }
  begin(m, v, t, p, o, out) {
    const O = this.o, gap = !!m.gapPk, rise = median(this.rises), k = median(this.ratios);
    const passed = m.pk && m.pk[2] && m.pk[2].s < 0.95 * m.vmax;
    let t0;
    if (passed) t0 = this.peakAt(m);
    else if (gap) t0 = m.pk[1].t;
    else {
      // When the speed will peak: when it usually does for this player, after passing the start speed.
      t0 = Math.max((m.tOn ?? v.t) + (Number.isFinite(rise) ? rise : O.rise), v.t);
    }
    const dir = strokeDir(m.ux, m.uy, o.handed);
    const sw = {
      t0, tOn: m.tOn ?? v.t, peak: 0, vx: m.pk ? m.pk[1].vx : v.vx, vy: m.pk ? m.pk[1].vy : v.vy, x: p.x, y: p.yw * p.asp, src: o.src || 'hand',
      dir, side: Math.abs(m.ux), gap, tPeak: t0, lead: t0 - t,
    };
    const e = this.ended;
    if (e && t - e.t < 0.45 && m.ux * e.ux + m.uy * e.uy < 0) sw.follows = e.sw;
    // A stroke the other way straight after one that was slower: that one was the wind-up.
    const R = this.rec;
    if (R && m.ux * R.ux + m.uy * R.uy < -0.2 && m.vmax > 1.1 * R.peak) { R.sw.role = 'windup'; this.pend = null; }
    if (this.serving(m, t)) this.served = true;
    m.sw = sw; m.cls = 'stroke'; m.v0 = m.vmax;
    // The peak speed isn't known yet: the speed so far times how much this player's swings usually still speed up
    // after they're reported (learned; a first guess from the frame rate, since slower cameras see more of the swing).
    m.pred = passed || gap ? 0 : m.vmax * (Number.isFinite(k) ? k : 1 + 0.35 * Math.pow(0.0333 / this.frameDt, 0.7));
    sw.peak = Math.max(m.vmax * (gap ? m.gapK || 1.15 : 1), m.pred);
    this.hold = null;
    out.push({ type: 'swing', swing: sw });
  }
  swung(m) { return !!m && m.vmax >= this.thr && !!m.last && Math.abs(m.last.x - m.x0) * this.sc >= 0.22; }
  endMove(m, t, out, why) {
    this.mv = null;
    if (this.swung(m)) this.swingT = t;
    this.lastMove = { t, m };
    const O = this.o;
    if (m.sw) {
      const sw = m.sw;
      sw.peak = m.vmax * (m.gapPk ? m.gapK || 1.15 : 1);
      if (m.pk) sw.tPeak = this.peakAt(m);
      sw.end = t;
      if (!sw.role) sw.role = 'stroke';
      this.ended = { t, ux: m.ux, uy: m.uy, sw, m };
      this.rec = this.recovery(m, sw, t, !!m.home);
      if (this.pend) this.learn(this.pend);
      this.pend = sw.role === 'stroke' ? { m, t } : null;
      out.push({ type: 'swingEnd', swing: sw });
      return;
    }
    if (this.held && this.held.next === m) this.resolveHeld(t, out);
    if (m.cls === 'windup?') { this.held = { m, t, until: t + O.windupWait, next: null }; return; }
    if (m.cls) this.skip(m, m.cls);
    // Once the arm has started back, a movement the same way as the stroke is taking the racket back for the next one:
    // after that, a swing the other way is a stroke again, not the return.
    const R = this.rec;
    if (R && m.vmax >= 0.45 * this.thr) {
      const dot = m.ux * R.ux + m.uy * R.uy;
      if (dot < -0.2) R.back = true;
      else if (dot > 0.3 && (R.back || m.t0 - R.end > this.o.refractory)) R.same = true;
    }
  }
  // What's expected after a stroke: the arm coming back along its path (from where it ended, x1 y1, toward where it
  // started, x0 y0). home: it set off from the ready position, so it may have been a quick wind-up.
  recovery(m, sw, t, home) {
    const x1 = m.last ? m.last.x : m.x0, y1 = m.last ? m.last.y : m.y0;
    return { sw, ux: m.ux, uy: m.uy, end: t, peak: sw.peak, same: false, back: false, home, x0: m.x0, y0: m.y0, x1, y1, len2: Math.max(1e-4, (x1 - m.x0) ** 2 + (y1 - m.y0) ** 2) };
  }
  skip(m, role) {
    if (role === 'windup' && m.cls === 'windup?' && m.vmax >= this.thr) keep(this.winds, m.vmax, 9);   // (this player's wind-up speed)
    if (m.vmax >= this.thr) this.ignored = { role, dir: strokeDir(m.ux, m.uy, this.handed), peak: m.vmax, t: m.pk ? m.pk[1].t : m.t0 };
  }
  // A held-back movement from rest that stopped: the wind-up if the hand swings back soon (see startMove), otherwise a
  // stroke after all.
  pendingCheck(t, out) {
    if (this.pend && t - this.pend.t > 0.5) { this.learn(this.pend); this.pend = null; }
    const h = this.held, v = this.lastV;
    if (!h || h.next) return;
    // Not while the hand is out of sight (the swing back may be hidden by motion blur), nor while it's already easing
    // back the other way.
    if (t - this.lastT > 1.5 * this.frameDt || (v && v.s > 0.15 * this.thr && v.vx * h.m.ux + v.vy * h.m.uy < -0.3 * v.s && t - h.t < 0.6)) h.until = Math.max(h.until, t + 0.05);
    if (t >= h.until) this.resolveHeld(t, out);
  }
  // The movement after a held-back one has passed its peak (or ended) well slower than it: the held one was the stroke.
  // Or nothing followed it: a stroke from rest without a wind-up.
  // What a held-back movement H was, given the movement N that followed it (null: nothing did): 'windup', 'stroke', or
  // null (can't tell yet). The swing after a wind-up is at least about as fast; the arm coming back after a stroke is
  // slower. A movement that rose (a topspin finish, or a loop's up-and-out) followed by a steep drop was a loop.
  heldVerdict(H, N, final) {
    const hm = H.m, typ = this.peaks.length >= 3 ? median(this.peaks) : 0, rose = (hm.y0 - hm.last.y) * this.sc > 0.1;
    if (!N) {
      const asp = this.pts.length ? this.pts[this.pts.length - 1].asp : 4 / 3;   // (a raised hand held up there is a toss)
      return (rose || (typ && hm.vmax >= 0.9 * typ)) && (Math.abs(hm.ux) >= this.o.across || hm.last.y * asp > this.o.tossLine + 0.05) ? 'stroke' : 'windup';
    }
    if (rose && Math.abs(N.ux) < 0.55 && N.uy > 0) return 'windup';
    if (N.vmax >= (rose ? 1 : 0.6) * hm.vmax) return 'windup';
    if (!final && !(N.pk && N.pk[2] && N.prev.s < 0.8 * N.vmax)) return null;
    return N.vmax < (rose ? 0.75 : 0.6) * hm.vmax || (typ && hm.vmax >= 0.8 * typ) ? 'stroke' : 'windup';
  }
  resolveHeld(t, out) {
    const h = this.held;
    this.held = null;
    if (this.heldVerdict(h, h.next, true) === 'windup' || h.m.vmax < this.thr) { this.skip(h.m, 'windup'); return; }
    if (h.next) { h.next.cls = 'return'; h.next.from = null; }
    const hm = h.m;
    // Reported late: its peak time is known by now, so the game still times it right.
    const tp = hm.pk ? this.peakAt(hm) : hm.t0;
    const sw = {
      t0: tp, tOn: hm.tOn ?? tp, peak: hm.vmax * (hm.gapPk ? hm.gapK || 1.15 : 1), vx: hm.pk ? hm.pk[1].vx : hm.ux, vy: hm.pk ? hm.pk[1].vy : hm.uy,
      x: hm.last.x, y: hm.last.y * (this.pts.length ? this.pts[this.pts.length - 1].asp : 4 / 3), src: this.src, dir: strokeDir(hm.ux, hm.uy, this.handed),
      side: Math.abs(hm.ux), gap: !!hm.gapPk, tPeak: tp, lead: tp - t, late: true, end: h.t, role: 'stroke',
    };
    this.ended = { t: h.t, ux: hm.ux, uy: hm.uy, sw, m: hm };
    this.rec = this.recovery(hm, sw, h.t, true);
    out.push({ type: 'swing', swing: sw }, { type: 'swingEnd', swing: sw });
  }
  // When a movement's speed peaked: the middle of its fast part (the samples within 20% of the top, weighted by how far
  // above that they are), which is steadier than the single fastest sample when the top is broad or noisy.
  peakAt(m) {
    if (!m.pk[2] || m.gapPk) return m.pk[1].t;
    let w = 0, wt = 0;
    for (const q of m.hist) { const k = q.s - 0.8 * m.vmax; if (k > 0 && !q.gap) { w += k; wt += k * q.t; } }
    const tp = peakTime(m.pk);
    return w > 0 ? 0.5 * (wt / w + tp) : tp;
  }
  learn(p) {
    const m = p.m, sw = m.sw;
    if (sw.gap || sw.late || sw.role !== 'stroke' || !(m.vmax > 1.2 * this.thr)) return;
    keep(this.peaks, m.vmax, 9);
    const r = sw.tPeak - sw.tOn;
    if (r > 0.01 && r < 0.3) keep(this.rises, r, 9);
    if (m.v0 > 0) keep(this.ratios, clamp(m.vmax / m.v0, 1, 2.5), 9);
  }
  // Toss: the hand raised above the toss line and held there (not swept through it by a loop), and not carried up
  // there by a stroke's follow-through.
  tossCheck(t, out) {
    const L = this.o.tossLine;
    if (this.y < L && this.valid) {
      if (!this.highSince) {
        // (Carried up there by a swing: a fast movement that also went well across, not a raise.)
        this.highSince = t; this.heldUp = 0;
        this.tossBlock = this.swung(this.mv) || t - this.swingT < this.o.tossBlock;
      }
      else if (this.speed < 0.6 * this.thr) this.heldUp += Math.min(t - this.highT, 0.1);
      this.highT = t;
      if (this.heldUp >= this.o.tossHold && !this.tossFired && !this.tossBlock) { this.tossFired = true; this.tossT = t; this.served = false; out.push({ type: 'toss' }); }
    } else {
      this.highSince = 0;
      if (this.y > L + 0.1) this.tossFired = false;
    }
  }
}

// Time of the speed peak from the samples around it (a parabola through three uneven points).
function peakTime(pk) {
  const [a, b, c] = pk;
  if (!a || !c) return b.t;
  const d1 = (b.s - a.s) / (b.t - a.t), d2 = (c.s - b.s) / (c.t - b.t), A = (d2 - d1) / (c.t - a.t);
  if (!(A < 0)) return b.t;
  return clamp((a.t + b.t) / 2 - d1 / (2 * A), a.t, c.t);
}

// ---- hand tracking helpers ----
// MediaPipe's handedness label for the racket hand. It assumes a mirrored selfie image and our frames aren't mirrored,
// so the player's right hand is labelled "Left".
const racketLabel = (handed) => (handed === 'L' ? 'Right' : 'Left');
// How sure the label is that this is the racket hand: +1 sure it is, -1 sure it's the other hand, 0 no idea.
// score is MediaPipe's handedness confidence (0.5..1); without one the label counts as fairly sure.
function labelVote(h, handed) {
  if (!h.label) return 0;
  const conf = h.score == null ? 0.8 : clamp((h.score - 0.5) * 2, 0, 1);
  return h.label === racketLabel(handed) ? conf : -conf;
}
// Which of the detected hands is the racket hand. hands: [{x, y, label, score}] palm centres in mirrored coordinates,
// with MediaPipe's label and its confidence. Returns -1 to skip the frame.
// While the racket hand's track is fresh (pred), a hand only continues it if it is near where the racket hand should
// be: within 0.3 frame widths if it is labelled as the racket hand, 0.2 if the label can't tell, but only 0.1 if it
// reads as the other hand. So when the racket hand blurs out of a frame, the other hand isn't taken for it (the
// swing detector bridges the gap), unless the two are together (a two-handed backhand).
function pickHand(hands, handed, pred) {
  if (!hands.length) return -1;
  const mine = racketLabel(handed);
  if (pred && pred.age < 0.35) {
    let best = -1, bd = Infinity;
    hands.forEach((h, i) => {
      const d = Math.hypot(h.x - pred.x, h.y - pred.y);
      if (d > clamp(0.2 + 0.125 * labelVote(h, handed), 0.1, 0.3)) return;
      const c = d + (h.label === mine ? 0 : 0.08);
      if (c < bd) { bd = c; best = i; }
    });
    return best;
  }
  let i = -1;   // the most confident racket-hand label
  hands.forEach((h, j) => { if (h.label === mine && (i < 0 || labelVote(h, handed) > labelVote(hands[i], handed))) i = j; });
  if (i >= 0 || hands.length === 1) return Math.max(i, 0);
  let best = 0;   // neither is labelled as the racket hand: take the one on the racket side of the picture
  hands.forEach((h, j) => { if ((h.x - hands[best].x) * (handed === 'L' ? -1 : 1) > 0) best = j; });
  return best;
}
// Size of the palm in frame widths (largest of wrist-to-knuckle and knuckle-to-knuckle spans, so a tilted hand
// still reads close to its real size). Used to make swing speeds the same whether you stand near or far.
function palmSize(lm, aspect = 4 / 3) {
  const d = (a, b, k = 1) => Math.hypot(lm[a].x - lm[b].x, (lm[a].y - lm[b].y) / aspect) * k;
  return Math.max(d(0, 5), d(0, 9), d(0, 17) * 1.1, d(5, 17) * 1.3);
}
const PALM_REF = 0.042;   // palm size about 1.7 m from a typical webcam: speeds are scaled to what they'd be there

// The tracked point: the middle of the palm (wrist and the four knuckles), mirrored. The fingertips smear and flail
// in a fast swing; the palm stays put on the hand and averages five points, so it jitters least.
function palmCentre(lm) {
  let sx = 0, sy = 0;
  for (const k of [0, 5, 9, 13, 17]) { sx += lm[k].x; sy += lm[k].y; }
  return { x: 1 - sx / 5, y: sy / 5 };
}
// Bounding box of a hand's landmarks in raw (unmirrored) image fractions, grown by `grow` of its size on every side.
function handBox(lm, grow = 0.3) {
  let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
  for (const p of lm) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  const gx = (x1 - x0) * grow, gy = (y1 - y0) * grow;
  return { x0: clamp(x0 - gx, 0, 1), y0: clamp(y0 - gy, 0, 1), x1: clamp(x1 + gx, 0, 1), y1: clamp(y1 + gy, 0, 1) };
}

// Palm size, steadied: a high percentile of the sizes seen over the last two seconds while the hand moved slowly.
// Tilted or half-closed hands read small and motion blur distorts, so the top of the range is the real size; it
// settles within a second or two when the player steps closer or further back.
class PalmScale {
  constructor(o = {}) { this.win = o.win || 2; this.slow = o.slow || 1.2; this.q = o.q || 0.85; this.reset(); }
  reset() { this.buf = []; this.size = 0; }
  // t seconds, size in frame widths (palmSize), speed of the hand in frame widths per second.
  push(t, size, speed = 0) {
    if (!(size > 0.004 && size < 0.5)) return this.size;
    const b = this.buf;
    if (b.length && t < b[b.length - 1].t) b.length = 0;   // clock went back
    if (!this.size) this.size = size;                      // first sight: better than nothing
    if (speed < this.slow) { b.push({ t, size }); if (b.length > 90) b.shift(); }
    while (b.length && t - b[0].t > this.win) b.shift();
    if (b.length >= 3) {
      const s = b.map((e) => e.size).sort((p, q) => p - q);
      this.size = s[Math.min(s.length - 1, Math.floor(s.length * this.q))];
    }
    return this.size;
  }
  get scale() { return this.size ? clamp(PALM_REF / this.size, 0.8, 1.5) : 1; }
}

// Follows the racket hand from frame to frame (pickHand), and keeps a running vote of what MediaPipe's labels say
// about the hand it follows. A hand that keeps reading as the off hand while another reads as the racket hand is the
// wrong one: switch. Labels are unreliable on a blurred hand, so they count for little mid-swing.
class HandPicker {
  constructor(o = {}) { this.settle = o.settle || 6; this.reset(); }
  reset() { this.vote = 0; this.n = 0; this.wait = 0; }
  // Returns {i, switched}: i = -1 skips the frame; switched: now following a different hand (restart its track).
  pick(hands, handed, pred, moving = false) {
    const fresh = !!pred && pred.age < 0.35;
    let i = pickHand(hands, handed, fresh ? pred : null), switched = false;
    if (i < 0) { if (!hands.length) this.wait = 0; return { i, switched }; }
    if (!fresh) {
      // Picking a hand up afresh. One labelled as the racket hand is taken at once; any other must stay in view for a
      // few frames first: the racket hand may only be blurred or just out of the picture while the other hand is still.
      if (labelVote(hands[i], handed) > 0.3) this.wait = 0;
      else if (++this.wait < this.settle) return { i: -1, switched };
      this.vote = 0; this.n = 0;
    }
    if (hands.length > 1 && !moving && this.n >= 5 && this.vote < -0.45) {
      let j = -1;
      hands.forEach((h, k) => { if (k !== i && labelVote(h, handed) > 0.5 && (j < 0 || labelVote(h, handed) > labelVote(hands[j], handed))) j = k; });
      if (j >= 0) { i = j; switched = true; this.vote = labelVote(hands[j], handed); this.n = 1; return { i, switched }; }
    }
    const k = moving ? 0.04 : 0.15;
    this.vote += (labelVote(hands[i], handed) - this.vote) * k;
    this.n++;
    return { i, switched };
  }
}
export { racketLabel, labelVote, palmCentre, handBox, PalmScale, HandPicker };

// ---- paddle color tracking ----
function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dl = mx - mn;
  let h = 0;
  if (dl > 0) { h = mx === r ? (g - b) / dl : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4; h *= 60; if (h < 0) h += 360; }
  return { h, s: mx ? dl / mx : 0, v: mx / 255 };
}
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// Skin, lips, wooden handles and tan walls share a band of warm hues at moderate saturation; paddle rubber is far more
// saturated. Pixels in that band only count as paddle when they're more saturated than skin gets, so a red or orange
// paddle's color never spreads onto the hand holding it or the player's face, however the lighting drifts.
const SKIN = { h0: 5, h1: 42, s: 0.6 };
const skinLike = (h, s) => s < SKIN.s && h >= SKIN.h0 && h <= SKIN.h1;
const LOCK_R = 12 / 160;   // radius of the lock circle, frame widths (the camera check draws it there)
// What a lock attempt says to the player (lockColorFromPatch's info.reason → message).
const LOCK_MSG = {
  ok: 'Paddle color locked. Swing to test it.',
  others: 'Paddle color locked, but other things in view have the same color (red in the camera check). Move them out of view if tracking jumps.',
  big: 'Locked, but that color covers a big area. Is it the paddle? Clothes of the same color confuse the tracker.',
  black: 'Black rubber can’t be tracked. Turn the paddle to its colored side (red or blue works best).',
  dark: 'Too dark to see the paddle’s color. Turn on a light or face a window.',
  grey: 'No color in the circle. Hold the paddle’s colored face inside it.',
  skin: 'That looks like skin. Hold the paddle’s rubber, not your hand, in the circle.',
  dull: 'That color is too dull to track. Try the red side of the paddle, in good light.',
  mixed: 'No single clear color in the circle. Fill it with the paddle’s face.',
};
const colorName = (h) => (h < 12 || h >= 335 ? 'red' : h < 45 ? 'orange' : h < 70 ? 'yellow' : h < 165 ? 'green' : h < 195 ? 'cyan' : h < 260 ? 'blue' : h < 295 ? 'purple' : 'pink');

// The pixels inside the lock circle of a W×H frame (RGBA bytes).
function lockPatch(px, W, H) {
  const r = LOCK_R * W, cx = W / 2, cy = H / 2, out = [];
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(H, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(W, Math.ceil(cx + r)); x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
      const i = (y * W + x) * 4;
      out.push(px[i], px[i + 1], px[i + 2], 255);
    }
  }
  return Uint8ClampedArray.from(out);
}
// Mean brightness (0..1) of a frame, from every 7th pixel.
function frameValue(px) {
  let s = 0, n = 0;
  for (let i = 0; i < px.length; i += 28) { s += Math.max(px[i], px[i + 1], px[i + 2]); n++; }
  return n ? s / n / 255 : 0;
}

// Paddle color from the pixels held in the lock circle (RGBA bytes, from one or several frames): the dominant
// saturated hue, not the plain average, so a bit of hand or background doesn't shift it. The tolerance comes from how
// much the paddle's own hue varies. Returns null when there's no trackable color; info (optional, pass frameV = the
// whole frame's brightness to tell black rubber from a dark room) then gets reason (black, dark, grey, skin, dull,
// mixed) and msg for the player, and on success reason 'ok', name ('red', 'blue'…) and share (of the circle).
function lockColorFromPatch(px, info = {}) {
  const N = px.length / 4, hist = new Float32Array(36), all = [];
  let dark = 0, grey = 0, skin = 0, blk = 0, vs = 0;
  for (let i = 0; i < px.length; i += 4) {
    const c = hsv(px[i], px[i + 1], px[i + 2]);
    vs += c.v;
    if (c.v < 0.3 && c.s < 0.35) blk++;
    if (c.v < 0.16) dark++;
    else if (c.s < 0.25) grey++;
    else if (skinLike(c.h, c.s)) skin++;
    else { c.r = px[i]; c.g = px[i + 1]; c.b = px[i + 2]; all.push(c); hist[Math.floor(c.h / 10) % 36] += c.s * c.s; }
  }
  const fail = (why) => { info.reason = why; info.msg = LOCK_MSG[why]; return null; };
  let pb = 0, pw = -1;
  for (let k = 0; k < 36; k++) { const w = hist[(k + 35) % 36] + hist[k] + hist[(k + 1) % 36]; if (w > pw) { pw = w; pb = k; } }
  const mean = (sel) => {
    let hx = 0, hy = 0;
    for (const c of sel) { hx += c.s * Math.cos((c.h * Math.PI) / 180); hy += c.s * Math.sin((c.h * Math.PI) / 180); }
    return ((Math.atan2(hy, hx) * 180) / Math.PI + 360) % 360;
  };
  // The peak's hue, then again from just the pixels close to it.
  let h = mean(all.filter((c) => hueDist(c.h, pb * 10 + 5) <= 15));
  const sel = all.filter((c) => hueDist(c.h, h) <= 12);
  info.share = N ? sel.length / N : 0;
  // The paddle may fill only part of the circle, but its color must be most of the color in it.
  if (!N || sel.length < Math.max(0.12 * N, 0.5 * all.length)) {
    if ((info.frameV ?? vs / Math.max(1, N)) < 0.22) return fail('dark');
    if (blk >= 0.2 * N) return fail('black');
    if (skin >= Math.max(grey, all.length)) return fail('skin');
    return fail(dark + grey >= 0.5 * N ? 'grey' : 'mixed');
  }
  h = mean(sel);
  let ss = 0, vv = 0, R = 0, G = 0, B = 0, sd = 0;
  for (const c of sel) { ss += c.s; vv += c.v; R += c.r; G += c.g; B += c.b; sd += hueDist(c.h, h) ** 2; }
  const n = sel.length, s = ss / n, v = vv / n;
  if (v < 0.18) return fail('dark');
  if (s < 0.35) return fail('dull');
  info.reason = 'ok'; info.msg = LOCK_MSG.ok; info.name = colorName(h);
  return { h, s, v, tol: clamp(2.2 * Math.sqrt(sd / n) + 7, 9, 18), css: `rgb(${(R / n) | 0},${(G / n) | 0},${(B / n) | 0})`, name: info.name, ver: 2 };
}
// A saved paddle color (Settings.paddle) made safe to use, or null. Colors saved by older versions (no name, no size)
// work as they are.
function clampLock(p) {
  if (!p || typeof p !== 'object' || ![p.h, p.s, p.v].every(Number.isFinite)) return null;
  const h = ((p.h % 360) + 360) % 360;
  return { h, s: clamp(p.s, 0.2, 1), v: clamp(p.v, 0.05, 1), tol: clamp(Number.isFinite(p.tol) ? p.tol : 16, 8, 22), d: Number.isFinite(p.d) ? clamp(p.d, 0, 0.5) : 0, css: typeof p.css === 'string' ? p.css : '', name: typeof p.name === 'string' ? p.name : colorName(h) };
}

// Find the paddle in a frame (RGBA bytes, W×H, raw, not mirrored). Pixels close to the target color form blobs.
// Strict pixels need the paddle's saturation and brightness; near where the paddle is expected (opt.pred {x, y, r},
// mirrored coordinates) paler / darker pixels of the same hue count too, weighted by how saturated they are, which
// keeps a motion-blurred paddle and gives a sub-pixel centroid. Skin-like pixels never count (see SKIN).
// opt.expect {x, y, d, reach, smear, far, acquire} scores the blobs: size close to the paddle's diameter d (frame
// widths; blur may stretch it by smear), close to x, y (within reach), not sitting on known clutter (opt.clutter).
// Without it, the biggest blob wins. The winner is completed: pieces split off by a finger are merged back and holes
// (specular highlights) filled before its centroid and axes are measured.
// Returns {x, y, n, strict, hue, sat, val, w, h, d, minor, big, score, id} for the blob (x, y mirrored, d/minor its
// axes in frame widths), or null. opt.roi [x0, y0, x1, y1] (pixels) limits the scan. opt.scratch keeps the buffers
// between frames; scratch.mask (2 strict, 1 loose), scratch.lab and scratch.best let the caller draw what matched,
// scratch.blobs lists every blob.
function segmentColor(px, W, H, tg, opt = {}) {
  const n = W * H, S = opt.scratch || {};
  if (!S.mask || S.mask.length !== n) {
    S.mask = new Uint8Array(n); S.lab = new Int32Array(n); S.stack = new Int32Array(n); S.wt = new Float32Array(n); S.hd = new Float32Array(n);
    S.rA = new Int32Array(H); S.rB = new Int32Array(H); S.cA = new Int32Array(W); S.cB = new Int32Array(W); S.nbr = new Uint8Array(n);
  }
  const { mask, lab, stack, wt, hd, nbr } = S;
  const th = tg.h, tol = tg.tol || 16, smin = Math.max(0.28, tg.s * 0.68), vmin = Math.max(0.12, tg.v * 0.38);
  const ls = Math.max(0.15, smin * 0.5), lv = Math.max(0.07, vmin * 0.6) * 255, vm = vmin * 255, ltol = Math.max(8, tol * 0.75), wk = 0.65 / Math.max(0.05, smin - ls);
  const P = opt.pred, k2 = (W * W) / (160 * 160);
  let rx0 = 1, rx1 = 0, ry0 = 1, ry1 = 0;
  if (P) { const cx = (1 - P.x) * W, cy = P.y * H, r = Math.max(4, P.r * W); rx0 = cx - r; rx1 = cx + r; ry0 = cy - r; ry1 = cy + r; }
  const R = opt.roi, X0 = R ? clamp(R[0] | 0, 0, W) : 0, Y0 = R ? clamp(R[1] | 0, 0, H) : 0, X1 = R ? clamp(Math.ceil(R[2]), X0, W) : W, Y1 = R ? clamp(Math.ceil(R[3]), Y0, H) : H;
  if (R) mask.fill(0);
  for (let y = Y0; y < Y1; y++) {
    const ly = y >= ry0 && y <= ry1;
    for (let x = X0, p = y * W + X0, i = p * 4; x < X1; x++, p++, i += 4) {
      mask[p] = 0;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b, mn = r < g ? (r < b ? r : b) : g < b ? g : b, dl = mx - mn;
      if (dl < 12 || mx < lv || dl < ls * mx) continue;
      let h = mx === r ? (g - b) / dl : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4;
      h *= 60; if (h < 0) h += 360;
      let dd = h - th; if (dd > 180) dd -= 360; else if (dd < -180) dd += 360;
      const ad = dd < 0 ? -dd : dd, s = dl / mx;
      if (ad > tol || (s < SKIN.s && h >= SKIN.h0 && h <= SKIN.h1)) continue;
      if (s >= smin && mx >= vm) { mask[p] = 2; wt[p] = 1; }
      else if (ly && ad <= ltol && x >= rx0 && x <= rx1) { mask[p] = 1; wt[p] = Math.min(0.9, 0.25 + (s - ls) * wk); }
      else continue;
      hd[p] = dd;
    }
  }
  // Lone pixels and pairs are noise (dim rooms): keep only pixels with at least two matching neighbours.
  for (let y = Y0; y < Y1; y++) for (let x = X0, p = y * W + X0; x < X1; x++, p++) {
    if (mask[p]) nbr[p] = (x > 0 && mask[p - 1] ? 1 : 0) + (x < W - 1 && mask[p + 1] ? 1 : 0) + (y > 0 && mask[p - W] ? 1 : 0) + (y < H - 1 && mask[p + W] ? 1 : 0);
  }
  for (let y = Y0; y < Y1; y++) for (let p = y * W + X0, pe = y * W + X1; p < pe; p++) if (mask[p] && nbr[p] < 2) mask[p] = 0;
  // Blobs (4-connected), with their weighted centroid and second moments.
  lab.fill(0);
  S.alt = null;
  const blobs = (S.blobs = []), CL = opt.clutter, E = opt.expect || (P ? { x: P.x, y: P.y, reach: 0.2, far: 0.3 } : null);
  const IN = E && E.inside ? { x: (1 - E.x) * W, y: E.y * H, r2: (E.inside * W) ** 2 } : null;   // pick what fills this circle
  if (CL) {
    // Known clutter is left out (lab -1), so a paddle right next to it stays a blob of its own; except where the
    // paddle should be now (opt.keep {x, y, r}), as it may be passing in front of it.
    const C = CL.C, K = opt.keep, kx = K ? (1 - K.x) * W : 0, ky = K ? K.y * H : 0, kr2 = K ? (K.r * W) ** 2 : -1;
    for (let y = Y0; y < Y1; y++) {
      for (let x = X0, p = y * W + X0; x < X1; x++, p++) if (mask[p] && C[p] > 0.5 && (x + 0.5 - kx) ** 2 + (y + 0.5 - ky) ** 2 > kr2) lab[p] = -1;
    }
  }
  let nb = 0, best = null, bestScore = 0;
  for (let y = Y0; y < Y1; y++) for (let p0 = y * W + X0, pe = y * W + X1; p0 < pe; p0++) {
    if (!mask[p0] || lab[p0]) continue;
    const id = ++nb;
    let sp = 0, np = 0, ns = 0, sw = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sh = 0, ss = 0, sv = 0, cm = 0, sin = 0, x0 = W, x1 = 0, yA = H, yB = 0;
    stack[sp++] = p0; lab[p0] = id;
    while (sp) {
      const q = stack[--sp], x = q % W, yy = (q / W) | 0, w = CL ? wt[q] * Math.max(0.02, 1 - 1.2 * CL.C[q]) : wt[q], fx = x + 0.5, fy = yy + 0.5;
      np++; sw += w; sx += fx * w; sy += fy * w; sxx += fx * fx * w; syy += fy * fy * w; sxy += fx * fy * w;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (yy < yA) yA = yy; if (yy > yB) yB = yy;
      if (mask[q] === 2) {
        ns++; sh += hd[q];
        const i = q * 4, r = px[i], g = px[i + 1], b = px[i + 2], mx = r > g ? (r > b ? r : b) : g > b ? g : b, mn = r < g ? (r < b ? r : b) : g < b ? g : b;
        ss += (mx - mn) / mx; sv += mx;
      }
      if (CL) cm += CL.C[q];
      if (IN && (fx - IN.x) ** 2 + (fy - IN.y) ** 2 < IN.r2) sin += w;
      if (x > 0 && mask[q - 1] && !lab[q - 1]) { lab[q - 1] = id; stack[sp++] = q - 1; }
      if (x < W - 1 && mask[q + 1] && !lab[q + 1]) { lab[q + 1] = id; stack[sp++] = q + 1; }
      if (yy > 0 && mask[q - W] && !lab[q - W]) { lab[q - W] = id; stack[sp++] = q - W; }
      if (yy < H - 1 && mask[q + W] && !lab[q + W]) { lab[q + W] = id; stack[sp++] = q + W; }
    }
    const cx = sx / sw, cy = sy / sw, ax = axes(sxx / sw - cx * cx, syy / sw - cy * cy, sxy / sw - cx * cy);
    const bl = { id, n: sw, np, strict: ns, cx, cy, x0, x1, y0: yA, y1: yB, major: ax[0], minor: ax[1], dh: ns ? sh / ns : 0, sat: ns ? ss / ns : 0, val: ns ? sv / ns / 255 : 0, cm: cm / np, inside: sin, score: 0 };
    blobs.push(bl);
    if (sw < 6 * k2 || (ns < 4 * k2 && !P)) continue;   // specks; loose pixels alone only count near the prediction
    blobScore(bl, E, W, H);
    if (bl.score > bestScore) { bestScore = bl.score; best = bl; }
    if (!S.alt || bl.shape > S.alt.shape) S.alt = bl;
  }
  if (best) finishBlob(best, S, W, H, E, CL);
  S.best = best ? best.id : 0;
  if (!best) return null;
  return {
    x: 1 - best.cx / W, y: best.cy / H, n: best.n, strict: best.strict, hue: (th + best.dh + 360) % 360, sat: best.sat, val: best.val,
    w: (best.x1 - best.x0 + 1) / W, h: (best.y1 - best.y0 + 1) / H, d: best.major / W, minor: best.minor / W, big: best.big, holes: best.holes, cm: best.cm, shape: best.shape, score: bestScore, id: best.id,
  };
}
// Full axis lengths of the uniform ellipse with these second moments (pixels).
function axes(a, c, b) {
  const m = (a + c) / 2, q = Math.sqrt(Math.max(0, ((a - c) / 2) ** 2 + b * b));
  return [4 * Math.sqrt(Math.max(0, m + q)), 4 * Math.sqrt(Math.max(0, m - q))];
}
// How much a blob looks like the paddle (see segmentColor's opt.expect): b.shape from its size and whether it's known
// clutter, b.score that times how close it is to where the paddle should be.
function blobScore(b, E, W, H) {
  let s = b.n;
  if (!E) return (b.shape = b.score = s);
  if (E.inside) return (b.shape = b.score = b.inside);
  const D = (E.d || 0) * W, sm = (E.smear || 0) * W;
  if (D > 0) {
    const A = 0.785 * D * D;
    s = Math.min(s, 1.6 * A + sm * D);                       // bigger than the paddle earns nothing more…
    const hi = b.major / (1.6 * D + sm), lo = b.major / (0.65 * D), big = b.n / (2.2 * A + 1.2 * sm * D);
    if (hi > 1) s *= Math.exp(-((Math.log(hi) / 0.4) ** 2));  // …and much bigger or smaller loses (seen edge-on, the
    if (lo < 1) s *= Math.exp(-((Math.log(lo) / 0.5) ** 2));  // long axis stays the paddle's width)
    if (big > 1) s *= Math.exp(-((Math.log(big) / 0.6) ** 2));
  }
  if (b.cm) s *= Math.max(E.acquire ? 0.02 : 0.3, 1 - (E.acquire ? 2 : 0.8) * b.cm);   // a same-colored thing that stays put
  b.shape = s;
  const dist = Math.hypot(1 - b.cx / W - E.x, ((b.cy / H - E.y) * H) / W) / Math.max(0.01, E.reach);
  return (b.score = s * (1 / (1 + dist ** 4) + (E.far || 0)));
}
// Complete the chosen blob: merge nearby pieces that together stay paddle-sized (a finger across the rubber splits
// it), fill holes inside it (specular highlights, the finger itself), then measure it again. A blob much bigger than
// the paddle (it touches a same-colored shirt) is measured only around where the paddle is expected.
function finishBlob(b, S, W, H, E, CL) {
  const { mask, lab, wt, rA, rB, cA, cB } = S, D = E && E.d ? E.d * W : 0, sm = E && E.smear ? E.smear * W : 0, id = b.id;
  const lim = (D ? 1.5 * D + sm : Math.max(b.major * 1.4, 6)) * 1.15, g = Math.max(1.5, 0.25 * (D || b.major));
  let x0 = b.x0, x1 = b.x1, y0 = b.y0, y1 = b.y1;
  for (const o of S.blobs) {
    if (o === b || o.x0 > x1 + g || o.x1 < x0 - g || o.y0 > y1 + g || o.y1 < y0 - g) continue;
    const ux0 = Math.min(x0, o.x0), ux1 = Math.max(x1, o.x1), uy0 = Math.min(y0, o.y0), uy1 = Math.max(y1, o.y1);
    if (Math.hypot(ux1 - ux0 + 1, uy1 - uy0 + 1) > Math.max(lim, Math.hypot(x1 - x0 + 1, y1 - y0 + 1))) continue;
    for (let y = o.y0; y <= o.y1; y++) for (let x = o.x0; x <= o.x1; x++) if (lab[y * W + x] === o.id) lab[y * W + x] = id;
    o.merged = id; x0 = ux0; x1 = ux1; y0 = uy0; y1 = uy1;
  }
  for (let y = y0; y <= y1; y++) { rA[y] = W; rB[y] = -1; }
  for (let x = x0; x <= x1; x++) { cA[x] = H; cB[x] = -1; }
  for (let y = y0; y <= y1; y++) for (let x = x0, p = y * W + x0; x <= x1; x++, p++) {
    if (lab[p] !== id) continue;
    if (x < rA[y]) rA[y] = x; if (x > rB[y]) rB[y] = x; if (y < cA[x]) cA[x] = y; if (y > cB[x]) cB[x] = y;
  }
  // Holes are only filled in a solid blob: a ragged one (noise, blur) would grow into its surroundings.
  let own = 0, gaps = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0, p = y * W + x0; x <= x1; x++, p++) {
    if (lab[p] === id) own++;
    else if (x > rA[y] && x < rB[y] && y > cA[x] && y < cB[x]) gaps++;
  }
  const fill = gaps <= 0.35 * own, A = 0.785 * D * D, big = D > 0 && b.n > 2.2 * A + 1.2 * sm * D;
  let wx = 0, wy = 0, wr = Infinity;
  if (big) { wx = (1 - E.x) * W; wy = E.y * H; wr = 0.7 * D + 0.5 * sm; }
  let sw = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, holes = 0;
  for (let it = 0; it < (big ? 3 : 1); it++) {
    sw = sx = sy = sxx = syy = sxy = holes = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0, p = y * W + x0; x <= x1; x++, p++) {
      let w;
      if (lab[p] === id) w = wt[p] * (CL ? Math.max(0.02, 1 - 1.2 * CL.C[p]) : 1);   // known clutter it touches hardly counts
      else if (fill && x > rA[y] && x < rB[y] && y > cA[x] && y < cB[x]) {   // inside the blob both across and down: a hole
        w = 1; holes++;
        if (!it) { mask[p] = 1; wt[p] = 1; lab[p] = id; }
      } else continue;
      const fx = x + 0.5, fy = y + 0.5;
      if (big && (fx - wx) ** 2 + (fy - wy) ** 2 > wr * wr) continue;
      sw += w; sx += fx * w; sy += fy * w; sxx += fx * fx * w; syy += fy * fy * w; sxy += fx * fy * w;
    }
    if (!(sw > 0)) break;
    if (big) { wx = sx / sw; wy = sy / sw; }
  }
  if (!(sw > 0)) return;
  const cx = sx / sw, cy = sy / sw, ax = axes(sxx / sw - cx * cx, syy / sw - cy * cy, sxy / sw - cx * cy);
  b.cx = cx; b.cy = cy; b.major = ax[0]; b.minor = ax[1]; b.n = big ? b.n : sw; b.holes = holes; b.big = big;
  b.x0 = x0; b.x1 = x1; b.y0 = y0; b.y1 = y1;
}

// Follows the paddle from frame to frame: where it should be (constant velocity from the last two sightings), how big
// it is (learned while it's held fairly still), and which pixels of its color belong to things in the room that stay
// put (a red book, a poster, a shirt: the clutter map), so a lost paddle is never swapped for one of them. step() runs segmentColor with all that
// and decides whether its blob is believable. Positions are mirrored like segmentColor's; t in seconds.
class PaddleTrack {
  constructor() { this.S = {}; this.CL = null; this.reset(); }
  reset(lock) {
    this.hist = []; this.cand = null; this.home = { x: 0.5, y: 0.5 }; this.d = lock && lock.d > 0 ? lock.d : 0;
    this.last = null; this.found = false; this.conf = 0; this.weak = 0; this.frames = 0; this.hits = 0; this.jumps = 0; this.others = 0;
    if (this.CL) this.CL.C.fill(0);
  }
  predict(t) {
    const h = this.hist, a = h[h.length - 1], b = h[h.length - 2];
    if (!a) return null;
    let vx = 0, vy = 0;
    if (b && a.t > b.t && a.t - b.t < 0.12) { vx = (a.x - b.x) / (a.t - b.t); vy = (a.y - b.y) / (a.t - b.t); }
    const age = t - a.t, k = clamp(age, 0, 0.1);
    return { x: a.x + vx * k, y: a.y + vy * k, vx, vy, age };
  }
  // The clutter map: per pixel, how much it lately matched the paddle's color while not being the paddle.
  clutter(W, H) {
    if (this.CL && this.CL.W === W && this.CL.H === H) return this.CL;
    return (this.CL = { W, H, C: new Float32Array(W * H) });
  }
  // Pixels of the other blobs (not specks) are clutter, all others not; the map follows at this rate. Returns how many
  // clutter pixels there are now.
  learnClutter(W, H, id, rate) {
    const { mask, lab, blobs } = this.S, C = this.CL.C;
    let o = 0;
    for (let p = 0, n = W * H; p < n; p++) {
      const l = lab[p], on = l !== 0 && l !== id && mask[p] !== 0 && (l < 0 || blobs[l - 1].np >= 4);
      if (on) o++;
      C[p] += ((on ? 1 : 0) - C[p]) * rate;
    }
    return o;
  }
  // One frame (RGBA bytes, W×H, raw) at time t with the working color tg. Returns segmentColor's blob, or null.
  step(px, W, H, t, tg, o = {}) {
    const asp = W / H, p = this.predict(t), CL = this.clutter(W, H), d = this.d, tracking = !!p && p.age < 0.45;
    let E, pred = null, keep = null, sp = 0;
    this.frames++; this.found = false; this.conf = 0;
    if (tracking) {
      // How far the paddle can have got from the prediction: its own size, plus what a hand can change in that time.
      sp = Math.hypot(p.vx, p.vy / asp);
      const reach = 0.02 + 0.5 * (d || 0.06) + Math.min(Math.max(p.age, 0.016), 0.3) * (0.3 * sp + 1.2);
      // Pale (blurred) pixels only count in a window that doesn't grow while the paddle is lost: lips and pink things
      // look just like a smeared red paddle.
      pred = { x: p.x, y: p.y, r: Math.min(0.25, 0.02 + 0.6 * (d || 0.06) + 0.06 * sp) };
      keep = { x: p.x, y: p.y, r: 0.01 + 0.6 * (d || 0.06) + 0.3 * sp * Math.min(p.age, 0.1) };
      E = { x: p.x, y: p.y, d, reach, smear: sp * 0.035 };
    } else E = { x: this.home.x, y: this.home.y, d, reach: 0.4, far: 0.2, acquire: true };
    const b = segmentColor(px, W, H, tg, { pred, expect: E, keep, scratch: this.S, roi: o.roi, clutter: CL }), alt = this.S.alt;
    if (!b) { this.weak++; return null; }
    const dist = Math.hypot(b.x - E.x, (b.y - E.y) / asp), sizeOk = !d || (b.d > 0.6 * d && b.d < 1.6 * d + (E.smear || 0) && !b.big);
    // Not paddle-sized (half hidden, or lips, a toy): only if it carries straight on from the track. On known clutter:
    // only if paddle-sized, and that much surer when it carries on the track.
    const onTrack = tracking && dist < 0.5 * E.reach;
    if ((!sizeOk && !onTrack) || b.cm > (!sizeOk ? 0.3 : onTrack ? 0.7 : 0.45)) { this.weak++; return null; }
    // Something far from where the paddle can be: another thing of its color, unless it keeps showing up there while
    // the paddle stays out of sight (then it's the paddle, found again). Also a blob far more paddle-like than the one
    // being followed while that one looks wrong: the track latched onto something (lips, a toy) while the paddle was
    // hidden, so after a few frames of that it starts again from there.
    let far = null;
    if (tracking && dist > 1.6 * E.reach) far = b;
    else if (tracking && alt && alt.id !== b.id && alt.merged !== b.id && this.weak >= 2 && alt.cm < 0.25 && alt.shape > 3 * b.shape) far = { x: 1 - alt.cx / W, y: alt.cy / H, cm: alt.cm };
    if (far) {
      const c = this.cand, same = c && t - c.t < 0.15 && Math.hypot(far.x - c.x, (far.y - c.y) / asp) < 0.03 + (d || 0.06);
      this.cand = { x: far.x, y: far.y, t, n: same ? c.n + 1 : 1 };
      if (far !== b) {
        if (this.cand.n >= 3) { this.hist.length = 0; this.home.x = far.x; this.home.y = far.y; this.cand = null; this.jumps++; this.weak++; return null; }
      } else if (this.cand.n < (p.age > 0.15 ? 2 : 4) || b.cm > 0.3) { this.jumps++; this.weak++; return null; }
      else this.hist.length = 0;
    } else this.cand = null;
    if (!tracking) this.hist.length = 0;
    this.hist.push({ t, x: b.x, y: b.y });
    if (this.hist.length > 4) this.hist.shift();
    this.home.x = b.x; this.home.y = b.y; this.found = true; this.hits++; this.last = b;
    // Confident: where it should be, the size it should be (blur stretches it), mostly its full color. Only then learn
    // its size (face-on and slow) and the clutter around it.
    const strict = b.strict > 0.5 * b.n;
    this.conf = (tracking ? (dist < E.reach ? 0.5 : 0.2) : 0.3) + (sizeOk ? 0.3 : 0) + (strict ? 0.2 : 0);
    this.weak = this.conf >= 0.8 ? 0 : this.weak + 1;
    // The size follows a clearly seen paddle on a continuous track even when it's off (the player locked it up close,
    // then stepped back).
    if ((this.conf >= 0.8 || onTrack || !d) && strict && !b.big && b.cm < 0.3 && b.minor > 0.6 * b.d && sp < 0.6) this.d = d ? d + (clamp(b.d, d * 0.7, d * 1.4) - d) * 0.12 : b.d;
    if (this.conf >= 0.8 && tracking && !o.roi) this.others = this.learnClutter(W, H, b.id, 0.04);
    return b;
  }
  // Right after a lock, on the same frame: the paddle is the blob in the lock circle. Its size seeds the tracker and
  // everything else of its color is clutter from the start. Returns {d, others, big}: others is how much else in view
  // matches, as a share of the paddle; big means the "paddle" is far bigger than the circle (a shirt?).
  prime(px, W, H, tg) {
    this.reset();
    const CL = this.clutter(W, H), c = { x: 0.5, y: 0.5 };
    const b = segmentColor(px, W, H, tg, { pred: { ...c, r: LOCK_R * 1.4 }, expect: { ...c, inside: LOCK_R }, scratch: this.S });
    const ok = !!b && Math.hypot(b.x - 0.5, ((b.y - 0.5) * H) / W) < LOCK_R * 1.5, o = this.learnClutter(W, H, ok ? b.id : -1, 1);
    if (ok) this.d = b.d;
    return { d: ok ? b.d : 0, others: o / Math.max(1, ok ? b.n : 1), big: ok && b.d > 4 * LOCK_R };
  }
}
export { hueDist, SKIN, skinLike, LOCK_R, LOCK_MSG, colorName, lockPatch, frameValue, clampLock, PaddleTrack };

// Follow slow lighting changes (auto exposure, white balance): nudge the working color toward what the tracked blob
// looks like now, but never far from the color that was locked, and never toward skin.
function adaptColor(cur, lock, st, k = 0.05) {
  let dh = st.hue - cur.h; if (dh > 180) dh -= 360; if (dh < -180) dh += 360;
  let off = cur.h + dh * k - lock.h; if (off > 180) off -= 360; if (off < -180) off += 360;
  const toSkin = hueDist(lock.h + off, (SKIN.h0 + SKIN.h1) / 2) < hueDist(lock.h, (SKIN.h0 + SKIN.h1) / 2);
  const lim = toSkin && hueDist(lock.h, (SKIN.h0 + SKIN.h1) / 2) < 60 ? 4 : 8;
  return {
    h: (lock.h + clamp(off, -lim, lim) + 360) % 360,
    s: clamp(cur.s + (st.sat - cur.s) * k, lock.s * 0.65, Math.min(1, lock.s * 1.25)),
    v: clamp(cur.v + (st.val - cur.v) * k, lock.v * 0.35, Math.min(1, lock.v * 1.8)),
    tol: lock.tol || 16,
  };
}

export { SWING, strokeDir, judgeCameraSwing, OneEuro2, SwingDetector, peakTime, pickHand, palmSize, PALM_REF, hsv, lockColorFromPatch, segmentColor, adaptColor };
