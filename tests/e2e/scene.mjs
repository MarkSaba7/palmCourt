// Synthetic webcam for the end-to-end rig: a room, a person and a ping-pong paddle, drawn pixel by pixel in plain JS,
// so the same code writes .y4m clips in Node (gen-video.mjs) and draws a live camera inside the page (practice runs).
// Also: scripted paddle / hand paths with their ground truth, synthetic MediaPipe hand landmarks, and the frame-counter
// barcode drawn in a corner so the page can tell which video frame it is looking at.
// Positions follow the game (src/camswing.js): mirrored image, x 0..1 left to right as the player sees it, y 0..1 top
// to bottom. Pixels in a frame are raw (not mirrored), like a real webcam.
export const W = 640, H = 480, FPS = 30, ASPECT = W / H;
export const TOSS_LINE = 0.24;
export const REST = { x: 0.58, y: 0.6 };   // a right-hander's ready position (forehand side is on the right, mirrored)

export function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
export function gaussR(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mj = (s) => (s <= 0 ? 0 : s >= 1 ? 1 : s * s * s * (10 - 15 * s + 6 * s * s));   // minimum-jerk profile

// ---- scripted paths -----------------------------------------------------------------------------------------------
// A path is a list of minimum-jerk moves between points. Each move has a kind (what a person is doing) so the truth
// can say which moves are strokes the detector must report and which are wind-ups, recoveries or fidgets.
// dur: loop length in seconds (Infinity for a live path the coach extends while the game runs).
export class Script {
  constructor(dur, start = REST, o = {}) {
    this.dur = dur; this.start = { ...start }; this.moves = []; this.sway = o.sway ?? 1; this.handed = o.handed || 'R';
    this.face = []; this.turn = o.turn ?? 0.35;
  }
  wrap(t) { return Number.isFinite(this.dur) ? ((t % this.dur) + this.dur) % this.dur : t; }
  base(t) {
    let p = this.start;
    for (const m of this.moves) {
      if (t < m.t0) return p;
      if (t < m.t1) { const k = mj((t - m.t0) / (m.t1 - m.t0)); return { x: m.a.x + (m.b.x - m.a.x) * k, y: m.a.y + (m.b.y - m.a.y) * k }; }
      p = m.b;
    }
    return p;
  }
  // Body sway and hand tremor: whole cycles per loop so a clip loops cleanly.
  wobble(t) {
    if (!this.sway) return { x: 0, y: 0 };
    const L = Number.isFinite(this.dur) ? this.dur : 6, w = (n) => (2 * Math.PI * n) / L;
    return {
      x: this.sway * (0.006 * Math.sin(w(1) * t) + 0.0015 * Math.sin(w(7) * t + 1) + 0.001 * Math.sin(w(19) * t + 2)),
      y: this.sway * (0.004 * Math.sin(w(2) * t + 0.5) + 0.0012 * Math.sin(w(11) * t + 3) + 0.0008 * Math.sin(w(23) * t)),
    };
  }
  pos(t) { t = this.wrap(t); const b = this.base(t), w = this.wobble(t); return { x: b.x + w.x, y: b.y + w.y }; }
  // Speed in frame widths per second (y converted with the aspect, like the detector).
  vel(t, h = 0.004) { const a = this.pos(t - h), b = this.pos(t + h); return { vx: (b.x - a.x) / (2 * h), vy: (b.y - a.y) / (2 * h) / ASPECT }; }
  // How much of the paddle's face the camera sees (1 = face on). It turns towards edge-on in a fast swing.
  faceAt(t) { const v = this.vel(t), s = Math.hypot(v.vx, v.vy); return clamp(1 - this.turn * clamp(s / 4, 0, 1.4), 0.3, 1); }
  // Add a move from wherever the path is at t0 (a live path drops anything it had planned after t0).
  to(kind, t0, t1, b, meta = {}) {
    const a = this.base(t0);
    this.moves = this.moves.filter((m) => m.t1 <= t0 + 1e-9);
    this.moves.push({ kind, t0, t1, a, b: { ...b }, ...meta });
    return this;
  }
  hold(t0, t1) { return this.to('hold', t0, t1, this.base(t0)); }
  // A ground stroke with its peak racket speed at time T: take-back ('windup'), the stroke, the recovery ('return').
  // stroke: 'fh' | 'bh'. o: { amp, dur, back, pause, rec, lift }.
  stroke(stroke, T, o = {}) {
    const s = this.handed === 'L' ? -1 : 1, side = stroke === 'fh' ? s : -s, rest = o.rest || REST;
    const amp = o.amp ?? 0.45, D = o.dur ?? 0.26, back = o.back ?? 0.4, pause = o.pause ?? 0.05, rec = o.rec ?? 0.7;
    const A = { x: rest.x + side * (stroke === 'fh' ? 0.2 : 0.24), y: rest.y + 0.03 };
    const B = { x: A.x - side * amp, y: A.y - (o.lift ?? 0.08) };
    const f0 = T - D / 2, f1 = T + D / 2;
    this.to('windup', f0 - pause - back, f0 - pause, A, { for: stroke });
    if (pause > 0) this.hold(f0 - pause, f0);
    this.to('stroke', f0, f1, B, { stroke });
    this.hold(f1, f1 + 0.08);
    this.to('return', f1 + 0.08, f1 + 0.08 + rec, rest);
    return this;
  }
  // The toss gesture (paddle above the toss line), then the serve swing peaking at T, then back to rest.
  serve(tUp, T, o = {}) {
    const hi = o.hi || { x: 0.62, y: 0.14 }, lo = o.lo || { x: 0.35, y: 0.62 }, D = o.dur ?? 0.28, rest = o.rest || REST;
    this.to('raise', tUp, tUp + (o.up ?? 0.6), hi);
    this.hold(tUp + (o.up ?? 0.6), T - D / 2);
    this.to('serve', T - D / 2, T + D / 2, lo, { stroke: 'serve' });
    this.hold(T + D / 2, T + D / 2 + 0.1);
    this.to('return', T + D / 2 + 0.1, T + D / 2 + 0.1 + (o.rec ?? 0.7), rest);
    return this;
  }
  // Ground truth: every move with its peak time and speed, and the spells above the toss line.
  truth(step = 1 / 240) {
    const moves = this.moves.filter((m) => m.kind !== 'hold').map((m) => {
      const dx = m.b.x - m.a.x, dy = (m.b.y - m.a.y) / ASPECT, d = Math.hypot(dx, dy), D = m.t1 - m.t0;
      const dir = d < 1e-6 || Math.abs(dx) < 0.5 * d ? null : (dx < 0) === (this.handed !== 'L') ? 'fh' : 'bh';
      return { kind: m.kind, stroke: m.stroke || null, for: m.for || null, t0: m.t0, t1: m.t1, tPeak: (m.t0 + m.t1) / 2, peak: (1.875 * d) / D, dir, dist: d };
    });
    const tosses = [];
    if (Number.isFinite(this.dur)) {
      let inT = null;
      for (let t = 0; t <= this.dur + 1e-9; t += step) {
        const hi = this.pos(t).y < TOSS_LINE;
        if (hi && inT === null) inT = t;
        if (!hi && inT !== null) { tosses.push({ tIn: inT, tOut: t }); inT = null; }
      }
      if (inT !== null) tosses.push({ tIn: inT, tOut: this.dur });
    }
    return { moves, tosses };
  }
}

// ---- the room and the person ---------------------------------------------------------------------------------------
export const PADDLE = { red: [192, 30, 38], blue: [34, 74, 192] };
const SKIN = [222, 168, 136], SHIRT = [58, 88, 100], HAIR = [56, 38, 28], WOOD = [176, 128, 80], RIM = [36, 28, 24];

// Everything that doesn't move: the room and the person's body (Float32 RGB). o: { seed, distractor }
export function makeStatic(o = {}) {
  const r = rng(o.seed || 7), img = new Float32Array(W * H * 3);
  const set = (x, y, c, a = 1) => { const i = (y * W + x) * 3; img[i] += (c[0] - img[i]) * a; img[i + 1] += (c[1] - img[i + 1]) * a; img[i + 2] += (c[2] - img[i + 2]) * a; };
  // Low-frequency plaster texture.
  const tex = new Float32Array(41 * 31); for (let i = 0; i < tex.length; i++) tex[i] = r();
  const texAt = (x, y) => { const u = x / 16, v = y / 16, i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j, T = (a, b) => tex[Math.min(30, b) * 41 + Math.min(40, a)]; return (T(i, j) * (1 - fu) + T(i + 1, j) * fu) * (1 - fv) + (T(i, j + 1) * (1 - fu) + T(i + 1, j + 1) * fu) * fv; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const vig = 1 - 0.28 * (((x - W / 2) / W) ** 2 + ((y - H / 2) / H) ** 2) * 2;
    let c;
    if (y > 372) { const plank = (Math.floor((x + (Math.floor((y - 372) / 22) % 2) * 57) / 115) % 3) * 6; c = [128 - plank, 92 - plank, 64 - plank * 0.6]; if ((y - 372) % 22 < 1) c = [96, 68, 48]; }
    else { const k = 0.92 + 0.1 * (1 - y / 372) + 0.05 * (texAt(x, y) - 0.5); c = [192 * k, 181 * k, 162 * k]; }
    set(x, y, [c[0] * vig, c[1] * vig, c[2] * vig]);
  }
  const rect = (x0, y0, x1, y1, c) => { for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) set(x, y, typeof c === 'function' ? c(x, y) : c); };
  // Window (raw left = the player's right, so it shows on the right of the mirrored picture), with a tree outside.
  rect(34, 44, 196, 236, [228, 226, 218]);
  rect(42, 52, 188, 228, (x, y) => { const g = 1 - (y - 52) / 400; const tree = (x - 150) ** 2 / 900 + (y - 190) ** 2 / 1600 < 1; return tree ? [92, 118, 84] : [196 * g + 20, 214 * g + 18, 232 * g + 10]; });
  rect(112, 52, 118, 228, [228, 226, 218]); rect(42, 136, 188, 142, [228, 226, 218]);
  // A picture frame.
  rect(392, 58, 462, 124, [70, 56, 44]); rect(398, 64, 456, 118, (x, y) => (y > 96 ? [110, 124, 96] : [150, 170, 186]));
  // Bookshelf on the raw right (the player's left).
  rect(470, 146, 628, 372, [92, 68, 50]);
  const shelfY = [154, 226, 298];
  const pal = [[122, 110, 92], [84, 92, 112], [138, 128, 104], [92, 80, 70], [64, 74, 64], [150, 140, 122], [108, 96, 120], [70, 90, 128]];
  for (const sy of shelfY) {
    rect(476, sy + 62, 622, sy + 70, [120, 90, 64]);
    let x = 480;
    while (x < 612) {
      const w = 9 + Math.floor(r() * 10), h = 42 + Math.floor(r() * 18), c = pal[Math.floor(r() * pal.length)], k = 0.85 + r() * 0.3;
      rect(x, sy + 62 - h, Math.min(618, x + w), sy + 62, [c[0] * k, c[1] * k, c[2] * k]);
      x += w + 1;
    }
  }
  // Something in the room the same color as a red paddle (a book spine), the classic cause of tracking jumps.
  if (o.distractor) rect(560, 176, 574, 226, [150, 28, 36]);
  // The person: torso, neck, head with hair, the other arm hanging.
  const cx = 320;
  for (let y = 196; y < H; y++) {
    const k = (y - 196) / (H - 196), hw = 98 + 34 * k;
    for (let x = Math.floor(cx - hw - 1); x <= Math.ceil(cx + hw + 1); x++) {
      const a = clamp(hw - Math.abs(x - cx) + 0.5, 0, 1) * clamp(y - 196 + 0.5, 0, 1);
      const sh = 0.82 + 0.18 * (1 - Math.abs(x - cx) / hw);
      if (a > 0) set(x, y, [SHIRT[0] * sh, SHIRT[1] * sh, SHIRT[2] * sh], a);
    }
  }
  const ell = (ex, ey, ax, ay, c, sh = 0.2) => {
    for (let y = Math.floor(ey - ay - 1); y <= ey + ay + 1; y++) for (let x = Math.floor(ex - ax - 1); x <= ex + ax + 1; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const q = Math.hypot((x - ex) / ax, (y - ey) / ay), a = clamp((1 - q) * Math.min(ax, ay) + 0.5, 0, 1);
      if (a > 0) { const k = 1 - sh * q * q; set(x, y, [c[0] * k, c[1] * k, c[2] * k], a); }
    }
  };
  rect(302, 150, 338, 200, [SKIN[0] * 0.8, SKIN[1] * 0.8, SKIN[2] * 0.8]);
  ell(cx, 112, 44, 56, HAIR, 0.1);
  ell(cx, 124, 40, 50, SKIN, 0.25);
  ell(cx, 88, 42, 26, HAIR, 0.1);
  ell(cx - 14, 118, 5, 3, [60, 44, 40], 0); ell(cx + 14, 118, 5, 3, [60, 44, 40], 0); ell(cx, 150, 10, 3, [160, 96, 90], 0);
  capsule(img, 414, 214, 436, 318, 17, SHIRT); capsule(img, 436, 318, 428, 402, 13, SKIN); ell(428, 410, 15, 17, SKIN, 0.2);
  return img;
}
function capsule(img, x0, y0, x1, y1, rad, c) {
  const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy || 1;
  for (let y = Math.floor(Math.min(y0, y1) - rad - 1); y <= Math.max(y0, y1) + rad + 1; y++) for (let x = Math.floor(Math.min(x0, x1) - rad - 1); x <= Math.max(x0, x1) + rad + 1; x++) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const t = clamp(((x - x0) * dx + (y - y0) * dy) / L2, 0, 1), d = Math.hypot(x - x0 - t * dx, y - y0 - t * dy), a = clamp(rad - d + 0.5, 0, 1);
    if (a > 0) { const k = 1 - 0.25 * (d / rad) ** 2, i = (y * W + x) * 3; img[i] += (c[0] * k - img[i]) * a; img[i + 1] += (c[1] * k - img[i + 1]) * a; img[i + 2] += (c[2] * k - img[i + 2]) * a; }
  }
}

// ---- the racket arm and paddle (moving, motion-blurred) ------------------------------------------------------------
const SHOULDER = { x: 228, y: 212 };   // the player's right shoulder in raw pixels
// Shapes for the arm + paddle with the blade centred at mirrored position p, front to back.
function armShapes(p, face, color) {
  const cx = (1 - p.x) * W, cy = p.y * H, bladeA = 29, bladeB = 27 * face;
  let hx = (SHOULDER.x - cx) * 0.45, hy = 64; const hl = Math.hypot(hx, hy); hx /= hl; hy /= hl;   // handle direction
  const grip = { x: cx + hx * (bladeA + 26), y: cy + hy * (bladeA + 26) }, end = { x: cx + hx * (bladeA + 44), y: cy + hy * (bladeA + 44) };
  // Elbow: bend the arm outwards (away from the body) when the hand is closer than a straight arm.
  const sx = SHOULDER.x, sy = SHOULDER.y, dx = grip.x - sx, dy = grip.y - sy, d = Math.hypot(dx, dy) || 1, Lu = 96, Lf = 92;
  const along = clamp((d * d + Lu * Lu - Lf * Lf) / (2 * d), -Lu, Lu), off = Math.sqrt(Math.max(0, Lu * Lu - along * along));
  let nx = -dy / d, ny = dx / d; if (nx > 0) { nx = -nx; ny = -ny; }
  const el = { x: sx + (dx / d) * along + nx * off, y: sy + (dy / d) * along + ny * off };
  const sl = { x: sx + (el.x - sx) * 0.42, y: sy + (el.y - sy) * 0.42 };
  return [
    { k: 'blade', cx, cy, ux: hx, uy: hy, a: bladeA, b: bladeB, c: color },
    { k: 'ell', cx: grip.x, cy: grip.y, ux: hx, uy: hy, a: 15, b: 13, c: SKIN },
    { k: 'cap', x0: cx + hx * (bladeA - 3), y0: cy + hy * (bladeA - 3), x1: end.x, y1: end.y, r: 6.5, c: WOOD },
    { k: 'cap', x0: el.x, y0: el.y, x1: grip.x, y1: grip.y, r: 12, c: SKIN },
    { k: 'cap', x0: sl.x, y0: sl.y, x1: el.x, y1: el.y, r: 14, c: SKIN },
    { k: 'cap', x0: sx, y0: sy, x1: sl.x, y1: sl.y, r: 17.5, c: SHIRT },
  ].map((s) => {
    if (s.k === 'cap') { s.bx0 = Math.min(s.x0, s.x1) - s.r - 1; s.bx1 = Math.max(s.x0, s.x1) + s.r + 1; s.by0 = Math.min(s.y0, s.y1) - s.r - 1; s.by1 = Math.max(s.y0, s.y1) + s.r + 1; }
    else { const R = Math.max(s.a, s.b) + 1; s.bx0 = s.cx - R; s.bx1 = s.cx + R; s.by0 = s.cy - R; s.by1 = s.cy + R; }
    return s;
  });
}
// Color and coverage of a shape at pixel centre (x, y); writes into out [r, g, b, alpha].
function shade(s, x, y, out) {
  if (x < s.bx0 || x > s.bx1 || y < s.by0 || y > s.by1) { out[3] = 0; return; }
  if (s.k === 'cap') {
    const dx = s.x1 - s.x0, dy = s.y1 - s.y0, t = clamp(((x - s.x0) * dx + (y - s.y0) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    const d = Math.hypot(x - s.x0 - t * dx, y - s.y0 - t * dy), a = clamp(s.r - d + 0.5, 0, 1);
    const k = 1 - 0.25 * (d / s.r) ** 2;
    out[0] = s.c[0] * k; out[1] = s.c[1] * k; out[2] = s.c[2] * k; out[3] = a;
    return;
  }
  const px = x - s.cx, py = y - s.cy, u = px * s.ux + py * s.uy, v = -px * s.uy + py * s.ux;
  const q = Math.hypot(u / s.a, v / s.b), a = clamp((1 - q) * s.b + 0.5, 0, 1);
  out[3] = a;
  if (!a) return;
  if (s.k === 'ell') { const k = 1 - 0.2 * q * q; out[0] = s.c[0] * k; out[1] = s.c[1] * k; out[2] = s.c[2] * k; return; }
  // Rubber: lit from the top left, a soft highlight, a thin dark edge band.
  if (q > 0.93) { out[0] = RIM[0]; out[1] = RIM[1]; out[2] = RIM[2]; return; }
  const lit = 0.78 + 0.3 * (1 - q * q) - 0.12 * ((y - s.cy) / s.a) - 0.06 * ((x - s.cx) / s.a);
  const hl = Math.max(0, 1 - Math.hypot(x - s.cx + 9, y - s.cy + 10) / 11) * 0.35;
  out[0] = s.c[0] * lit + 255 * hl * 0.6; out[1] = s.c[1] * lit + 255 * hl * 0.45; out[2] = s.c[2] * lit + 255 * hl * 0.45;
}

// One frame (Float32 RGB, W×H) at content time t of a clip.
// o: { script, stat (makeStatic), color ([r,g,b]), exposure (share of the frame time the shutter is open),
//      maxSamples, noise, seed, frame (barcode frame number), clip (barcode clip id), out (reuse buffer) }
export function renderFrame(t, o) {
  const s = o.script, out = o.out || new Float32Array(W * H * 3), stat = o.stat;
  out.set(stat);
  armPass(t, o, (i, r, g, b) => { out[i] = r; out[i + 1] = g; out[i + 2] = b; });
  // Sensor noise and a slow exposure drift.
  const nr = rng(o.seed ?? (o.frame || 0) * 7919 + 13), sig = o.noise ?? 2.2, gain = 1 + 0.012 * Math.sin((2 * Math.PI * 2 * t) / (Number.isFinite(s.dur) ? s.dur : 6));
  if (sig > 0) {
    const tab = noiseTable(), off = Math.floor(nr() * tab.length);
    for (let p = 0, j = off; p < out.length; p += 3, j += 3) { const k = j % (tab.length - 3), l = tab[k] * sig; out[p] = out[p] * gain + l + tab[k + 1] * sig * 0.6; out[p + 1] = out[p + 1] * gain + l; out[p + 2] = out[p + 2] * gain + l + tab[k + 2] * sig * 0.6; }
  }
  if (o.frame != null) drawCode(out, o.frame, o.clip || 0);
  return out;
}
// The moving arm + paddle, motion-blurred over the exposure, composited over o.stat; put(i, r, g, b) gets each pixel
// of its bounding box (i = RGB index). Returns the box {x0, y0, x1, y1}.
function armPass(t, o, put) {
  const s = o.script, stat = o.stat, col = o.color || PADDLE.red, exp = (o.exposure ?? 0.5) / FPS;
  // Sub-frame samples: enough that a fast paddle leaves a smooth streak.
  const pa = s.pos(t - exp / 2), pb = s.pos(t + exp / 2), travel = Math.hypot(pa.x - pb.x, (pa.y - pb.y) / ASPECT) * W;
  const n = clamp(Math.ceil(travel / 3), 1, o.maxSamples || 16), samples = [];
  for (let i = 0; i < n; i++) { const ts = n === 1 ? t : t - exp / 2 + (exp * (i + 0.5)) / n; samples.push(armShapes(s.pos(ts), s.faceAt(ts), col)); }
  let x0 = W, x1 = 0, y0 = H, y1 = 0;
  for (const sh of samples) for (const q of sh) { x0 = Math.min(x0, q.bx0); x1 = Math.max(x1, q.bx1); y0 = Math.min(y0, q.by0); y1 = Math.max(y1, q.by1); }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(W - 1, Math.ceil(x1)); y1 = Math.min(H - 1, Math.ceil(y1));
  const px = [0, 0, 0, 0];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * W + x) * 3, bg0 = stat[i], bg1 = stat[i + 1], bg2 = stat[i + 2];
    let r = 0, g = 0, b = 0;
    for (const sh of samples) {
      let T = 1, cr = 0, cg = 0, cb = 0;
      for (const q of sh) {
        shade(q, x + 0.5, y + 0.5, px);
        if (px[3] > 0) { cr += T * px[3] * px[0]; cg += T * px[3] * px[1]; cb += T * px[3] * px[2]; T *= 1 - px[3]; if (T < 0.004) break; }
      }
      r += cr + T * bg0; g += cg + T * bg1; b += cb + T * bg2;
    }
    put(i, r / n, g / n, b / n);
  }
  return { x0, y0, x1, y1 };
}
// Live camera frame into RGBA bytes (a canvas ImageData), redrawing only what moved since the last frame.
// st: { base (RGBA of the static scene with its noise baked in), rect (last frame's arm box) }; o as renderFrame.
export function renderLive(t, o, rgba, st) {
  if (!st.base) { st.base = toRGBA(o.stat); const r = rng(5); for (let p = 0; p < st.base.length; p += 4) { const l = gaussR(r) * 2.2; st.base[p] += l; st.base[p + 1] += l; st.base[p + 2] += l; } rgba.set(st.base); }
  if (st.rect) { const { x0, y0, x1, y1 } = st.rect; for (let y = y0; y <= y1; y++) { const a = (y * W + x0) * 4, b = (y * W + x1 + 1) * 4; rgba.set(st.base.subarray(a, b), a); } }
  const tab = noiseTable(), M = tab.length - 1, off = Math.floor(Math.random() * tab.length);
  st.rect = armPass(t, o, (i, r, g, b) => { const p = (i / 3) * 4, l = tab[(off + p) & M] * 2.2; rgba[p] = r + l; rgba[p + 1] = g + l; rgba[p + 2] = b + l; });
  const { x: ox, y: oy, cell } = CODE, cells = codeCells(o.frame || 0, o.clip || 0);
  for (let r = 0; r < 2; r++) for (let c = 0; c < 10; c++) {
    const v = cells[r][c] ? 255 : 0;
    for (let y = oy + r * cell; y < oy + (r + 1) * cell; y++) for (let x = ox + c * cell; x < ox + (c + 1) * cell; x++) { const p = (y * W + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = v; }
  }
  return rgba;
}
let NOISE = null;
function noiseTable() { if (!NOISE) { const r = rng(99); NOISE = new Float32Array(1 << 18); for (let i = 0; i < NOISE.length; i++) NOISE[i] = gaussR(r); } return NOISE; }

// Paddle blade centre in a frame (mirrored, normalised): the truth the tracker is compared with.
export const bladeAt = (script, t) => script.pos(t);

// ---- frame-counter barcode -----------------------------------------------------------------------------------------
// 2 rows × 10 cells of 16 px in the raw bottom-left corner (bottom-right of the mirrored picture):
// row 0: white, black, frame bits 0-7; row 1: frame bits 8-9, clip bits 0-3, frame parity, clip parity, black, white.
export const CODE = { x: 8, y: H - 40, cell: 16 };
const parity = (v) => { let p = 0; while (v) { p ^= v & 1; v >>= 1; } return p; };
function codeCells(frame, clip) {
  const f = frame & 1023, c = clip & 15, bit = (v, i) => (v >> i) & 1;
  return [[1, 0, ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => bit(f, i))], [bit(f, 8), bit(f, 9), bit(c, 0), bit(c, 1), bit(c, 2), bit(c, 3), parity(f), parity(c), 0, 1]];
}
export function drawCode(img, frame, clip) {
  const cells = codeCells(frame, clip), { x: ox, y: oy, cell } = CODE;
  for (let r = 0; r < 2; r++) for (let c = 0; c < 10; c++) {
    const v = cells[r][c] ? 255 : 0;
    for (let y = oy + r * cell; y < oy + (r + 1) * cell; y++) for (let x = ox + c * cell; x < ox + (c + 1) * cell; x++) { const i = (y * W + x) * 3; img[i] = img[i + 1] = img[i + 2] = v; }
  }
}
// Read the code from RGBA pixels of the whole frame scaled to w×h (e.g. the tracker's 160×120 work canvas).
// get(x, y) → luma. Returns { frame, clip } or null when the cells don't check out.
export function readCode(get, w, h) {
  const sx = w / W, sy = h / H, { x: ox, y: oy, cell } = CODE;
  const at = (r, c) => get(Math.floor((ox + (c + 0.5) * cell) * sx), Math.floor((oy + (r + 0.5) * cell) * sy));
  const white = (at(0, 0) + at(1, 9)) / 2, black = (at(0, 1) + at(1, 8)) / 2;
  if (white - black < 80) return null;
  const thr = (white + black) / 2, b = (r, c) => (at(r, c) > thr ? 1 : 0);
  let f = 0, c = 0;
  for (let i = 0; i < 8; i++) f |= b(0, 2 + i) << i;
  f |= b(1, 0) << 8; f |= b(1, 1) << 9;
  for (let i = 0; i < 4; i++) c |= b(1, 2 + i) << i;
  if (b(1, 6) !== parity(f) || b(1, 7) !== parity(c)) return null;
  return { frame: f, clip: c };
}

// ---- output formats ------------------------------------------------------------------------------------------------
// BT.601 limited range, 4:2:0 (what webcams send and what Chromium assumes for a .y4m fake camera).
export function toI420(rgb, out) {
  const ys = W * H, cs = (W / 2) * (H / 2), buf = out || new Uint8Array(ys + 2 * cs);
  for (let p = 0, i = 0; p < ys; p++, i += 3) buf[p] = clamp(Math.round(16 + (65.481 * rgb[i] + 128.553 * rgb[i + 1] + 24.966 * rgb[i + 2]) / 255), 0, 255);
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    let r = 0, g = 0, b = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const i = ((y + dy) * W + x + dx) * 3; r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2]; }
    r /= 1020; g /= 1020; b /= 1020;
    const k = (y / 2) * (W / 2) + x / 2;
    buf[ys + k] = clamp(Math.round(128 - 37.797 * r - 74.203 * g + 112 * b), 0, 255);
    buf[ys + cs + k] = clamp(Math.round(128 + 112 * r - 93.786 * g - 18.214 * b), 0, 255);
  }
  return buf;
}
export function toRGBA(rgb, out) {
  const d = out || new Uint8ClampedArray(W * H * 4);
  for (let p = 0, i = 0; i < rgb.length; p += 4, i += 3) { d[p] = rgb[i]; d[p + 1] = rgb[i + 1]; d[p + 2] = rgb[i + 2]; d[p + 3] = 255; }
  return d;
}

// ---- synthetic MediaPipe hand landmarks ----------------------------------------------------------------------------
// 21 landmarks (raw, unmirrored, normalised like MediaPipe) for a hand whose palm centre (the mean of landmarks 0, 5, 9,
// 13, 17, which is what the game tracks) sits at mirrored position p. o: { size (wrist to middle knuckle, frame widths),
// tilt (radians, fingers up = 0), turn (0..1 how far the palm has turned edge-on), jitter, r (rng) }
const HAND = [[0, -0.5], [-0.3, -0.32], [-0.5, -0.1], [-0.62, 0.1], [-0.7, 0.28], [-0.33, 0.45], [-0.38, 0.8], [-0.4, 1.03], [-0.41, 1.22],
  [-0.1, 0.5], [-0.11, 0.9], [-0.12, 1.16], [-0.12, 1.37], [0.13, 0.47], [0.15, 0.84], [0.16, 1.08], [0.17, 1.27], [0.33, 0.4], [0.38, 0.68], [0.41, 0.86], [0.43, 1.02]];
const HAND_CY = (HAND[0][1] + HAND[5][1] + HAND[9][1] + HAND[13][1] + HAND[17][1]) / 5, HAND_CX = (HAND[0][0] + HAND[5][0] + HAND[9][0] + HAND[13][0] + HAND[17][0]) / 5;
export function handLandmarks(p, o = {}) {
  const L = o.size ?? 0.042, th = o.tilt || 0, sq = 1 - 0.6 * (o.turn || 0), jit = o.jitter ?? 0.0025, r = o.r || Math.random, mirror = o.left ? -1 : 1;
  const c = Math.cos(th), s = Math.sin(th), cx = 1 - p.x, cy = p.y;
  return HAND.map(([hx, hy]) => {
    const lx = (hx - HAND_CX) * sq * mirror * L, ly = (hy - HAND_CY) * L;
    const rx = lx * c - ly * s, ry = lx * s + ly * c;
    return { x: cx - rx + (jit ? gaussR(r) * jit : 0), y: cy - ry * ASPECT + (jit ? gaussR(r) * jit * ASPECT : 0), z: 0 };
  });
}
