// Browser side of the webcam rig (imported by the page from /tests/e2e/live.mjs). Nothing here changes the game's
// code: it wraps a few Tracker methods to see what they saw, and drives the camera / hand tracker from outside.
//   recorder(P)     records every tracked frame (barcode, capture time, position found, cost) and every Input event
//   directCamera(P) a canvas standing in for the camera's <video>: Tracker.process reads every frame we draw
//   playSuite(...)  lockstep: every clip's frames through Tracker.process with exact 30 fps capture times
//   liveDirect(...) real time: the paddle drawn at 30 fps on the direct camera and processed straight away
//   liveCamera(o)   a synthetic webcam (canvas stream) whose paddle follows a Script the coach extends as the match goes
//   handFeed(P, o)  stands in for MediaPipe: synthetic 21-point hands into Tracker.handleHands at camera timing
//   coach(P, s, o)  watches the ball in a practice match and plays toss, serve and strokes on the Script
import { W, H, FPS, PADDLE, REST, Script, makeStatic, renderLive, readCode, handLandmarks, rng, gaussR } from './scene.mjs';
import { CLIPS, LOCK_WINDOW } from './clips.mjs';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function recorder(P) {
  const T = P.Tracker, I = P.Input, C = P.Clock;
  const R = { frames: [], events: [], cur: -1, pending: null, meta: null, procMs: [] };
  const lum = (d, w) => (x, y) => { const i = (y * w + x) * 4; return (d[i] + d[i + 1] + d[i + 2]) / 3; };
  const ft = T.frameTime;
  T.frameTime = function (meta) {
    const t = ft.call(this, meta);
    R.meta = meta ? { cap: meta.captureTime, recv: meta.receiveTime, pres: meta.presentationTime, pf: meta.presentedFrames, stamp: this.stamp } : { stamp: this.stamp };
    return t;
  };
  const tc = T.trackColor;
  T.trackColor = function (tCap) {
    const a = performance.now(), pt = tc.call(this, tCap), ms = performance.now() - a;
    let code = null;
    if (this.workCtx && P.Settings.paddle) { const [w, h] = this.workSize(); code = readCode(lum(this.workCtx.getImageData(0, 0, w, h).data, w), w, h); }
    R.pending = { code, ms, n: this.blobN };
    return pt;
  };
  const pr = T.process;
  T.process = function (tCap) { const a = performance.now(); pr.call(this, tCap); R.procMs.push(performance.now() - a); if (R.procMs.length > 4000) R.procMs.shift(); };
  const hp = T.handlePoint;
  T.handlePoint = function (pt, lms, tCap) {
    const p = R.pending || {};
    R.pending = null;
    R.frames.push({ ...p, tCap, meta: R.meta, pt: pt ? { x: pt.x, y: pt.y } : null, wall: performance.now() });
    R.cur = R.frames.length - 1;
    return hp.call(this, pt, lms, tCap);
  };
  // Swings as they were when they were reported (the detector keeps updating the object), plus how they ended.
  const open = new Map();
  const snap = (s, off) => ({
    t0: (s.t0 - off) * 1000, tOn: s.tOn != null ? (s.tOn - off) * 1000 : null, tEff: s.tEff != null ? (s.tEff - off) * 1000 : null,
    peak: s.peak, dir: s.dir, role: s.role || null, vx: s.vx, vy: s.vy, x: s.x, y: s.y, gap: !!s.gap, lag: s.lag, follows: !!s.follows, src: s.src,
  });
  I.on((ev) => {
    const off = C.fromPerf(0), e = { type: ev.type, wall: performance.now(), fi: R.cur };
    if (ev.swing) {
      const s = ev.swing;
      e.sw = snap(s, off);
      if (ev.type === 'swing') open.set(s, e);
      else if (ev.type === 'swingEnd') { const o = open.get(s); open.delete(s); if (o) { o.sw.role = s.role; o.sw.peakFinal = s.peak; o.sw.tPeak = s.tPeak != null ? (s.tPeak - off) * 1000 : null; o.sw.tEff = s.tEff != null ? (s.tEff - off) * 1000 : o.sw.tEff; } }
    }
    R.events.push(e);
  });
  // The frame the video element shows right now (for timing the color lock), read through a small canvas.
  const cv = document.createElement('canvas'); cv.width = 160; cv.height = 120;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  R.peek = () => { const v = T.video; if (!v || v.readyState < 2) return null; cx.drawImage(v, 0, 0, 160, 120); return readCode(lum(cx.getImageData(0, 0, 160, 120).data, 160), 160, 120); };
  R.take = () => { const out = { frames: R.frames, events: R.events, procMs: R.procMs }; R.frames = []; R.events = []; R.procMs = []; R.cur = -1; return out; };
  return R;
}

// A canvas stands in for the camera's <video> element (Tracker.process only needs readyState, videoWidth/Height and
// a new currentTime per frame). Tracker.start still opens the real (fake) camera, but reads this canvas instead. It is
// CPU-backed, so reading it back doesn't go through SwiftShader.
export function directCamera(P) {
  const T = P.Tracker, cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true }), img = ctx.createImageData(W, H);
  Object.assign(cv, { readyState: 4, videoWidth: W, videoHeight: H, currentTime: 0, srcObject: null, play: async () => {}, pause() {} });
  const real = T.video;
  T.video = cv;
  let k = 0;
  return {
    cv, img,
    show() { ctx.putImageData(img, 0, 0); cv.currentTime = ++k; },
    process(tCapMs, rec) { if (rec) rec.meta = { cap: tCapMs, stamp: 'direct' }; T.process(tCapMs); },
    restore() { T.video = real; },
  };
}

// Lockstep: every frame of the suite (suite.json layout, frames drawn here with the same renderer as the .y4m) goes
// through Tracker.process with capture time t0 + g / 30 s, however slow this machine is. The color is locked through
// the camera check's button while each lock clip holds the paddle in the circle.
export async function playSuite(P, suite, cam, rec) {
  const { UI } = await import('/src/ui.js');   // the Lock button counts down 3 s for a real player: lock at once here
  const segs = suite.segments.map((s) => { const c = CLIPS.find((x) => x.name === s.name); return { ...s, clip: c, script: c.build() }; });
  const statics = {}, stFor = (d) => statics[d] || (statics[d] = { stat: makeStatic({ distractor: d, seed: 7 }), st: {} });
  const t0 = performance.now() + 50, locks = [];
  let last = null;
  for (let g = 0; g < suite.total; g++) {
    const s = segs.find((x) => g >= x.start && g < x.start + x.frames), k = g - s.start, t = k / FPS, S = stFor(!!s.clip.distractor);
    if (last !== S) { S.st.rect = null; if (S.st.base) cam.img.data.set(S.st.base); last = S; }
    renderLive(t, { script: s.script, stat: S.stat, color: PADDLE[s.clip.color], exposure: s.clip.exposure, frame: k, clip: s.id }, cam.img.data, S.st);
    cam.show();
    if (/lock$/.test(s.name) && t >= LOCK_WINDOW[0] + 0.2 && !locks.some((l) => l.clip === s.name)) {
      UI.lockColor(true);
      const p = P.Settings.paddle;
      locks.push({ clip: s.name, at: +t.toFixed(2), msg: document.getElementById('swingLog').textContent, col: p && { h: +p.h.toFixed(1), s: +p.s.toFixed(2), v: +p.v.toFixed(2), tol: +p.tol.toFixed(1), css: p.css } });
    }
    cam.process(t0 + (g * 1000) / FPS, rec);
    if (g % 8 === 7) await new Promise((r) => setTimeout(r, 0));
  }
  return locks;
}

// Real time on the direct camera: draws the paddle (following `script`, page seconds) 30 times a second and processes
// each frame at once, with its drawing time as the capture time. Barcode clip 15, frame k & 1023.
export function liveDirect(cam, script, o = {}) {
  const stat = makeStatic({ distractor: o.distractor, seed: 7 }), st = {}, log = [], ms = [];
  let k = 0, stop = false;
  const t0 = performance.now();
  const tick = () => {
    if (stop) return;
    const now = performance.now();
    renderLive(now / 1000, { script, stat, color: PADDLE[o.color || 'red'], exposure: o.exposure ?? 0.5, maxSamples: 6, frame: k & 1023, clip: 15 }, cam.img.data, st);
    cam.show();
    cam.process(now, o.rec);
    log.push(now); ms.push(performance.now() - now); k++;
    setTimeout(tick, Math.max(0, t0 + (k * 1000) / FPS - performance.now()));
  };
  tick();
  return { log, ms, stop() { stop = true; } };
}

// A synthetic webcam drawn live: the paddle follows `script` (times in performance.now() seconds). Frame k shows the
// scene at log[k] and carries barcode clip 15, frame k & 1023.
export function liveCamera(o) {
  const script = o.script, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H), stat = makeStatic({ distractor: o.distractor, seed: 7 }), st = {};
  const stream = cv.captureStream(0), track = stream.getVideoTracks()[0], log = [], ms = [];
  let k = 0, stop = false;
  const t0 = performance.now();
  const tick = () => {
    if (stop) return;
    const now = performance.now();
    renderLive(now / 1000, { script, stat, color: PADDLE[o.color || 'red'], exposure: o.exposure ?? 0.5, maxSamples: 6, frame: k & 1023, clip: 15 }, img.data, st);
    ctx.putImageData(img, 0, 0);
    track.requestFrame();
    log.push(now); ms.push(performance.now() - now); k++;
    setTimeout(tick, Math.max(0, t0 + (k * 1000) / FPS - performance.now()));
  };
  tick();
  return { stream, log, ms, stop() { stop = true; track.stop(); } };
}

// Stands in for the MediaPipe worker: camera frames every 1/fps; the tracker takes a frame only when it is free (like
// Tracker.process), answers proc ms later, and loses the hand when it moves fast (motion blur). o: { script, t0 (page
// ms of frame 0), frames (stop after), content(k) → content seconds, arrive (ms camera → page), proc, procSd, offHand,
// flip (share of frames with the wrong handedness label), seed, rec (recorder), onFrame(k) → extra fields for its frame record }
export function handFeed(P, o) {
  const T = P.Tracker, r = rng(o.seed || 3), fps = o.fps || FPS, pend = [], st = { sent: 0, dropped: 0, lost: 0, k: 0, done: false };
  const t0 = o.t0 ?? performance.now() + 100, arrive = o.arrive ?? 30, proc = o.proc ?? 28, procSd = o.procSd ?? 6;
  let busy = 0, stop = false;
  const deliver = (f) => {
    const tc = o.content ? o.content(f.k) : f.cap / 1000, p = o.script.pos(tc), v = o.script.vel(tc), sp = Math.hypot(v.vx, v.vy);
    const hands = [], labels = [];
    if (r() < clamp((sp - 3) / 5, 0, 0.45) + 0.01) st.lost++;
    else { hands.push(handLandmarks(p, { tilt: clamp(-v.vx * 0.12, -0.6, 0.6), turn: clamp(sp / 6, 0, 0.6), r })); labels.push(r() < (o.flip ?? 0.02) ? 'Right' : 'Left'); }
    if (o.offHand && r() < 0.85) {   // the other hand, hanging by the player's left side
      const h = handLandmarks({ x: 0.33 + 0.01 * Math.sin(tc * 1.3), y: 0.8 }, { left: true, r, size: 0.04 }), i = r() < 0.5 ? 0 : hands.length;
      hands.splice(i, 0, h); labels.splice(i, 0, r() < 0.03 ? 'Left' : 'Right');
    }
    if (o.rec) o.rec.pending = { ...(o.onFrame ? o.onFrame(f.k) : {}), ms: f.proc };
    T.handleHands(hands, labels, f.cap);
  };
  const tick = () => {
    if (stop) return;
    const now = performance.now();
    for (;;) {
      if (o.frames != null && st.k >= o.frames) break;
      const cap = t0 + (st.k * 1000) / fps + gaussR(r) * 0.8, at = cap + arrive;
      if (at > now) break;
      if (at >= busy) { const pms = Math.max(8, proc + gaussR(r) * procSd); busy = at + pms; pend.push({ k: st.k, cap, due: at + pms, proc: pms }); st.sent++; }
      else st.dropped++;
      st.k++;
    }
    while (pend.length && pend[0].due <= now) deliver(pend.shift());
    if (o.frames != null && st.k >= o.frames && !pend.length) { st.done = true; return; }
    setTimeout(tick, 2);
  };
  tick();
  return { st, stop() { stop = true; } };
}

// Plays the local player's side of a practice match on `script` (page seconds): raises the paddle / hand above the toss
// line to toss, swings the serve to peak at the ideal serve time, and swings each stroke to peak when the ball arrives
// (both shifted by Settings.latency, like a calibrated player).
export function coach(P, script, o = {}) {
  const G = P.Game, C = P.Clock, S = P.Settings, log = { raises: 0, serves: 0, strokes: 0, plans: [] };
  const perf = (g) => g - C.fromPerf(0);   // game seconds → page seconds
  const HI = { x: 0.62, y: 0.13 }, LO = { x: 0.35, y: 0.62 };
  let raisedAt = -9, servedFor = null, swungFor = -1;
  const id = setInterval(() => {
    const me = G.me(), m = G.match, b = G.ball, now = C.now(), p = performance.now() / 1000;
    if (!me || !m || G.mode !== 'cpu' || G.state === 'over') return;
    const lat = S.latency + (o.aim || 0);
    if (m.currentServer === me.idx && G.state === 'serve' && now > G.serveReadyAt - 0.4 && p - raisedAt > 2.5) {
      raisedAt = p; log.raises++;
      script.to('lower', p, p + 0.3, REST).to('raise', p + 0.4, p + 0.9, HI);
    } else if (m.currentServer === me.idx && G.state === 'toss' && servedFor !== G.tossT) {
      servedFor = G.tossT; log.serves++;
      const D = 0.26, T = Math.max(perf(G.tossT + 0.68) + lat, p + 0.05 + D / 2);
      script.to('serve', T - D / 2, T + D / 2, LO, { stroke: 'serve' }).to('return', T + D / 2 + 0.1, T + D / 2 + 0.8, REST);
    } else if (G.state === 'rally' && me.plan && b.lastHitter === 1 - me.idx && me.hitFor !== b.rally && swungFor !== b.rally && me.plan.t - now < 0.8) {
      swungFor = b.rally; log.strokes++;
      const D = 0.26, pause = 0.03;
      let T = perf(me.plan.t) + lat, back = T - D / 2 - pause - (p + 0.02);
      if (back < 0.12) { back = 0.12; T = p + 0.02 + back + pause + D / 2; }
      script.stroke(me.plan.stroke, T, { back: Math.min(back, 0.4), pause, rec: 0.6, dur: D });
      log.plans.push({ rally: b.rally, stroke: me.plan.stroke, planT: perf(me.plan.t) * 1000, aimT: T * 1000, lead: (perf(me.plan.t) - p) * 1000 });
    }
  }, 8);
  return { log, stop() { clearInterval(id); } };
}

export { Script, REST };
