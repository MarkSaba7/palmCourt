// =====================================================================
// SHOT: how a person's swing becomes a shot. No DOM and no three.js, so test/shot.test.mjs runs it in plain Node.
// humanGround / humanServe: the shot the player meant (power, spin, direction, drop shot) and how far off it goes. An
// on-time swing at normal power lands in nearly always; misses come from timing, pressure, very hard swings and
// aiming close to the lines. Gear stats (src/stats.js) scale it: pow → speed, ctl → accuracy, spin → rpm, touch →
// drop shots and slices.
// =====================================================================
import { clamp, lerp, sstep, gauss, RPM, solveShot } from './core.js';

const W = 4.115;   // singles sideline (m from the centre)

// Neutral stats (the starter kit): what every shot uses until src/stats.js hands out real ones.
const f = Object.freeze;
export const NEUTRAL = f({ fh: f({ pow: 1, ctl: 1, spin: 1 }), bh: f({ pow: 1, ctl: 1, spin: 1 }), serve: f({ pow: 1, ctl: 1 }), volley: f({ ctl: 1 }), touch: 1, move: f({ speed: 1, react: 1 }), reach: 1 });
// The multipliers for one stroke: a volley takes its pace and spin from the side it's played on, its control from volley.
export function strokeStats(S, stroke, volley = false) {
  const s = (S && S[stroke === 'bh' ? 'bh' : 'fh']) || NEUTRAL.fh, n = (v) => (Number.isFinite(v) && v > 0 ? v : 1);
  const ctl = volley && S && S.volley ? n(S.volley.ctl) : n(s.ctl);
  return { pow: n(s.pow), ctl, spin: n(s.spin), touch: n(S && S.touch) };
}

// Ball on the hitter's right (+1: a right-hander's forehand) or left (-1).
export const ballSide = (stroke, handed) => (stroke === 'bh' ? -1 : 1) * (handed === 'L' ? -1 : 1);

// What the shot is called from its spin and power: a soft slice is a drop shot.
export function shotKind(spin, drop) { return drop ? 'Drop shot' : spin < -0.2 ? 'Slice' : spin > 0.55 ? 'Topspin' : 'Drive'; }

// Where a groundstroke is aimed across the court (m, + = the hitter's right) and how deep (m from the net).
// o: { pow, spin, drop, dirX, tau, mx, side: ballSide }. dirX is the direction the swing asked for (-1 hard left,
// 0 straight ahead, +1 hard right; up to ±1.3 goes for the lines) or null when the control can't tell (timing aims).
export function aimGround(o) {
  const { pow, spin, drop } = o, bs = o.side, tau = clamp(o.tau || 0, -1.4, 1.4);
  // Straight ahead from where the player stands, drawn in toward the middle (a straight ball from the corner is a safe
  // down-the-line, not a sideline).
  const base = clamp(0.5 * (o.mx || 0), -1.7, 1.7);
  let x;
  if (o.dirX == null) x = 0.4 * base + tau * bs * 2.5;   // early pulls the ball across, late pushes it the other way
  else {
    const d = clamp(o.dirX, -1.3, 1.3), a = Math.abs(d), s = Math.sign(d);
    // A clear swing to one side lands well inside that sideline; beyond it (a very wide swing) closer to the line.
    const safe = W - lerp(0.9, 1.25, pow), line = W - 0.45;
    x = lerp(base, s * safe, Math.min(1, a)) + s * sstep(1, 1.3, a) * (line - safe);
    x += tau * bs * 0.8;   // timing still pulls or pushes it a little
  }
  if (drop) return { x: clamp(x * 0.8, -3.2, 3.2), depth: 2.7 + 0.9 * clamp(pow / 0.3, 0, 1) };
  return { x: clamp(x, -3.75, 3.75), depth: lerp(8.3, 10.1, sstep(0.05, 0.95, pow)) - 0.7 * Math.max(0, -spin) };
}

// A person's groundstroke. o: { from (ball position), side (player.side), mx (player's x, hitter's frame), stroke, handed,
// pow, spin, drop, dirX, tau, q (timing quality 0..1), diff (pressure 0..1), volley, S (gear stats) }.
export function humanGround(o) {
  const st = strokeStats(o.S, o.stroke, o.volley), pow = clamp(o.pow, 0.03, 1), spin = clamp(o.spin, -1, 1), q = clamp(o.q ?? 1, 0.2, 1);
  const drop = !!o.drop, kind = shotKind(spin, drop);
  const aim = aimGround({ ...o, pow, spin, drop, side: ballSide(o.stroke, o.handed) });
  // Scatter: timing costs most, then how hard the incoming ball was, then swinging flat out. Better control, less.
  const errK = (1 + 3 * (1 - q)) * (1 + 0.9 * clamp(o.diff || 0, 0, 1)) / st.ctl;
  let sx = (0.3 + 0.6 * pow * pow) * errK, sz = (0.35 + 0.6 * pow * pow + 0.7 * sstep(0.8, 1, pow)) * errK;
  if (drop) { sx = 0.45 * errK / st.touch; sz = 0.5 * errK / st.touch; }
  else if (spin < -0.2) { sx /= Math.sqrt(st.touch); sz /= Math.sqrt(st.touch); }
  const xl = aim.x + gauss() * sx, dl = Math.max(1.3, aim.depth + gauss() * sz);
  const vk = drop ? lerp(10.5, 13, pow / 0.3) : lerp(15, 33.5, Math.pow(pow, 0.9)) * (1 - 0.12 * Math.max(0, -spin));
  const speed = vk * st.pow * (0.6 + 0.4 * q);
  // Topspin grows with the swing's rise and a little with pace (a flat drive still turns over ~1000 rpm).
  const rpm = (drop ? -2100 : spin >= 0 ? lerp(900, 3300, spin) + 400 * pow * (1 - spin) : -lerp(600, 2400, -spin)) * st.spin;
  const sol = solveShot(o.from, o.side * xl, -o.side * dl, speed, rpm * RPM, { minNet: drop ? 0.1 : 0.3 });
  return { sol, rpm, kind, tau: o.tau, q, power: pow, aim: aim.x, target: aim };
}

// A person's serve. o: { from, side, court, second, power, a (as serveShot: 0..1 across the box, left to right as the
// server sees it), q, S }.
export function humanServe(o) {
  const S = o.S && o.S.serve ? o.S.serve : NEUTRAL.serve, a = clamp(o.a, 0, 1), q = clamp(o.q ?? 1, 0, 1);
  const power = clamp(o.second ? Math.min(o.power, 0.62) : o.power, 0.05, 1);
  // Inside the lines: 35 cm off the T, wide 55 cm inside the sideline, about a metre short of the service line.
  const lx = o.court === 'deuce' ? lerp(-3.55, -0.35, a) : lerp(0.35, 3.55, a);
  const dl = 5.3 + 0.35 * (power - 0.5);
  const errK = (1 + 2.6 * (1 - q)) / (S.ctl || 1);
  const sx = (0.14 + 0.42 * power * power) * errK, sz = (0.16 + 0.42 * power * power + 0.6 * sstep(0.8, 1, power)) * errK;
  const kmh = (o.second ? lerp(105, 160, power) : lerp(115, 205, power)) * (S.pow || 1);
  const rpm = lerp(2800, 800, power) * (o.second ? 1.25 : 1);
  const sol = solveShot(o.from, o.side * (lx + gauss() * sx), -o.side * (dl + gauss() * sz), kmh / 3.6, rpm * RPM, { lo: -0.45, hi: 0.3, minNet: 0.05 });
  return { sol, rpm, kind: o.second ? 'Second serve' : 'Serve', q, power };
}
