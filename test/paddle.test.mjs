// Synthetic-webcam tests for paddle colour tracking (src/camswing.js). No webcam, no browser:
//   node test/paddle.test.mjs            run everything, print a report, exit 1 on failure
//   node test/paddle.test.mjs --quick    shorter clips
// A little room is rendered in software: wall, window, door, the player (face, lips, shirt, arms) and a ping-pong
// paddle (rubber, specular highlight, wooden handle, the hand around it, a finger on the rubber). The paddle moves
// along minimum-jerk swings with real motion blur (sub-frame samples averaged over the exposure), the camera adds
// auto-exposure / white-balance changes and sensor noise. Each clip goes through the tracker and through a copy of the
// previous tracker, so the report shows before/after numbers.
// The renderer is exported so a browser test can turn the same scenes into a fake webcam video (.y4m).
import { pathToFileURL } from 'node:url';
import { SwingDetector, hsv, hueDist, lockColorFromPatch, segmentColor, adaptColor, PaddleTrack, clampLock, lockPatch, frameValue } from '../src/camswing.js';

// ---- synthetic camera ----
export const COL = {
  red: [200, 34, 44], blue: [28, 78, 192], green: [34, 150, 72], orange: [238, 108, 32], pink: [226, 70, 150], black: [26, 26, 28],
  skin: [214, 160, 130], skinDark: [140, 92, 70], lips: [176, 88, 92], hair: [58, 44, 36], wood: [186, 146, 96],
  wall: [178, 172, 162], door: [112, 82, 60], window: [230, 234, 240], grey: [120, 122, 126], shirtRed: [190, 36, 48], shirtBlue: [34, 70, 170],
};
export function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
export const mj = (s) => (s <= 0 ? 0 : s >= 1 ? 1 : s * s * s * (10 - 15 * s + 6 * s * s));

// A float RGB canvas in frame-width units (x 0..1 left to right as the player sees it, y 0..H/W top to bottom).
class Canvas {
  constructor(w, h) { this.w = w; this.h = h; this.d = new Float32Array(w * h * 3); this.clip = null; }
  box(x0, y0, x1, y1) {
    const s = this.w, c = this.clip || [0, 0, this.w, this.h];
    return [Math.max(c[0], Math.floor(x0 * s)), Math.max(c[1], Math.floor(y0 * s)), Math.min(c[2], Math.ceil(x1 * s)), Math.min(c[3], Math.ceil(y1 * s))];
  }
  put(i, c, k) { const d = this.d; if (k >= 1) { d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; } else { d[i] += (c[0] - d[i]) * k; d[i + 1] += (c[1] - d[i + 1]) * k; d[i + 2] += (c[2] - d[i + 2]) * k; } }
  // Shapes: ellipse (rotated by a), capsule (a thick line), rectangle.
  ellipse(cx, cy, rx, ry, a, c, k = 1) {
    const R = Math.max(rx, ry), [x0, y0, x1, y1] = this.box(cx - R, cy - R, cx + R, cy + R), s = this.w, ca = Math.cos(a), sa = Math.sin(a);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const dx = (x + 0.5) / s - cx, dy = (y + 0.5) / s - cy, u = (dx * ca + dy * sa) / rx, v = (-dx * sa + dy * ca) / ry;
      if (u * u + v * v <= 1) this.put((y * this.w + x) * 3, c, k);
    }
  }
  capsule(ax, ay, bx, by, r, c, k = 1) {
    const [x0, y0, x1, y1] = this.box(Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.max(ax, bx) + r, Math.max(ay, by) + r), s = this.w;
    const ex = bx - ax, ey = by - ay, L = ex * ex + ey * ey || 1e-12;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const px = (x + 0.5) / s - ax, py = (y + 0.5) / s - ay, u = Math.max(0, Math.min(1, (px * ex + py * ey) / L)), dx = px - u * ex, dy = py - u * ey;
      if (dx * dx + dy * dy <= r * r) this.put((y * this.w + x) * 3, c, k);
    }
  }
  rect(ax, ay, bx, by, c, k = 1) {
    const [x0, y0, x1, y1] = this.box(ax, ay, bx, by);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.put((y * this.w + x) * 3, c, k);
  }
}

// The paddle at a pose: {x, y} face centre (tracker coordinates: mirrored, y 0..1 of the height), ang the direction from
// the face to the handle (radians, 0 = right, π/2 = down), tilt 0..1 the visible share of the face's width (0 edge-on),
// d (optional) the face's diameter in frame widths (nearer the camera, bigger).
export function paddleShapes(p, o, asp) {
  const R = (p.d || o.d) / 2, cx = p.x, cy = p.y / asp, dx = Math.cos(p.ang), dy = Math.sin(p.ang), qx = -dy, qy = dx;
  const tilt = Math.max(0.06, p.tilt ?? 1), rub = (o.rubber || COL.red).map((v) => v * (0.72 + 0.28 * tilt)), hand = o.skin || COL.skin;
  const out = [];
  const shoulder = o.shoulder || [0.62, 0.42], hx = cx + dx * R * 1.75, hy = cy + dy * R * 1.75;
  if (o.arm !== false) out.push(['capsule', shoulder[0], shoulder[1], hx, hy, 0.026, hand]);
  out.push(['capsule', cx + dx * R * 0.9, cy + dy * R * 0.9, cx + dx * R * 2.0, cy + dy * R * 2.0, R * 0.17, COL.wood]);
  out.push(['ellipse', cx, cy, R, R * tilt, p.ang, rub]);
  if (o.spec) out.push(['ellipse', cx - (dx * 0.25 - qx * 0.3 * tilt) * R, cy - (dy * 0.25 - qy * 0.3 * tilt) * R, R * 0.34, R * 0.16 * tilt, p.ang + 0.5, [250, 248, 244], o.spec]);
  out.push(['ellipse', hx, hy, R * 0.5, R * 0.42, p.ang, hand]);
  // A finger along the rubber (the index finger on the backhand side), `finger` 0..1 how far it reaches across.
  if (o.finger) out.push(['capsule', hx - qx * R * 0.2, hy - qy * R * 0.2, cx + (qx * 0.25 - dx * (o.finger * 1.6 - 0.9)) * R, cy + (qy * 0.25 - dy * (o.finger * 1.6 - 0.9)) * R, R * 0.13, hand]);
  return out;
}
function draw(cv, shapes) {
  for (const s of shapes) {
    if (s[0] === 'ellipse') cv.ellipse(s[1], s[2], s[3], s[4], s[5], s[6], s[7] ?? 1);
    else if (s[0] === 'capsule') cv.capsule(s[1], s[2], s[3], s[4], s[5], s[6], s[7] ?? 1);
    else cv.rect(s[1], s[2], s[3], s[4], s[5], s[6] ?? 1);
  }
}
function shapeBox(shapes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y, r) => { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); };
  for (const s of shapes) {
    if (s[0] === 'ellipse') add(s[1], s[2], Math.max(s[3], s[4]));
    else if (s[0] === 'capsule') { add(s[1], s[2], s[5]); add(s[3], s[4], s[5]); }
    else { add(s[1], s[2], 0); add(s[3], s[4], 0); }
  }
  return [x0, y0, x1, y1];
}

// A scene: a static room + player, and the moving paddle. o: { shirt, skin, face: false, extras: [shapes], d, rubber,
// spec, finger, arm }.
export function makeScene(o = {}) {
  return { o: { d: 0.075, rubber: COL.red, spec: 0.6, shirt: COL.grey, skin: COL.skin, ...o }, cache: new Map() };
}
function staticLayer(sc, w, h) {
  const key = w + 'x' + h;
  if (sc.cache.has(key)) return sc.cache.get(key);
  const o = sc.o, cv = new Canvas(w, h), a = h / w;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {       // wall: lit from above, a little uneven
    const k = 1.08 - (0.22 * y) / h + 0.04 * Math.sin(x * 0.05), i = (y * w + x) * 3;
    cv.d[i] = COL.wall[0] * k; cv.d[i + 1] = COL.wall[1] * k; cv.d[i + 2] = COL.wall[2] * k;
  }
  if (o.room !== false) {
    cv.rect(0.03, 0.05, 0.24, 0.3, COL.window);
    cv.rect(0.78, 0.12, 0.97, a, COL.door);
    cv.rect(0.8, 0.14, 0.95, a, COL.door.map((v) => v * 1.15));
  }
  if (o.face !== false) {
    const sk = o.skin;
    cv.ellipse(0.5, 0.66, 0.18, 0.2, 0, o.shirt);                 // torso
    cv.rect(0.475, 0.3, 0.525, 0.44, sk.map((v) => v * 0.92));     // neck
    cv.capsule(0.36, 0.44, 0.31, 0.7, 0.028, sk);                  // the other arm
    cv.capsule(0.36, 0.44, 0.33, 0.56, 0.036, o.shirt);           // its sleeve
    cv.capsule(0.64, 0.44, 0.66, 0.53, 0.036, o.shirt);           // racket-arm sleeve
    cv.ellipse(0.5, 0.25, 0.068, 0.088, 0, sk);                    // head
    cv.ellipse(0.5, 0.185, 0.072, 0.045, 0, COL.hair);
    cv.ellipse(0.475, 0.24, 0.009, 0.005, 0, COL.hair); cv.ellipse(0.525, 0.24, 0.009, 0.005, 0, COL.hair);
    cv.ellipse(0.5, 0.3, 0.02, 0.008, 0, COL.lips);
  }
  if (o.extras) draw(cv, o.extras);
  sc.cache.set(key, cv.d);
  return cv.d;
}

// One camera frame at time t, W×H RGBA bytes as the webcam would give it (raw: not mirrored).
// cam: { exposure (s), samples, ss (supersampling), gain, wb [r, g, b], chroma, noise, seed, pose(t) → pose | null,
// dyn(t) → extra shapes (things moving in the room) }.
export function renderFrame(sc, t, W, H, cam) {
  const ss = cam.ss || 2, w = W * ss, h = H * ss, a = h / w, base = staticLayer(sc, w, h), o = sc.o;
  const K = cam.exposure > 0 ? cam.samples || 6 : 1, acc = new Float32Array(base.length);
  const shapesAt = (tt) => { const p = cam.pose(tt), s = p ? paddleShapes(p, o, 1 / a) : []; return cam.dyn ? s.concat(cam.dyn(tt)) : s; };
  const all = [];
  for (let k = 0; k < K; k++) all.push(shapesAt(K > 1 ? t + cam.exposure * ((k + 0.5) / K - 0.5) : t));
  const bx = shapeBox(all.flat()), cv = new Canvas(w, h);
  cv.d.set(base); acc.set(base);
  if (all.some((s) => s.length)) {
    const x0 = Math.max(0, Math.floor(bx[0] * w) - 1), y0 = Math.max(0, Math.floor(bx[1] * w) - 1), x1 = Math.min(w, Math.ceil(bx[2] * w) + 1), y1 = Math.min(h, Math.ceil(bx[3] * w) + 1);
    cv.clip = [x0, y0, x1, y1];
    for (let y = y0; y < y1; y++) for (let i = (y * w + x0) * 3; i < (y * w + x1) * 3; i++) acc[i] = 0;
    for (const shapes of all) {
      for (let y = y0; y < y1; y++) cv.d.set(base.subarray((y * w + x0) * 3, (y * w + x1) * 3), (y * w + x0) * 3);
      draw(cv, shapes);
      for (let y = y0; y < y1; y++) for (let i = (y * w + x0) * 3; i < (y * w + x1) * 3; i++) acc[i] += cv.d[i] / K;
    }
  }
  const r = rng(cam.seed ?? Math.round(t * 1000) + 7), out = new Uint8ClampedArray(W * H * 4);
  const g = cam.gain ?? 1, wb = cam.wb || [1, 1, 1], chroma = cam.chroma ?? 1, nz = cam.noise ?? 3, n2 = ss * ss;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let R = 0, G = 0, B = 0;
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) { const q = ((y * ss + j) * w + x * ss + i) * 3; R += acc[q]; G += acc[q + 1]; B += acc[q + 2]; }
    R /= n2; G /= n2; B /= n2;
    const Y = 0.3 * R + 0.59 * G + 0.11 * B, ln = nz ? gauss(r) * nz * 0.6 : 0;
    const o4 = (y * W + (W - 1 - x)) * 4;         // the camera's picture is the mirror image of what the player sees
    out[o4] = (Y + (R - Y) * chroma) * g * wb[0] + ln + (nz ? gauss(r) * nz * 0.8 : 0);
    out[o4 + 1] = (Y + (G - Y) * chroma) * g * wb[1] + ln + (nz ? gauss(r) * nz * 0.8 : 0);
    out[o4 + 2] = (Y + (B - Y) * chroma) * g * wb[2] + ln + (nz ? gauss(r) * nz * 0.8 : 0);
    out[o4 + 3] = 255;
  }
  return out;
}

// Swings: the paddle sweeps between two points with a minimum-jerk profile. keys: [{t, x, y, ang, tilt}] (tracker
// coordinates); between keys every field eases. Returns pose(t).
export function keyPath(keys) {
  return (t) => {
    if (t <= keys[0].t) return { ...keys[0] };
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1], b = keys[i];
      if (t <= b.t) {
        if (a.gone || b.gone) return null;
        const k = mj((t - a.t) / (b.t - a.t)), m = (f) => a[f] + (b[f] - a[f]) * k;
        return { x: m('x'), y: m('y'), ang: m('ang'), tilt: m('tilt'), d: a.d && b.d ? m('d') : undefined };
      }
    }
    const e = keys[keys.length - 1];
    return e.gone ? null : { ...e };
  };
}
// Rally of forehands and backhands with peak speed v (frame widths per second), after `hold` seconds held still in the
// middle, nearer the camera (lockD across, for the lock), then played at diameter d. Sweeps span from x 0.2 to 0.82.
export function rally(v, n, o = {}) {
  const d = o.d ?? 0.075, lockD = o.lockD ?? 0.13, keys = [{ t: 0, x: 0.5, y: 0.5, ang: 1.9, tilt: 1, d: lockD }], hold = o.hold ?? 1, L = 0.2, Rr = 0.82;
  const D = (1.875 * Math.hypot(Rr - L, 0.12 * 0.75)) / v, pause = o.pause ?? 0.35;
  let t = hold;
  keys.push({ t, x: 0.5, y: 0.5, ang: 1.9, tilt: 1, d: lockD });
  t += 0.4; keys.push({ t, x: Rr, y: 0.62, ang: 2.3, tilt: 0.7, d });     // step back and take it back
  for (let i = 0; i < n; i++) {
    const fh = i % 2 === 0;
    t += pause; keys.push({ ...keys[keys.length - 1], t });
    t += D; keys.push({ t, x: fh ? L : Rr, y: fh ? 0.46 : 0.62, ang: fh ? 0.9 : 2.3, tilt: 0.7, d });
  }
  t += pause; keys.push({ ...keys[keys.length - 1], t });
  t += 0.5; keys.push({ t, x: 0.55, y: 0.55, ang: 1.9, tilt: 1, d });
  keys.push({ ...keys[keys.length - 1], t: t + 0.4 });
  return { pose: keyPath(keys), end: t + 0.4, D };
}

// ---- the previous tracker (src/camswing.js and Tracker.trackColor before this change), for before/after numbers ----
const OLD = (() => {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
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
  return { lockColorFromPatch, segmentColor, adaptColor };
})();

// ---- the two pipelines, as the Tracker runs them ----
function crop(px, W, x0, y0, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(px.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + x0 + w) * 4), y * w * 4);
  return out;
}
// Before: a 20×20 lock patch from one frame; the swing detector's prediction steers the blur rescue.
export function oldTracker() {
  const det = new SwingDetector(), S = {};
  let lock = null, tg = null;
  return {
    name: 'old',
    lock(px, W, H) { lock = OLD.lockColorFromPatch(crop(px, W, Math.round(W / 2 - 10), Math.round(H / 2 - 10), 20, 20)); tg = lock && { h: lock.h, s: lock.s, v: lock.v, tol: lock.tol }; return lock; },
    step(px, W, H, t) {
      if (!tg) return null;
      const pr = det.predict(t), pred = pr && pr.age < 0.25 ? { x: pr.x, y: pr.y, r: 0.08 + Math.min(0.2, det.speed * 0.03) } : null;
      const b = OLD.segmentColor(px, W, H, tg, { pred, scratch: S });
      if (b) det.push(t, b.x, b.y, { aspect: W / H, scale: 1, src: 'paddle' }); else det.miss(t);
      if (b && b.strict >= 20 && !det.active) tg = OLD.adaptColor(tg, lock, b);
      return b;
    },
  };
}
// After: the lock circle from the last few frames, PaddleTrack, adaptation only while it's sure.
export function newTracker() {
  const pt = new PaddleTrack(), det = new SwingDetector(), ring = [];
  let lock = null, tg = null;
  const tr = {
    name: 'new', pt, info: null, prime: null,
    keep(px, W, H) { ring.push(lockPatch(px, W, H)); if (ring.length > 5) ring.shift(); },
    lock(px, W, H) {
      const all = [...ring, lockPatch(px, W, H)], buf = new Uint8ClampedArray(all.reduce((s, a) => s + a.length, 0));
      all.reduce((o, a) => { buf.set(a, o); return o + a.length; }, 0);
      const info = { frameV: frameValue(px) }, col = lockColorFromPatch(buf, info);
      tr.info = info;
      if (!col) return null;
      lock = clampLock(col); tg = { ...lock };
      tr.prime = pt.prime(px, W, H, tg);
      lock.d = tr.prime.d;
      return col;
    },
    step(px, W, H, t) {
      if (!tg) return null;
      const b = pt.step(px, W, H, t, tg);
      if (b) det.push(t, b.x, b.y, { aspect: W / H, scale: 1, src: 'paddle' }); else det.miss(t);
      if (b && pt.conf >= 0.8 && !det.active) tg = adaptColor(tg, lock, b);
      return b;
    },
  };
  return tr;
}

// Render a clip and run every tracker on the same frames. The lock happens at lockT (the paddle held in the circle).
// Found: within 60% of the paddle's diameter of the truth (the true centre at mid-exposure). Wrong: anywhere else.
export function runClip(sc, clip, trackers, o = {}) {
  const W = o.W || 160, H = o.H || 120, fps = clip.fps || 30, lockT = clip.lockT ?? 0.8, d = sc.o.d, tolF = Math.max(0.6 * d, 3 / W);
  const res = trackers.map(() => ({ vis: 0, found: 0, extra: 0, wrong: 0, err: [], ms: 0, n: 0, pos: [], locked: false }));
  let locked = false;
  for (let k = 0; k / fps < clip.end; k++) {
    const t = k / fps, cam = { exposure: 1 / 60, ...clip.cam, ...(clip.camAt ? clip.camAt(t) : {}), pose: clip.pose, dyn: clip.dyn, seed: k * 7 + 1 };
    // (a paddle leaving view is still in the frame for part of the exposure: finding it there isn't wrong)
    const px = renderFrame(sc, t, W, H, cam), e2 = cam.exposure / 2, truth = clip.pose(t) || clip.pose(t - e2) || clip.pose(t + e2);
    if (!locked) {
      if (t < lockT) { for (const tr of trackers) if (tr.keep) tr.keep(px, W, H); continue; }
      trackers.forEach((tr, j) => { res[j].locked = !!tr.lock(px, W, H); });
      locked = true;
      continue;
    }
    const q = clip.pose(t), vis = !!q && (q.tilt ?? 1) >= 0.3 && q.x > 0.03 && q.x < 0.97 && q.y > 0.03 && q.y < 0.97;
    trackers.forEach((tr, j) => {
      const R = res[j], t0 = performance.now(), b = tr.step(px, W, H, t);
      R.ms += performance.now() - t0; R.n++;
      if (vis) R.vis++;
      const e = b && truth ? Math.hypot(b.x - truth.x, ((b.y - truth.y) * H) / W) : Infinity;
      if (b && e < tolF) { if (vis) R.found++; else R.extra++; R.err.push(e * W); }
      else if (b) R.wrong++;
      R.pos.push({ t, x: b ? b.x : null, y: b ? b.y : null, e, vis });
    });
  }
  for (const R of res) {
    R.rate = R.vis ? R.found / R.vis : 1;
    R.mean = R.err.length ? R.err.reduce((a, b) => a + b, 0) / R.err.length : NaN;
    R.p90 = R.err.length ? R.err.slice().sort((a, b) => a - b)[Math.floor(R.err.length * 0.9)] : NaN;
    R.msPer = R.ms / Math.max(1, R.n);
    // Longest run of visible frames without the paddle found (a gap the swing detector has to bridge).
    let run = 0; R.gap = 0;
    for (const p of R.pos) { if (p.vis && !(p.e < tolF)) { run++; R.gap = Math.max(R.gap, run); } else if (p.vis) run = 0; }
  }
  return res;
}
// Jitter of a paddle held still: spread of the reported point around its own mean (pixels at 160 wide).
function jitter(R, W = 160, H = 120) {
  const p = R.pos.filter((q) => q.x !== null);
  if (p.length < 5) return NaN;
  const mx = p.reduce((a, q) => a + q.x, 0) / p.length, my = p.reduce((a, q) => a + q.y, 0) / p.length;
  return Math.sqrt(p.reduce((a, q) => a + (q.x - mx) ** 2 + (((q.y - my) * H) / W) ** 2, 0) / p.length) * W;
}

// Clips: a rally of forehands and backhands after the lock, with variations.
export function still(dur, amp = 0.0015) {
  return { end: dur, pose: (t) => ({ x: 0.5 + amp * Math.sin(t * 5.1), y: 0.5 + amp * Math.cos(t * 3.7), ang: 1.9, tilt: 1 }) };
}
export function hide(clip, ranges) { const p = clip.pose; return { ...clip, pose: (t) => (ranges.some(([a, b]) => t >= a && t <= b) ? null : p(t)) }; }
// Edge-on at the middle of every swing (when it's fastest), face-on at the ends.
export function edgeOn(clip) {
  const p = clip.pose;
  return { ...clip, pose: (t) => { const a = p(t), b = p(t + 0.01); if (!a || !b) return a; const v = Math.hypot(b.x - a.x, b.y - a.y) / 0.01; return { ...a, tilt: Math.max(0.1, 1 - v / 2.2) }; } };
}

// ---- tests ----
function main() {
  const QUICK = process.argv.includes('--quick'), NSW = QUICK ? 4 : 8;
  let failures = 0;
  const check = (ok, msg) => { if (!ok) { failures++; console.log('  FAIL ' + msg); } return ok; };
  const W = 160, H = 120;

  // -- lock --
  console.log('Lock');
  const lockFrom = (sc, pose, cam = {}) => {
    const frames = [0, 1, 2, 3, 4, 5].map((k) => renderFrame(sc, k / 30, W, H, { exposure: 1 / 60, pose: () => pose, seed: k + 3, ...cam }));
    const px = frames[5], parts = frames.map((f) => lockPatch(f, W, H)), buf = new Uint8ClampedArray(parts.reduce((s, a) => s + a.length, 0));
    parts.reduce((o, a) => { buf.set(a, o); return o + a.length; }, 0);
    const info = { frameV: frameValue(px) }, col = lockColorFromPatch(buf, info);
    return { col, info, px };
  };
  const held = { x: 0.5, y: 0.5, ang: 1.9, tilt: 1 };
  for (const [name, rub, want] of [['red', COL.red, 'red'], ['blue', COL.blue, 'blue'], ['green', COL.green, 'green'], ['orange', COL.orange, 'orange'], ['pink', COL.pink, 'pink']]) {
    const { col, info } = lockFrom(makeScene({ rubber: rub, finger: 0.7 }), held);
    console.log(`  ${name} rubber with a finger on it: ${col ? `${col.name} ${col.h.toFixed(1)}°, s ${col.s.toFixed(2)}, tol ${col.tol.toFixed(1)}°, ${Math.round(info.share * 100)}% of the circle` : info.reason}`);
    check(col && col.name === want && col.tol >= 9 && col.tol <= 18 && hueDist(col.h, hsv(...rub).h) < 6, `lock ${name}`);
  }
  {
    // A smallish paddle in front of a teal shirt (color too, but far less saturated): still the paddle's color.
    const { col, info } = lockFrom(makeScene({ extras: [['rect', 0.36, 0.28, 0.64, 0.5, [58, 88, 100]]] }), { ...held, d: 0.09 });
    console.log(`  red rubber in front of a teal shirt: ${col ? `${col.name} ${col.h.toFixed(1)}°, ${Math.round(info.share * 100)}% of the circle` : info.reason}`);
    check(col && col.name === 'red', 'lock the paddle, not the shirt behind it');
  }
  const why = (r, want, name) => { console.log(`  ${name}: ${r.col ? 'locked (should refuse)' : `${r.info.reason}: ${r.info.msg}`}`); check(!r.col && r.info.reason === want, `lock refuses ${name} (${want})`); };
  why(lockFrom(makeScene({ rubber: COL.black }), held), 'black', 'black rubber');
  why(lockFrom(makeScene({}), null), 'grey', 'nothing in the circle (grey shirt)');
  why(lockFrom(makeScene({}), held, { gain: 0.14, noise: 3 }), 'dark', 'dark room');
  why(lockFrom(makeScene({ extras: [['ellipse', 0.5, 0.375, 0.09, 0.1, 0, COL.skin]] }), null), 'skin', 'a hand in the circle');
  {
    // Old saved settings keep working; junk is refused.
    const old = { h: 356.5, s: 0.8, v: 0.78, tol: 12, css: 'rgb(200,34,44)' }, c = clampLock(old);
    check(c && c.h === 356.5 && c.tol === 12 && c.d === 0 && c.name === 'red' && clampLock(null) === null && clampLock({ h: 'x' }) === null, 'saved settings from the old version load');
  }
  {
    // Lock report: a red shirt or a red poster in view shows up as "others".
    const tr = newTracker(), sc = makeScene({ extras: [['rect', 0.05, 0.4, 0.2, 0.62, COL.red]] });
    const px = renderFrame(sc, 0, W, H, { exposure: 0, pose: () => held });
    tr.lock(px, W, H);
    const tr2 = newTracker(); tr2.lock(renderFrame(makeScene({}), 0, W, H, { exposure: 0, pose: () => held }), W, H);
    console.log(`  lock report: paddle ${(tr2.prime.d * W).toFixed(1)} px across, others ${tr2.prime.others.toFixed(2)}; with a red poster: others ${tr.prime.others.toFixed(2)}`);
    check(Math.abs(tr2.prime.d - 0.075) < 0.012 && tr2.prime.others < 0.1 && tr.prime.others > 0.5, 'lock report: paddle size and same-colored things in view');
  }

  // -- single frames --
  console.log('\nSingle frames');
  const red = hsv(...COL.red), tg = { h: red.h, s: red.s, v: red.v, tol: 12 };
  {
    // Sub-pixel: a disc moved in 0.2 px steps.
    let worst = 0, oldWorst = 0;
    for (let k = 0; k <= 10; k++) {
      const sc = makeScene({ face: false, room: false }), x = 0.5 + (k * 0.2) / W;
      const px = renderFrame(sc, 0, W, H, { exposure: 0, noise: 2, seed: k, pose: () => ({ x, y: 0.5, ang: 1.9, tilt: 1 }) });
      const b = segmentColor(px, W, H, tg, { pred: { x, y: 0.5, r: 0.1 } }), o = OLD.segmentColor(px, W, H, tg, { pred: { x, y: 0.5, r: 0.1 } });
      worst = Math.max(worst, Math.abs(b.x - x) * W); oldWorst = Math.max(oldWorst, Math.abs(o.x - x) * W);
    }
    console.log(`  sub-pixel steps: worst x error new ${worst.toFixed(2)} px, old ${oldWorst.toFixed(2)} px`);
    check(worst < 0.3, 'sub-pixel centroid');
  }
  {
    // Specular highlight on one side of the rubber, and a finger right across it.
    const x = 0.5, pose = () => ({ x, y: 0.5, ang: Math.PI / 2, tilt: 1 });
    const hl = renderFrame(makeScene({ face: false, room: false, spec: 1, d: 0.1 }), 0, W, H, { exposure: 0, noise: 2, pose });
    const b = segmentColor(hl, W, H, tg, {}), o = OLD.segmentColor(hl, W, H, tg, {});
    const e = Math.hypot(b.x - x, b.y - 0.5) * W, eo = Math.hypot(o.x - x, o.y - 0.5) * W;
    console.log(`  specular highlight: error new ${e.toFixed(2)} px (${b.holes} px filled), old ${eo.toFixed(2)} px`);
    check(e < 0.5 && e < eo, 'highlight filled');
    const sc = makeScene({ face: false, room: false, finger: 1.15, d: 0.1, spec: 0 });
    const fp = renderFrame(sc, 0, W, H, { exposure: 0, noise: 2, pose });
    const S = {}, bf = segmentColor(fp, W, H, tg, { scratch: S, expect: { x, y: 0.5, d: 0.1, reach: 0.1 } });
    const pieces = S.blobs.filter((q) => q.n > 5).length;
    console.log(`  finger across the rubber: ${pieces} pieces, merged into one of ${(bf.d * W).toFixed(1)} px (paddle ${0.1 * W} px), error ${(Math.hypot(bf.x - x, bf.y - 0.5) * W).toFixed(2)} px`);
    check(bf.d > 0.085 && Math.hypot(bf.x - x, bf.y - 0.5) * W < 1.2, 'pieces split by a finger merged');
  }
  {
    // A face in warm light with the working color drifted toward skin: never matches.
    const warm = makeScene({ skin: [226, 150, 100] });
    const px = renderFrame(warm, 0, W, H, { exposure: 0, pose: () => null });
    const drift = { ...tg, h: (tg.h + 8) % 360, tol: 18 };
    const b = segmentColor(px, W, H, drift, {}), o = OLD.segmentColor(px, W, H, drift, {});
    console.log(`  warm-lit face, color drifted 8° toward skin: new ${b ? 'matched it' : 'no match'}, old ${o ? `matched ${o.n} px` : 'no match'}`);
    check(!b, 'skin never matches');
    let cur = { ...tg };
    for (let k = 0; k < 300; k++) cur = adaptColor(cur, tg, { hue: (tg.h + 20) % 360, sat: 0.45, val: 0.8 });
    let cur2 = { ...tg };
    for (let k = 0; k < 300; k++) cur2 = adaptColor(cur2, tg, { hue: (tg.h - 20 + 360) % 360, sat: tg.s * 0.8, val: tg.v * 0.5 });
    console.log(`  adaptColor: toward skin stops at ${hueDist(cur.h, tg.h).toFixed(1)}°, away at ${hueDist(cur2.h, tg.h).toFixed(1)}°, darker light followed to v ${cur2.v.toFixed(2)} (lock ${tg.v.toFixed(2)})`);
    check(hueDist(cur.h, tg.h) <= 4.01 && hueDist(cur2.h, tg.h) <= 8.01 && cur2.v < tg.v * 0.6, 'adaptColor limits');
  }

  // -- clips --
  console.log(`\nClips (160×120, 30 fps; found = within 60% of a paddle width of the truth; gap = longest miss, frames)`);
  const table = [];
  const R2 = rally(2, NSW), R35 = rally(3.5, NSW), R3 = rally(3, NSW);
  const poster = [['rect', 0.05, 0.36, 0.2, 0.56, COL.red]];
  const ball = (t) => (t > 2.6 && t < 3.0 ? [['ellipse', 0.05 + (t - 2.6) * 0.6, 0.12, 0.022, 0.022, 0, COL.red]] : []);
  const dimK = (t) => Math.min(1, Math.max(0, (t - 1.5) / 3));
  const scenarios = [
    { name: 'held still', sc: {}, clip: still(3), min: 0.99, jit: 0.2 },
    { name: 'rally 2 fw/s', sc: {}, clip: R2, min: 0.97 },
    { name: 'rally 3.5 fw/s (about 6 m/s)', sc: {}, clip: R35, min: 0.95 },
    { name: 'rally 3.5 fw/s, 1/30 s exposure', sc: {}, clip: { ...R35, cam: { exposure: 1 / 30 } }, min: 0.9 },
    { name: 'dim room: 1/30 s, noisy, washed out', sc: {}, clip: { ...R3, cam: { exposure: 1 / 30, gain: 0.45, noise: 7, chroma: 0.8 } }, min: 0.85 },
    { name: 'light dims and warms', sc: {}, clip: { ...R3, camAt: (t) => ({ gain: 1 - 0.45 * dimK(t), wb: [1 + 0.12 * dimK(t), 1, 1 - 0.18 * dimK(t)] }) }, min: 0.93 },
    { name: 'orange paddle (skin hue)', sc: { rubber: COL.orange }, clip: R3, min: 0.85 },
    { name: 'blue paddle, blue shirt', sc: { rubber: COL.blue, shirt: COL.shirtBlue }, clip: R3, min: 0.85 },
    { name: 'red paddle, red shirt', sc: { shirt: COL.shirtRed }, clip: R3, min: 0.8 },
    { name: 'green paddle, dark skin', sc: { rubber: COL.green, skin: COL.skinDark }, clip: R3, min: 0.95 },
    { name: 'finger on the rubber, strong highlight', sc: { finger: 0.9, spec: 0.95 }, clip: R3, min: 0.95 },
    { name: 'edge-on at the fastest point', sc: {}, clip: edgeOn(R3), min: 0.9 },
    { name: 'red poster; paddle out of view 1.5 s', sc: { extras: poster }, clip: hide(R3, [[2.2, 3.7]]), min: 0.95, wrong: 0 },
    { name: 'red ball flies through', sc: {}, clip: { ...R3, dyn: ball }, min: 0.95, wrong: 0 },
    { name: 'heavy sensor noise', sc: {}, clip: { ...R3, cam: { noise: 11 } }, min: 0.93 },
    // (the lips were hidden behind the paddle at the lock, so they aren't known clutter: a few frames on them are allowed)
    { name: 'lost while stepping back from the lock', sc: {}, clip: hide(R3, [[1.05, 1.9]]), min: 0.95, wrong: 6 },
    { name: 'camera at 60 fps', sc: {}, clip: { ...R35, fps: 60, cam: { exposure: 1 / 120 } }, min: 0.98 },
    { name: 'camera at 5 fps (busy PC)', sc: {}, clip: { ...R2, fps: 5 }, min: 0.9 },
  ];
  for (const s of scenarios) {
    const sc = makeScene(s.sc), [n, o] = runClip(sc, s.clip, [newTracker(), oldTracker()]);
    const f = (R) => `${R.locked ? '' : 'NO LOCK '}${(R.rate * 100).toFixed(1).padStart(5)}% gap ${String(R.gap).padStart(2)} wrong ${String(R.wrong).padStart(2)} err ${R.mean.toFixed(2)} p90 ${R.p90.toFixed(2)} px ${R.msPer.toFixed(2)} ms`;
    const jit = s.jit ? ` jitter new ${jitter(n).toFixed(3)} old ${jitter(o).toFixed(3)} px` : '';
    console.log(`  ${s.name.padEnd(40)} new ${f(n)} | old ${f(o)}${jit}`);
    table.push({ s, n, o });
    check(n.locked && n.rate >= s.min, `${s.name}: found ${(n.rate * 100).toFixed(1)}% (want ≥ ${s.min * 100}%)`);
    check(n.wrong <= (s.wrong ?? 2), `${s.name}: ${n.wrong} frames on something else`);
    if (s.jit) check(jitter(n) < s.jit, `${s.name}: jitter ${jitter(n).toFixed(3)} px`);
  }
  const tot = (k, f) => table.reduce((a, r) => a + f(r[k]), 0);
  console.log(`  total: found new ${((100 * tot('n', (R) => R.found)) / tot('n', (R) => R.vis)).toFixed(1)}% old ${((100 * tot('o', (R) => R.found)) / tot('o', (R) => R.vis)).toFixed(1)}%, wrong frames new ${tot('n', (R) => R.wrong)} old ${tot('o', (R) => R.wrong)}`);

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
