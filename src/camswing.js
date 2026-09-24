import { clamp } from './core.js';

// =====================================================================
// CAMSWING: webcam hand / paddle positions → swings, plus paddle color segmentation.
// No DOM in here, so test/camswing.test.mjs can drive it from Node with synthetic swings.
// Positions are normalised to the mirrored camera image: x 0..1 left to right as the player sees it, y 0..1 top to bottom.
// Speeds are in frame widths per second (y is converted to width units with the image aspect).
// =====================================================================
const SWING = {
  start: 1.3,         // speed that starts a swing, before sensitivity
  stopK: 0.45,        // a swing ends when the speed drops below this share of the start speed
  backK: 0.5,         // the frame next to the start must move the same way at this share of it (rejects one-frame glitches)
  noiseK: 4.5,        // the start speed stays this many times above the tracking jitter
  maxGap: 0.3,        // tracking lost for longer than this (seconds) breaks the trajectory
  refractory: 0.25,   // a swing the same way this soon after the last one is the same swing
  maxDur: 0.7,
  maxAcc: 150,        // frame widths per second², far above a real hand; faster changes are tracker glitches
  rise: 0.09,         // first guess at the time from the start speed to peak speed (then learned per player)
  horiz: 0.5,         // sideways share of the swing needed to call forehand or backhand
  tossLine: 0.24,     // hand above this fraction of the frame height tosses the ball
  tossHold: 0.12,
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

// Turns tracked positions into swing events. Each swing is reported once, as soon as it is confirmed (one or two
// frames after it passes the start speed), with t0 = the predicted moment of peak speed, which is when the racket
// meets the ball. A reversal (taking the racket back, then swinging through) starts a new swing straight away.
class SwingDetector {
  constructor(opts = {}) {
    this.o = { ...SWING, ...opts };
    this.filt = new OneEuro2();
    this.rises = []; this.ratios = []; this.noise = []; this.gaps = [];
    this.frameDt = 1 / 30; this.span = 1 / 30; this.thr = this.o.start;
    this.highSince = 0; this.tossFired = false; this.glitches = 0;
    this.reset();
  }
  reset() {
    this.buf = []; this.lastV = null; this.cand = null; this.act = null; this.hold = null; this.ended = null; this.pend = null;
    this.x = 0.5; this.y = 0.5; this.vx = this.vy = this.speed = 0; this.valid = false; this.lastT = -9;
    this.filt.reset();
  }
  get active() { return this.act ? this.act.sw : null; }
  // Drop the swing in progress (the game does this on a toss). No new swing starts until the hand slows or turns.
  cancel() {
    if (this.act) this.hold = { ux: this.act.ux, uy: this.act.uy };
    this.act = null; this.cand = null; this.ended = null;
  }
  // Tracking jitter as a speed, from second differences of the position while the hand is not swinging.
  noiseSpeed() {
    if (this.noise.length < 15) return 0;
    const a = this.noise.slice().sort((p, q) => p - q), p30 = a[Math.floor(a.length * 0.3)];
    return ((p30 / 2.07) * Math.SQRT2) / Math.max(this.span, 0.012);
  }
  threshold(sens) {
    const base = this.o.start / (sens || 1);
    return clamp(this.o.noiseK * this.noiseSpeed(), base, base * 1.8);
  }
  // Where the tracked point should be at time t (for picking the right hand in a frame with two).
  predict(t) {
    const b = this.buf[this.buf.length - 1];
    if (!b) return null;
    const age = t - b.t, v = this.lastV, k = Math.min(Math.max(age, 0), 0.1);
    return { x: b.x + (v ? (v.vx / b.sc) * k : 0), y: b.y + (v ? (v.vy / b.sc) * b.asp * k : 0), age };
  }
  // A tracked position. Returns the events it caused: swing, swingEnd, toss.
  push(t, x, y, o = {}) {
    const out = [], O = this.o, asp = o.aspect || 4 / 3, sc = o.scale || 1, yw = y / asp;
    let last = this.buf[this.buf.length - 1];
    if (last && t < last.t - 0.05) { this.breakTrack(out); last = null; }     // the clock jumped back (a resumed pause)
    if (last && t <= last.t + 1e-4) return out;                                // a repeated frame
    if (last && t - last.t > O.maxGap) { this.breakTrack(out); last = null; }
    const thr = (this.thr = this.threshold(o.sens));
    let v = null;
    if (last) {
      const gdt = t - last.t;
      if (gdt < 0.2) { keep(this.gaps, gdt, 15); this.frameDt = median(this.gaps); }
      // Velocity over the last ~33 ms: one frame at 30 fps, two at 60, so it is fresh without being noisy.
      let ref = last;
      for (let i = this.buf.length - 2; i >= 0 && t - this.buf[i].t <= 0.04; i--) ref = this.buf[i];
      const dt = t - ref.t;
      v = { t: (t + ref.t) / 2, vx: ((x - ref.x) / dt) * sc, vy: ((yw - ref.yw) / dt) * sc, dt, fx: ref.x, fyw: ref.yw, gap: gdt > 2.5 * this.frameDt };
      v.s = Math.hypot(v.vx, v.vy);
      // A hand can't change speed this fast: the tracker jumped (to the other hand, or a same-colored object) for a
      // frame. Skip it like a missing frame, so the next one is measured from the last good position.
      const pv = this.lastV;
      if (pv && !v.gap && Math.hypot(v.vx - pv.vx, v.vy - pv.vy) / Math.max(v.t - pv.t, 0.008) > O.maxAcc) { this.glitches++; return out; }
      if (!v.gap) this.span += (dt - this.span) * 0.1;
      const p0 = this.buf[this.buf.length - 2];
      if (!this.act && p0 && !v.gap && last.t - p0.t < 2.5 * this.frameDt) {
        keep(this.noise, Math.hypot(x - 2 * last.x + p0.x, yw - 2 * last.yw + p0.yw) * sc, 60);
      }
    }
    keep(this.buf, { t, x, y, yw, sc, asp }, 6);
    this.filt.filter(t, x, y);
    this.x = this.filt.x; this.y = this.filt.y; this.valid = true; this.lastT = t;
    this.vx = v ? v.vx : 0; this.vy = v ? v.vy : 0; this.speed = v ? v.s : 0;
    if (v) this.step(v, t, x, y, yw, thr, o, out);
    if (this.pend && !this.act && t - this.pend.sw.end > 0.5) { this.learn(this.pend); this.pend = null; }
    this.lastV = v;
    this.tossCheck(t, out);
    return out;
  }
  // No position this frame (hand or paddle not found).
  miss(t) {
    const out = [], last = this.buf[this.buf.length - 1];
    if (last && t - last.t > this.o.maxGap) this.breakTrack(out);
    if (t - this.lastT > 0.15) { this.valid = false; this.vx = this.vy = this.speed = 0; }
    return out;
  }
  breakTrack(out) {
    if (this.act) this.finish(this.lastT, out);
    this.cand = null; this.buf = []; this.lastV = null; this.filt.reset();
  }
  step(v, t, x, y, yw, thr, o, out) {
    const O = this.o, pv = this.lastV;
    let turned = false;
    if (this.act) {
      const a = this.act, along = v.vx * a.ux + v.vy * a.uy;
      // Swinging back the other way (the racket was being taken back), or an up/down movement turning into a
      // sideways one (a looped backswing dropping into the stroke): that's a new swing.
      turned = (along < -0.3 * v.s && v.s > thr * O.stopK) || (a.sw.dir === null && v.s >= thr && Math.abs(v.vx) >= 0.6 * v.s && along < 0.5 * v.s);
      if (!turned) this.track(a, v);
      if (turned || v.s < thr * O.stopK || t - a.sw.tOn > O.maxDur) this.finish(t, out);
      if (this.act) return;
    }
    // A start on the last frame waiting for this one to confirm it.
    if (this.cand) {
      const c = this.cand;
      this.cand = null;
      let ok;
      if (c.v.gap) ok = -((x - c.x) * c.ux + (yw - c.yw) * c.uy) < 0.5 * c.jump;   // after a tracking gap: it must not jump back
      else ok = v.s >= O.backK * thr && v.vx * c.v.vx + v.vy * c.v.vy > 0.3 * v.s * c.v.s;
      if (ok) { this.begin(c, v, x, yw, o, out); return; }
      if (!c.v.gap && v.vx * c.v.vx + v.vy * c.v.vy < -0.3 * v.s * c.v.s) return;   // the point jumping back after a one-frame glitch
    }
    if (v.s < thr) { if (this.hold && v.s < thr * O.stopK) this.hold = null; return; }
    if (this.hold) {
      if (v.vx * this.hold.ux + v.vy * this.hold.uy >= 0) return;
      this.hold = null;
    }
    const e = this.ended;
    if (e && !turned && t - e.t < O.refractory && v.vx * e.ux + v.vy * e.uy > 0.5 * v.s) return;   // the same swing again
    const c = { t, x, y, yw, v, ux: v.vx / v.s, uy: v.vy / v.s, jump: v.gap ? Math.hypot(x - v.fx, yw - v.fyw) : 0 };
    // When the speed in this swing's direction crossed the start line, between the two velocity samples.
    const pa = pv ? pv.vx * c.ux + pv.vy * c.uy : 0;
    c.tC = !pv || v.gap ? v.t : pa < thr ? pv.t + ((thr - pa) / (v.s - pa)) * (v.t - pv.t) : pv.t;
    const supported = pv && !v.gap && pv.s >= O.backK * thr && pv.vx * v.vx + pv.vy * v.vy > 0.3 * pv.s * v.s;
    if (supported) this.begin(c, v, x, yw, o, out);
    else this.cand = c;
  }
  begin(c, v, x, yw, o, out) {
    const dx = x - c.v.fx, dy = yw - c.v.fyw, d = Math.hypot(dx, dy) || 1, gap = c.v.gap;
    const rise = median(this.rises);
    const sw = {
      t0: gap ? c.v.t : c.tC + (Number.isFinite(rise) ? rise : this.o.rise), tOn: c.tC, peak: 0, vx: c.v.vx, vy: c.v.vy,
      x: c.x, y: c.y, src: o.src || 'hand', dir: strokeDir(dx, dy, o.handed), side: Math.abs(dx) / d, gap,
    };
    const e = this.ended;
    if (e && c.t - e.t < 0.45 && dx * e.ux + dy * e.uy < 0) sw.follows = e.sw;   // straight after a swing the other way
    const a = (this.act = { sw, ux: dx / d, uy: dy / d, meas: 0, pk: null, prev: null, passed: false, boost: gap ? 1.3 : 1 });
    // The peak speed isn't known yet: the speed so far times how much this player's swings usually still speed up
    // after they're detected (learned; a first guess from the frame rate, since slower cameras see more of the swing).
    const m = Math.max(c.v.s, v.s), k = median(this.ratios);
    a.m0 = m;
    a.pred = m * (gap ? 1 : Number.isFinite(k) ? k : 1 + 0.35 * Math.pow(0.0333 / this.frameDt, 0.7));
    this.track(a, c.v);
    if (v !== c.v) this.track(a, v);
    out.push({ type: 'swing', swing: sw });
  }
  track(a, v) {
    if (a.prev && v.s > 3 * a.prev.s && a.prev.s > this.thr) return;   // a one-frame tracking glitch, not the racket
    if (v.s > a.meas) { a.meas = v.s; a.pk = [a.prev, v, null]; a.sw.vx = v.vx; a.sw.vy = v.vy; a.passed = false; }
    else if (a.pk && !a.pk[2]) { a.pk[2] = v; a.passed = true; }
    a.prev = v;
    a.sw.peak = a.passed ? a.meas * a.boost : Math.max(a.meas * a.boost, a.pred);
  }
  finish(t, out) {
    const a = this.act, sw = a.sw;
    this.act = null;
    sw.peak = a.meas * a.boost;
    sw.tPeak = a.pk ? peakTime(a.pk) : sw.t0;
    sw.end = t;
    // Roles: a swing followed at once by a faster one the other way was the wind-up; one that follows a faster
    // swing the other way is the arm coming back. Only real strokes teach the detector this player's timing.
    const p = this.pend;
    this.pend = null;
    if (p && sw.follows === p.sw) {
      if (sw.peak > p.sw.peak) p.sw.role = 'windup';
      else { sw.role = 'return'; this.learn(p); }
    } else if (p) this.learn(p);
    if (!sw.role) { sw.role = 'stroke'; this.pend = { sw, m0: a.m0 }; }
    this.ended = { t, ux: a.ux, uy: a.uy, sw };
    out.push({ type: 'swingEnd', swing: sw });
  }
  learn(p) {
    const sw = p.sw;
    if (sw.gap || sw.role === 'windup' || !(sw.peak > 1.3 * this.thr)) return;
    const r = sw.tPeak - sw.tOn;
    if (r > 0.02 && r < 0.2) keep(this.rises, r, 9);
    keep(this.ratios, clamp(sw.peak / p.m0, 1, 2.5), 9);
  }
  tossCheck(t, out) {
    const L = this.o.tossLine;
    if (this.y < L) {
      if (!this.highSince) this.highSince = t;
      if (t - this.highSince > this.o.tossHold && !this.tossFired) { this.tossFired = true; out.push({ type: 'toss' }); }
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
// with MediaPipe's label and its confidence. Returns -1 to skip the frame: only the other hand is in view, well away
// from where the racket hand was heading (it is probably blurred).
function pickHand(hands, handed, pred) {
  if (!hands.length) return -1;
  const mine = racketLabel(handed);
  if (pred && pred.age < 0.35) {
    let best = 0, bd = Infinity;
    hands.forEach((h, i) => { const d = Math.hypot(h.x - pred.x, h.y - pred.y) + (h.label === mine ? 0 : 0.08); if (d < bd) { bd = d; best = i; } });
    const h = hands[best];
    if (h.label !== mine && h.label && Math.hypot(h.x - pred.x, h.y - pred.y) > 0.3) return -1;
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
  constructor(o = {}) { this.win = o.win || 2; this.slow = o.slow || 1.2; this.q = o.q || 0.75; this.reset(); }
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
  constructor() { this.reset(); }
  reset() { this.vote = 0; this.n = 0; }
  // Returns {i, switched}: i = -1 skips the frame; switched: now following a different hand (restart its track).
  pick(hands, handed, pred, moving = false) {
    let i = pickHand(hands, handed, pred), switched = false;
    if (i < 0) return { i, switched };
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
