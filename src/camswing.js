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
    this.rises = []; this.ratios = []; this.peaks = []; this.noise = []; this.gaps = [];
    this.frameDt = 1 / 30; this.sigma = 0.003; this.thr = this.o.start; this.sc = 1; this.fresh = -9;
    this.home = null; this.highSince = 0; this.tossFired = false; this.tossBlock = false; this.tossT = -9; this.glitches = 0;
    this.ignored = null;   // the last movement fast enough to be a swing that wasn't one: {role, dir, peak, t}
    this.reset();
  }
  reset() {
    this.pts = []; this.alt = []; this.lastV = null; this.mv = null; this.hold = null; this.ended = null; this.rec = null; this.pend = null;
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
    if (v.gap) this.fresh = t;
    const pre = this.lastV;
    if (!m && v.s >= on && !v.gap) m = this.startMove(v, t, p, why);
    // A swing hidden by motion blur: the hand turns up much further on after the gap, and it was either already heading
    // that way or set off from where the racket was held back. (Reported only if the next frame carries on, see judge.)
    else if (!m && v.gap && v.s >= thr && this.gapSwing(v, pre)) m = this.startMove(v, t, p, 'gap');
    if (m && !m.sw && (v.s >= thr || m.cls === 'gap?')) this.judge(m, v, t, p, o, out);
  }
  gapSwing(v, pre) {
    if (pre && !pre.gap && pre.s >= 0.3 * this.thr && pre.vx * v.vx + pre.vy * v.vy > 0.5 * pre.s * v.s) return true;
    const ux = v.vx / v.s, uy = v.vy / v.s, h = this.home, H = this.held;
    if (H && !H.next && ux * H.m.ux + uy * H.m.uy < -0.5) return true;
    return !!h && ((v.x0 - h.x) * ux + (v.y0 - h.y) * uy) * this.sc < -0.07;
  }
  startMove(v, t, p, why) {
    const turned = why === 'reversal' || why === 'turn', lm = this.lastMove;
    const dx = p.x - v.x0, dy = p.yw - v.y0, d = Math.hypot(dx, dy);
    const ux = d > 1e-6 ? dx / d : v.vx / v.s, uy = d > 1e-6 ? dy / d : v.vy / v.s;
    const pv = this.lastV && !turned && t - this.lastV.t < 0.1 ? this.lastV : null;
    const m = {
      t0: v.t, x0: v.x0, y0: v.y0, ux, uy, n: 0, vmax: 0, pk: null, prev: pv, pprev: null, tOn: null, v0: 0, cls: null, sw: null,
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
    const H = this.held;
    if (H && H.next === m && m.pk && m.pk[2] && v.s < 0.8 * m.vmax && m.vmax < 0.7 * H.m.vmax) this.resolveHeld(p.t, this.out);
    // The way it set off (for telling when it turns: a loop's drop turning into the swing).
    if (m.n === 2) { m.rx = m.ux; m.ry = m.uy; }
    if (m.sw) {
      const sw = m.sw, passed = m.pk && m.pk[2] && m.pk[2].s < 0.95 * m.vmax;
      if (passed) { sw.tPeak = peakTime(m.pk); sw.peak = m.vmax * (m.gapPk ? 1.15 : 1); }
      else sw.peak = Math.max(m.vmax * (m.gapPk ? 1.15 : 1), m.pred || 0);
    }
  }
  // Decide what a movement fast enough to be a swing is (again every frame until it's reported, so it can be upgraded).
  judge(m, v, t, p, o, out) {
    const O = this.o, thr = this.thr, b = m.pprev;
    if (m.cls === 'glitch?') return;
    if (m.cls === 'gap?') {
      // Seen across a tracking gap: only if this frame carries on the same way (a glitch jumps back or sits still).
      if (v.gap) return;
      if (v.s < 0.25 * thr || v.vx * m.ux + v.vy * m.uy < 0.3 * v.s) { m.cls = 'glitch?'; return; }
    } else if (!m.cls && !(b && b.s >= (v.gap ? 0.3 : O.backK) * thr && b.vx * v.vx + b.vy * v.vy > 0.3 * b.s * v.s) && !(v.gap && m.n === 1)) return;
    // (First, two samples in a row moving the same way: a one-frame glitch can't do that.)
    const cls = this.classify(m, v, t);
    if (cls !== 'stroke') { m.cls = cls; return; }
    if (v.gap) { m.cls = 'gap?'; return; }
    this.begin(m, v, t, p, o, out);
  }
  classify(m, v, t) {
    const O = this.o, thr = this.thr, ax = Math.abs(m.ux), h = this.home, H = this.held;
    if (H && H.next === m) {
      if (m.vmax < 0.7 * H.m.vmax) return 'pending';
      this.held = null; this.skip(H.m, 'windup');
    }
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
      if (dot < -0.2 && !R.same && !R.home) return m.vmax > (m.t0 - R.end < 0.6 ? 1.1 : 0.85) * R.peak ? 'stroke' : 'return';
      if (dot > 0.3 && t - R.end < O.refractory) return m.vmax > 0.9 * R.peak ? 'stroke' : 'follow';
    }
    // The serve swing after a toss comes down.
    if (t - this.tossT < 3 && !this.served && m.uy > 0.3) return 'stroke';
    // Up or down: raising the hand, a loop's drop... A groundstroke goes across.
    if (ax < O.across) return m.uy > 0 && m.vmax > 2.5 * thr && m.vmax > 1.3 * median(this.peaks) ? 'stroke' : 'vertical';
    // Setting off from behind the ready position toward it: a stroke. Setting off from around it: maybe the wind-up,
    // held back unless it carries on further than a racket is taken back.
    if (!m.home) return 'stroke';
    return ax >= 0.75 && v.s >= thr && Math.hypot(m.last.x - m.x0, m.last.y - m.y0) * this.sc > 0.45 ? 'stroke' : 'windup?';
  }
  begin(m, v, t, p, o, out) {
    const O = this.o, gap = !!m.gapPk, rise = median(this.rises), k = median(this.ratios);
    const passed = m.pk && m.pk[2] && m.pk[2].s < 0.95 * m.vmax;
    let t0;
    if (passed) t0 = peakTime(m.pk);
    else if (gap) t0 = m.pk[1].t;
    else t0 = Math.max((m.tOn ?? v.t) + (Number.isFinite(rise) ? rise : O.rise), v.t);
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
    if (t - this.tossT < 3 && m.uy > 0.3) this.served = true;
    m.sw = sw; m.cls = 'stroke'; m.v0 = m.vmax;
    // The peak speed isn't known yet: the speed so far times how much this player's swings usually still speed up
    // after they're reported (learned; a first guess from the frame rate, since slower cameras see more of the swing).
    m.pred = passed || gap ? 0 : m.vmax * (Number.isFinite(k) ? k : 1 + 0.35 * Math.pow(0.0333 / this.frameDt, 0.7));
    sw.peak = Math.max(m.vmax * (gap ? 1.15 : 1), m.pred);
    this.hold = null;
    out.push({ type: 'swing', swing: sw });
  }
  endMove(m, t, out, why) {
    this.mv = null;
    this.lastMove = { t, m };
    const O = this.o;
    if (m.sw) {
      const sw = m.sw;
      sw.peak = m.vmax * (m.gapPk ? 1.15 : 1);
      if (m.pk) sw.tPeak = m.pk[2] ? peakTime(m.pk) : m.pk[1].t;
      sw.end = t;
      if (!sw.role) sw.role = 'stroke';
      this.ended = { t, ux: m.ux, uy: m.uy, sw };
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
    if (m.vmax >= this.thr) this.ignored = { role, dir: strokeDir(m.ux, m.uy, this.handed), peak: m.vmax, t: m.pk ? m.pk[1].t : m.t0 };
  }
  // A held-back movement from rest that stopped: the wind-up if the hand swings back soon (see startMove), otherwise a
  // stroke after all.
  pendingCheck(t, out) {
    if (this.pend && t - this.pend.t > 0.5) { this.learn(this.pend); this.pend = null; }
    const h = this.held;
    // (Not while the hand is out of sight: the swing back may be hidden by motion blur.)
    if (h && !h.next && t >= h.until && t - this.lastT < 1.5 * this.frameDt) this.resolveHeld(t, out);
  }
  // The movement after a held-back one has passed its peak (or ended) well slower than it: the held one was the stroke.
  // Or nothing followed it: a stroke from rest without a wind-up.
  resolveHeld(t, out) {
    const h = this.held;
    this.held = null;
    if (h.next && h.next.vmax >= 0.7 * h.m.vmax) { this.skip(h.m, 'windup'); return; }
    if (h.next) { h.next.cls = 'return'; h.next.from = null; }
    const hm = h.m;
    if (Math.abs(hm.ux) < this.o.across || hm.vmax < this.thr) return;
    // Reported late: its peak time is known by now, so the game still times it right.
    const tp = hm.pk ? (hm.pk[2] ? peakTime(hm.pk) : hm.pk[1].t) : hm.t0;
    const sw = {
      t0: tp, tOn: hm.tOn ?? tp, peak: hm.vmax * (hm.gapPk ? 1.15 : 1), vx: hm.pk ? hm.pk[1].vx : hm.ux, vy: hm.pk ? hm.pk[1].vy : hm.uy,
      x: hm.last.x, y: hm.last.y * (this.pts.length ? this.pts[this.pts.length - 1].asp : 4 / 3), src: this.src, dir: strokeDir(hm.ux, hm.uy, this.handed),
      side: Math.abs(hm.ux), gap: !!hm.gapPk, tPeak: tp, lead: tp - t, late: true, end: h.t, role: 'stroke',
    };
    this.ended = { t: h.t, ux: hm.ux, uy: hm.uy, sw };
    this.rec = this.recovery(hm, sw, h.t, true);
    out.push({ type: 'swing', swing: sw }, { type: 'swingEnd', swing: sw });
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
      if (!this.highSince) { this.highSince = t; this.heldUp = 0; this.tossBlock = !!(this.mv && this.mv.sw) || !!(this.ended && t - this.ended.t < this.o.tossBlock); }
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
// Which of the detected hands is the racket hand. hands: [{x, y, label}] palm centres in mirrored coordinates, with
// MediaPipe's label. Our frames aren't mirrored, so the player's right hand is labelled "Left". Returns -1 to skip the
// frame: only the other hand is in view, well away from where the racket hand was heading (it is probably blurred).
function pickHand(hands, handed, pred) {
  if (!hands.length) return -1;
  const mine = handed === 'L' ? 'Right' : 'Left';
  if (pred && pred.age < 0.35) {
    let best = 0, bd = Infinity;
    hands.forEach((h, i) => { const d = Math.hypot(h.x - pred.x, h.y - pred.y) + (h.label === mine ? 0 : 0.08); if (d < bd) { bd = d; best = i; } });
    const h = hands[best];
    if (h.label !== mine && h.label && Math.hypot(h.x - pred.x, h.y - pred.y) > 0.3) return -1;
    return best;
  }
  const i = hands.findIndex((h) => h.label === mine);
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

// ---- paddle color tracking ----
function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dl = mx - mn;
  let h = 0;
  if (dl > 0) { h = mx === r ? (g - b) / dl : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4; h *= 60; if (h < 0) h += 360; }
  return { h, s: mx ? dl / mx : 0, v: mx / 255 };
}
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// Paddle color from a patch of pixels (RGBA bytes) held in the circle: the dominant saturated hue, not the plain
// average, so a bit of hand or background in the patch doesn't shift it. Returns null if nothing bright enough.
function lockColorFromPatch(px) {
  const N = px.length / 4, hist = new Float32Array(36), all = [];
  for (let i = 0; i < px.length; i += 4) {
    const c = hsv(px[i], px[i + 1], px[i + 2]);
    if (c.s < 0.25 || c.v < 0.15) continue;
    all.push({ ...c, r: px[i], g: px[i + 1], b: px[i + 2] });
    hist[Math.floor(c.h / 10) % 36] += c.s * c.s;   // saturated pixels count most: the paddle beats skin and wood
  }
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
  if (sel.length < 0.3 * N) return null;
  h = mean(sel);
  let ss = 0, vv = 0, R = 0, G = 0, B = 0, sd = 0;
  for (const c of sel) { ss += c.s; vv += c.v; R += c.r; G += c.g; B += c.b; sd += hueDist(c.h, h) ** 2; }
  const n = sel.length, s = ss / n;
  if (s < 0.3) return null;
  return { h, s, v: vv / n, tol: clamp(2 * Math.sqrt(sd / n) + 8, 10, 20), css: `rgb(${(R / n) | 0},${(G / n) | 0},${(B / n) | 0})` };
}

// Find the paddle in a frame (RGBA bytes, W×H, raw, not mirrored). Pixels close to the target color form blobs; the
// best blob is the biggest, favouring the one near where the paddle is expected (opt.pred {x, y, r} in mirrored
// coordinates). Near that spot paler / darker pixels of the same hue also count, which keeps a motion-blurred paddle.
// Returns {x, y, n, strict, hue, sat, val, w, h} for the blob (x, y mirrored), or null. opt.scratch keeps the buffers
// between frames; scratch.mask (2 strict, 1 loose), scratch.lab and scratch.best let the caller draw what matched.
function segmentColor(px, W, H, tg, opt = {}) {
  const n = W * H, S = opt.scratch || {};
  if (!S.mask || S.mask.length !== n) { S.mask = new Uint8Array(n); S.lab = new Int32Array(n); S.stack = new Int32Array(n); }
  const { mask, lab, stack } = S;
  const tol = tg.tol || 16, smin = Math.max(0.3, tg.s * 0.62), vmin = Math.max(0.14, tg.v * 0.4), ls = smin * 0.55, lv = vmin * 0.55;
  const P = opt.pred, k2 = (W * W) / (160 * 160);
  let rx0 = 1, rx1 = 0, ry0 = 1, ry1 = 0;
  if (P) { const cx = (1 - P.x) * W, cy = P.y * H, r = Math.max(4, P.r * W); rx0 = cx - r; rx1 = cx + r; ry0 = cy - r; ry1 = cy + r; }
  const th = tg.h;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    mask[p] = 0;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b, mn = r < g ? (r < b ? r : b) : g < b ? g : b, dl = mx - mn;
    if (dl === 0 || mx < lv * 255 || dl < ls * mx) continue;
    let h = mx === r ? (g - b) / dl : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4;
    h *= 60; if (h < 0) h += 360;
    let dd = h - th; if (dd < 0) dd = -dd; if (dd > 180) dd = 360 - dd;
    if (dd > tol) continue;
    if (dl >= smin * mx && mx >= vmin * 255) mask[p] = 2;
    else { const x = p % W, y = (p / W) | 0; if (x >= rx0 && x <= rx1 && y >= ry0 && y <= ry1) mask[p] = 1; }
  }
  lab.fill(0);
  let nb = 0, best = null, bestScore = 0;
  for (let p0 = 0; p0 < n; p0++) {
    if (!mask[p0] || lab[p0]) continue;
    const id = ++nb;
    let sp = 0, ns = 0, sx = 0, sy = 0, sw = 0, hx = 0, hy = 0, ss = 0, vv = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
    stack[sp++] = p0; lab[p0] = id;
    while (sp) {
      const q = stack[--sp], x = q % W, y = (q / W) | 0, strict = mask[q] === 2, w = strict ? 1 : 0.5;
      sx += (x + 0.5) * w; sy += (y + 0.5) * w; sw += w;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (strict) {
        ns++;
        const c = hsv(px[q * 4], px[q * 4 + 1], px[q * 4 + 2]);
        hx += Math.cos((c.h * Math.PI) / 180); hy += Math.sin((c.h * Math.PI) / 180); ss += c.s; vv += c.v;
      }
      if (x > 0 && mask[q - 1] && !lab[q - 1]) { lab[q - 1] = id; stack[sp++] = q - 1; }
      if (x < W - 1 && mask[q + 1] && !lab[q + 1]) { lab[q + 1] = id; stack[sp++] = q + 1; }
      if (y > 0 && mask[q - W] && !lab[q - W]) { lab[q - W] = id; stack[sp++] = q - W; }
      if (y < H - 1 && mask[q + W] && !lab[q + W]) { lab[q + W] = id; stack[sp++] = q + W; }
    }
    if (sw < 10 * k2 || (ns < 6 * k2 && !P)) continue;   // loose pixels only exist near the prediction
    const bx = 1 - sx / sw / W, by = sy / sw / H;
    let prox = 1;
    if (P) { const d = Math.hypot(bx - P.x, ((by - P.y) * H) / W); prox = 1 / (1 + (d / 0.2) ** 2); }
    const score = sw * (0.3 + prox);
    if (score > bestScore) {
      bestScore = score;
      best = { x: bx, y: by, n: sw, strict: ns, id, hue: ((Math.atan2(hy, hx) * 180) / Math.PI + 360) % 360, sat: ns ? ss / ns : 0, val: ns ? vv / ns : 0, w: (x1 - x0 + 1) / W, h: (y1 - y0 + 1) / H };
    }
  }
  S.best = best ? best.id : 0;
  return best;
}

// Follow slow lighting changes: nudge the working color toward what the tracked blob looks like now, but never far
// from the color that was locked.
function adaptColor(cur, lock, st, k = 0.05) {
  let dh = st.hue - cur.h; if (dh > 180) dh -= 360; if (dh < -180) dh += 360;
  let off = cur.h + dh * k - lock.h; if (off > 180) off -= 360; if (off < -180) off += 360;
  return {
    h: (lock.h + clamp(off, -8, 8) + 360) % 360,
    s: clamp(cur.s + (st.sat - cur.s) * k, lock.s * 0.7, Math.min(1, lock.s * 1.3)),
    v: clamp(cur.v + (st.val - cur.v) * k, lock.v * 0.45, Math.min(1, lock.v * 1.6)),
    tol: lock.tol || 16,
  };
}

export { SWING, strokeDir, judgeCameraSwing, OneEuro2, SwingDetector, peakTime, pickHand, palmSize, PALM_REF, hsv, lockColorFromPatch, segmentColor, adaptColor };
