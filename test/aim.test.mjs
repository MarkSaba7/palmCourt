// Swing → aim reads (src/shot.js readCamera / readPhone / readPointer, camswing.js swing paths). Pure Node:
//   node test/aim.test.mjs [-v]
// Camera: synthetic strokes in 3D (a hand sweeping in to the contact, then following through across the body or on
// toward the camera, rising or falling), seen by a 30 fps camera with jitter, through the real SwingDetector. The read
// at the end of each swing must give the direction, spin and drop shot the player meant. Phone and mouse reads too.
import { SwingDetector } from '../src/camswing.js';
import { readCamera, readPhone, readPointer, cameraPower, phonePower, ballSide, aimGround } from '../src/shot.js';

let failures = 0, checks = 0;
const verbose = process.argv.includes('-v');
const ok = (c, msg) => { checks++; if (!c) { failures++; console.log('  FAIL ' + msg); } else if (verbose) console.log('  ok   ' + msg); return c; };
const section = (name) => console.log('- ' + name);
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const r = rng(7), U = (a, b) => a + r() * (b - a);
const G = () => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
const mj = (s) => (s <= 0 ? 0 : s >= 1 ? 1 : s * s * s * (10 - 15 * s + 6 * s * s));
const pct = (a, n) => `${Math.round((100 * a) / Math.max(1, n))}%`;

// A stroke seen by the webcam. kind fh/bh, handed R/L. follow: 'across' (the racket carries on sideways as far as it
// came in), 'straight' (after the contact it goes on toward the camera), 'half'. rise: radians, + = low to high.
// Returns camera frames { t, x, y, size } (x mirrored, 0..1 left to right as the player sees it).
function stroke(o) {
  const s = o.handed === 'L' ? -1 : 1, fhSide = o.kind === 'fh' ? s : -s;      // where the ball is, in the picture
  const D = o.dur ?? U(0.24, 0.34), amp = o.amp ?? U(0.3, 0.42), T = 1.0;     // time of the contact (peak speed)
  const d0 = o.dist ?? U(1.5, 2.1), fw = 1.15 * d0;                           // metres per frame width at the player
  const phi = { across: U(-0.1, 0.12), straight: U(1.15, 1.45), half: U(0.65, 0.85), wide: U(-0.1, 0.05) }[o.follow];
  const postK = o.follow === 'wide' ? U(1.35, 1.6) : 1;                        // hard across: a long follow-through
  const x0 = 0.5 + fhSide * (0.08 + amp / 2), y0 = 0.62, dir = -fhSide;        // swings toward the other side
  const rise = o.rise ?? 0, rest = { x: 0.5 + 0.08 * s, y: 0.55 }, b1 = T - D / 2 - U(0, 0.06), b0 = b1 - U(0.22, 0.35);
  const at = (t) => {
    // The ready position, the wind-up (taking the racket back), then the stroke.
    if (t < b1) { const k = mj((t - b0) / (b1 - b0)); return { x: rest.x + (x0 - rest.x) * k, y: rest.y + (y0 - rest.y) * k, size: 0.042 * 1.7 / d0 }; }
    // (A long follow-through carries on at the same speed for longer.)
    const u = (t - (T - D / 2)) / D, k = mj(u), pre = Math.min(k, 0.5), post = t <= T ? 0 : (mj(0.5 + (t - T) / (D * postK)) - 0.5) * postK;
    const lat = amp * (pre + post * Math.cos(phi));                           // frame widths along the stroke
    const fwd = amp * fw * post * Math.sin(phi) * 0.9;                        // metres toward the camera
    const d = d0 - fwd, sc = d0 / d;
    const x = 0.5 + (x0 - 0.5) * sc + dir * lat * sc, y = y0 - Math.tan(rise) * amp * k * 0.9 + 0.02 * post;
    return { x, y, size: (0.042 * 1.7) / d };
  };
  const out = [];
  for (let t = 0.1; t < 1.9; t += 1 / 30) {
    const p = at(t + G() * 0.001);
    out.push({ t, x: p.x + G() * 0.003, y: p.y + G() * 0.003, size: o.size === false ? 0 : p.size * (1 + G() * 0.04) });
  }
  return out;
}
// Feed a stroke to a fresh detector; return the swing it reported (after its end) and a copy of the read at report time.
function detect(o) {
  const det = new SwingDetector({}), frames = stroke(o);
  let sw = null, atReport = null;
  // A still moment first, so the detector knows the ready position and the noise.
  for (let i = 0; i < 30; i++) det.push(i / 30 - 1.0, frames[0].x + G() * 0.003, frames[0].y + G() * 0.003, { handed: o.handed, src: o.src || 'hand', size: 0.042, aspect: 4 / 3 });
  for (const f of frames) {
    const evs = det.push(f.t, f.x, f.y, { handed: o.handed, src: o.src || 'hand', size: f.size, aspect: 4 / 3 });
    for (const e of evs) {
      if (e.type === 'swing' && !sw && e.swing.dir === o.kind) { sw = e.swing; atReport = readCamera(sw, { typ: 0, stroke: o.kind, handed: o.handed, prior: 0.35 }); }
    }
  }
  return sw ? { sw, atReport, fin: readCamera(sw, { typ: 0, stroke: o.kind, handed: o.handed, prior: 0.35 }) } : null;
}

if (process.argv.includes('--dbg')) {
  const f3 = (v) => (v ?? NaN).toFixed(3);
  for (const follow of ['straight']) for (let i = 0; i < 12; i++) {
    const d = detect({ kind: 'fh', handed: 'R', follow }), P = d && d.sw.path;
    if (P) console.log(`  ${follow} x0 ${f3(P.x0)} xp ${f3(P.xp)} x1 ${f3(P.x1)} pre ${f3(Math.abs(P.xa - P.x0))} post ${f3(-(P.x1 - P.xb))} sp ${f3(P.sp)} s1 ${f3(P.s1)} across ${f3(d.fin.across)} peak ${f3(d.sw.peak)} tPeak ${f3(d.sw.tPeak)} tOn ${f3(d.sw.tOn)}`);
  }
}

section('camera: direction from the follow-through');
{
  const res = {};
  for (const src of ['hand', 'paddle']) for (const follow of ['across', 'wide', 'half', 'straight']) {
    let n = 0, seen = 0, side = 0, mid = 0, wrong = 0, sum = 0, fin = 0;
    for (const kind of ['fh', 'bh']) for (const handed of ['R', 'L']) for (let i = 0; i < 25; i++) {
      n++;
      const d = detect({ kind, handed, follow, src, size: src === 'hand' });
      if (!d) continue;
      seen++; if (d.fin.final) fin++;
      const bs = ballSide(kind, handed), a = d.fin.across;   // + across (away from the ball's side)
      sum += a;
      const x = aimGround({ pow: 0.6, spin: 0.3, dirX: d.fin.dirX, tau: 0, mx: 0, side: bs }).x;
      if (Math.sign(x) === -bs && Math.abs(x) > 1.2) side++;
      else if (Math.abs(x) <= 1.2) mid++;
      else wrong++;
    }
    res[src + ' ' + follow] = { n, seen, side, mid, wrong, mean: sum / Math.max(1, seen), fin };
    console.log(`  ${src.padEnd(6)} ${follow.padEnd(8)} seen ${pct(seen, n)} · across ${(sum / Math.max(1, seen)).toFixed(2)} · lands cross ${pct(side, seen)}, middle ${pct(mid, seen)}, the ball's side ${pct(wrong, seen)}`);
  }
  for (const src of ['hand', 'paddle']) {
    const A = res[src + ' across'], S = res[src + ' straight'], Wd = res[src + ' wide'], H = res[src + ' half'];
    ok(A.seen / A.n > 0.9 && A.fin === A.seen, `${src}: strokes seen and read once over`);
    ok(A.side / A.seen >= 0.7 && A.wrong / A.seen <= 0.05, `${src}: across the body goes cross-court (${pct(A.side, A.seen)}), never the other way`);
    ok(Wd.side / Wd.seen >= 0.85 && Wd.mean > A.mean, `${src}: a long hard follow-through goes further across (${Wd.mean.toFixed(2)} vs ${A.mean.toFixed(2)})`);
    ok(S.mid / S.seen >= (src === 'hand' ? 0.75 : 0.6), `${src}: following through toward the camera goes straight (${pct(S.mid, S.seen)} middle)`);
    ok(H.mean > S.mean + 0.2, `${src}: half across is more across than straight (${H.mean.toFixed(2)} vs ${S.mean.toFixed(2)})`);
  }
}

section('camera: spin from the swing\'s rise, drop shots');
{
  const spins = [-0.4, -0.2, 0, 0.2, 0.4].map((rise) => {
    let s = 0, n = 0;
    for (let i = 0; i < 20; i++) { const d = detect({ kind: 'fh', handed: 'R', follow: 'across', rise }); if (d) { s += d.fin.spin; n++; } }
    return s / Math.max(1, n);
  });
  console.log('  spin by rise -0.4..0.4 rad: ' + spins.map((v) => v.toFixed(2)).join(' '));
  ok(spins.every((v, i) => i === 0 || v > spins[i - 1]), 'more low-to-high, more topspin (monotonic)');
  ok(spins[0] < -0.2 && Math.abs(spins[2]) < 0.35 && spins[4] > 0.55, 'high-to-low slices, level is flat, low-to-high is topspin');
  // Drop shot: soft and falling. A soft level or rising swing, or a normal-speed slice, isn't one.
  const typ = 3.2, read = (peak, rise) => readCamera({ peak, vx: -Math.cos(rise), vy: -Math.sin(rise), path: null }, { typ, stroke: 'fh', handed: 'R' });
  ok(read(1.1, -0.3).drop && read(1.3, -0.25).drop, 'a soft high-to-low swing is a drop shot');
  ok(!read(1.1, 0.05).drop && !read(1.3, 0.3).drop && !read(1.6, 0).drop, 'a soft level or rising swing is a soft rally ball, not a drop');
  ok(!read(3.0, -0.3).drop && read(3.0, -0.3).spin < -0.2, 'a normal-speed high-to-low swing is a slice, not a drop');
}

section('power follows swing speed (per device)');
{
  const typ = 3;
  const c = [0.5, 0.75, 1, 1.2, 1.4].map((k) => cameraPower(typ * k, typ));
  console.log('  camera, × usual speed 0.5 0.75 1 1.2 1.4: ' + c.map((v) => v.toFixed(2)).join(' '));
  ok(c.every((v, i) => i === 0 || v > c[i - 1]) && Math.abs(c[2] - 0.62) < 0.1 && c[4] > 0.9 && c[0] < 0.35, 'camera: usual swing ≈0.62, 40% harder ≈ flat out, half speed soft');
  ok(cameraPower(8, 0) < 0.9, 'camera: before the usual speed is known, nothing is flat out');
  const p = [600, 900, 1200, 1500, 1900].map((pk) => phonePower(pk, 1200));
  console.log('  phone (usual 1200°/s), 600..1900°/s: ' + p.map((v) => v.toFixed(2)).join(' '));
  ok(p.every((v, i) => i === 0 || v > p[i - 1]) && Math.abs(p[2] - 0.62) < 0.1 && p[4] > 0.9, 'phone: relative to the usual swing');
  ok(phonePower(1500, 0) < 0.9 && phonePower(0, 0, 1) < 0.9, 'phone: no flat out before the usual swing is known, or from the old power field');
}

section('phone and mouse reads');
{
  // Direction at the contact: turned further than usual by the peak (a big sweep), and flatter, goes across; a shorter
  // turn (a push toward the screen) goes straight. This player's usual: 90° by the contact, 80% of it about the vertical.
  const U0 = { typ: 1200, typYaw: 90, typShare: 0.8 };
  const ph = (yawPre, yawShare, stroke = 'fh', handed = 'R') => readPhone({ peak: 1200, spin: 0.3, yawPre, yawShare }, { ...U0, stroke, handed }).dirX;
  console.log(`  phone forehand dirX by turn at contact 60/75/90/110/130°: ${[60, 75, 90, 110, 130].map((y) => ph(y, 0.8).toFixed(2)).join(' ')}`);
  ok([60, 75, 90, 110, 130].every((y, i, a) => i === 0 || ph(y, 0.8) < ph(a[i - 1], 0.8)), 'phone: the further it has turned by the contact, the more across (monotonic)');
  ok(ph(130, 0.9) < -0.9 && Math.abs(ph(65, 0.7)) < 0.5 && ph(90, 0.8) < -0.2 && ph(90, 0.8) > -0.6, 'phone: a big flat sweep goes cross-court (left for a right-handed forehand), a short push straight, the usual swing a little across');
  ok(ph(130, 0.9, 'bh') > 0.9 && ph(130, 0.9, 'fh', 'L') > 0.9, 'phone: a backhand across goes right, and a left-hander\'s forehand');
  ok(ph(110, 0.95) < ph(110, 0.6), 'phone: a flatter sweep (more of the turn about the vertical) goes further across');
  ok(readPhone({ peak: 1200, spin: 0.3, yawPre: 100 }, { typ: 1200, stroke: 'fh' }).dirX < 0, 'phone: works before its usual turn is known, and without yawShare');
  ok(readPhone({ peak: 1200, spin: 0.3 }, { typ: 1200, stroke: 'fh', handed: 'R' }).dirX === null, 'phone: an older phone page aims by timing');
  ok(readPhone({ peak: 500, spin: -0.4 }, { typ: 1200 }).drop && !readPhone({ peak: 500, spin: 0.4 }, { typ: 1200 }).drop, 'phone: soft and falling is a drop shot, soft and rising isn\'t');
  ok(readPointer({ src: 'mouse', power: 0.7, spin: 0.5, aim: -1 }).dirX === -1 && readPointer({ src: 'key', power: 0.58, spin: 0.4 }).dirX === 0, 'mouse / keys: the flick or arrow aims, none is straight');
  ok(readPointer({ src: 'mouse', power: 0.5, spin: -0.6 }).drop && !readPointer({ src: 'mouse', power: 0.8, spin: -0.6 }).drop, 'mouse: a gentle downward flick is a drop shot, a hard one a slice');
}

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(failures ? 1 : 0);
