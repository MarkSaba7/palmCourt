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
    const safe = W - lerp(1.15, 1.45, pow), line = W - 0.5;
    x = lerp(base, s * safe, Math.min(1, a)) + s * sstep(1, 1.3, a) * (line - safe);
    // Timing still pulls or pushes it: a little when roughly on time, a lot when clearly early or late.
    x += tau * bs * (0.8 + 1.4 * sstep(0.45, 1.3, Math.abs(tau)));
  }
  if (drop) return { x: clamp(x * 0.8, -3.2, 3.2), depth: 2.7 + 0.9 * clamp(pow / 0.3, 0, 1) };
  return { x: clamp(x, -3.75, 3.75), depth: lerp(8.3, 10.1, sstep(0.05, 0.95, pow)) - 0.7 * Math.max(0, -spin) };
}

// ---- what a swing says: power, spin, direction and touch, for each control ----
// Power is relative to this player's usual stroke speed (typ, learned from their hits; 0 until known), so it doesn't
// depend on how far from the camera they stand or how they hold the phone: a usual swing is a solid rally ball (0.62),
// ~40% faster is flat out, half as fast a soft ball. Until typ is known an absolute scale, which never reaches flat out.
const relPower = (peak, typ) => clamp(0.62 * Math.pow(peak / typ, 1.2), 0.04, 1);
export function cameraPower(peak, typ, sens = 1) {
  const abs = clamp((peak * sens - 1.0) / 3.5, 0.03, 1);
  return typ > 0 ? clamp(0.25 * abs + 0.75 * relPower(peak, typ), 0.04, 1) : 0.15 + 0.7 * abs;
}
// Phone: peak rotation speed of the phone in °/s (a relaxed swing ~700, a firm one 1200, a big one 1800+).
export function phonePower(peak, typ, fallback = 0.5) {
  if (!(peak > 0)) return clamp(fallback * 0.85, 0.05, 1);   // an older phone page: its own reading, a little tamed
  const abs = clamp((peak - 350) / 1400, 0.03, 1);
  return typ > 0 ? clamp(0.3 * abs + 0.7 * relPower(peak, typ), 0.04, 1) : 0.1 + 0.8 * abs;
}
// Spin from the rise of the swing (radians above the horizontal, + = low to high): flat is a flat drive, about 20° up
// full topspin, 10-25° down a slice.
export const spinFromRise = (ang) => clamp(0.15 + 2.1 * ang, -1, 1);

// How far across the body a stroke goes (0 straight through, +1 hard across, up to 1.3 for
// the lines) from its follow-through: how far the racket sweeps on sideways after the contact compared with how far it
// came in to it. A swing that keeps sweeping sideways goes across; one that stops short sideways (because it goes on
// toward the camera or the net) goes straight.
export function acrossFromPath(pre, post) {
  if (!(pre > 1e-3)) return null;
  return clamp((post / Math.max(pre, 0.02) - 0.4) / 0.6, 0, 1.3);   // (pushing it the other way is late timing's job)
}

// Camera swing (the detector's swing: vx vy at the peak, path {x0 y0 xp yp x1 y1 s0 sp s1 done} in frame widths,
// palm sizes s* when known). o: { typ, sens, stroke, handed, prior (this player's usual across, for a swing not over
// yet) }. Returns { pow, spin, dirX, drop, across, final }.
export function readCamera(sw, o = {}) {
  const P = sw.path, pow = cameraPower(sw.peak || 0, o.typ || 0, o.sens || 1);
  let ang = Math.atan2(-(sw.vy || 0), Math.abs(sw.vx || 0) + 1e-6);
  if (P) ang = 0.6 * ang + 0.4 * Math.atan2(-(P.yp - P.y0), Math.abs(P.xp - P.x0) + 1e-6);   // (the way in to the peak too)
  const spin = spinFromRise(ang);
  let across = null, final = !!(P && P.done);
  if (P && P.done) {
    const lat = Math.sign(P.xp - P.x0) || -ballSide(o.stroke, o.handed), z = P.sp > 0 && P.s1 > 0 ? P.sp / P.s1 : 1;
    // (A hand coming toward the camera also drifts outward in the picture: judge the finish at the contact's distance.)
    across = acrossFromPath((P.xa - P.x0) * lat, (0.5 + (P.x1 - 0.5) * z - P.xb) * lat);
    // Hand growing in the picture after the contact: the racket went on toward the camera, so straighter.
    if (across != null && P.sp > 0 && P.s1 > 0) across *= 1 - 0.6 * clamp(Math.log(P.s1 / P.sp) / 0.15, 0, 1);
  }
  if (across == null) { across = o.prior ?? 0.35; final = !!(P && P.done); }
  const post = P && P.done ? ((P.x1 - P.xb) * Math.sign(P.xp - P.x0)) / Math.max(Math.abs(P.xa - P.x0), 0.04) : 1;
  // A drop shot: a soft swing coming down, or a soft check swing that stops short (decelerating). A normal soft swing
  // (level or rising) stays a soft rally ball.
  const drop = (pow < 0.3 && spin < -0.2) || (pow < 0.22 && spin < 0.2 && !!(P && P.done) && post < 0.3);
  return { pow, spin, across, dirX: -ballSide(o.stroke, o.handed) * across, drop, final };
}
// Phone direction, decided at the contact (the phone sends its swing at the peak, so nothing waits for the finish):
// yawPre = degrees the phone has turned about the vertical from the start of the forward swing to the peak (about half
// the stroke's arc: a big sweep across the body has turned further by the contact than a short push toward the screen),
// yawShare = how much of its turning at the peak is about the vertical (1 a flat sideways sweep, lower a forward or
// upward push). Both against this player's own usual values for the stroke (typYaw, typShare), so no calibration step.
export function phoneAcross(yawPre, yawShare, typYaw = 0, typShare = 0) {
  if (!(yawPre > 0)) return null;
  const ty = typYaw > 0 ? typYaw : 90, ts = typShare > 0 ? typShare : 0.8;
  let a = 0.35 + 0.65 * (yawPre - ty) / Math.max(30, 0.45 * ty);
  if (yawShare > 0) a += 0.6 * (yawShare - ts) / 0.2;
  return clamp(a, -1, 1.3);
}
// Phone swing ({ peak °/s, power, spin, yawPre, yawShare }). o: { typ (usual peak), typYaw, typShare, stroke, handed }.
export function readPhone(sw, o = {}) {
  const pow = phonePower(sw.peak, o.typ || 0, sw.power), spin = clamp((Number.isFinite(sw.spin) ? sw.spin : 0.3) - 0.05, -1, 1);
  const across = phoneAcross(sw.yawPre, sw.yawShare, o.typYaw, o.typShare);
  return { pow, spin, across, dirX: across == null ? null : -ballSide(o.stroke, o.handed) * across, drop: pow < 0.3 && spin < -0.15, final: true };
}
// Mouse / keyboard: the flick before the click (or the arrow keys) aims; see input.js.
export function readPointer(sw) {
  const pow = clamp(sw.power ?? 0.58, 0.05, 1), spin = clamp(sw.spin ?? 0.35, -1, 1);
  return { pow, spin, across: null, dirX: Number.isFinite(sw.aim) ? clamp(sw.aim, -1.3, 1.3) : 0, drop: !!sw.drop || (sw.src === 'mouse' && spin < -0.35 && pow < 0.6), final: true };
}

// What the player sees after the shot: which way it went and how (e.g. "← Cross · topspin · 118 km/h").
export function readText(shot, kmh) {
  const x = shot.aim ?? 0, bs = shot.ballSide || 1, mx = shot.mx || 0;
  const where = Math.abs(x) < 1.2 ? '↑ Middle' : Math.sign(x) === -bs ? (x < 0 ? '← Cross' : 'Cross →') : mx * Math.sign(x) < -0.8 ? (x < 0 ? '← Inside-out' : 'Inside-out →') : (x < 0 ? '← Down the line' : 'Down the line →');
  const how = shot.kind === 'Drop shot' ? 'drop shot' : shot.rpm < -150 ? 'slice' : shot.rpm >= 2000 ? 'topspin' : 'flat';
  return `${where} · ${how} · ${kmh} km/h`;
}

// A person's groundstroke. o: { from (ball position), side (player.side), mx (player's x, hitter's frame), stroke, handed,
// pow, spin, drop, dirX, tau, q (timing quality 0..1), diff (pressure 0..1), volley, S (gear stats) }.
export function humanGround(o) {
  const st = strokeStats(o.S, o.stroke, o.volley), pow = clamp(o.pow, 0.03, 1), spin = clamp(o.spin, -1, 1), q = clamp(o.q ?? 1, 0.2, 1);
  const drop = !!o.drop, kind = shotKind(spin, drop), bs = ballSide(o.stroke, o.handed);
  const aim = aimGround({ ...o, pow, spin, drop, side: bs });
  // Scatter: timing costs most, then how hard the incoming ball was, then swinging flat out. Better control, less.
  const errK = (1 + 3 * (1 - q)) * (1 + 0.9 * clamp(o.diff || 0, 0, 1)) / st.ctl;
  let sx = (0.3 + 0.6 * pow * pow) * errK * (1 + 0.6 * sstep(0.45, 1.3, Math.abs(o.tau || 0))), sz = (0.35 + 0.6 * pow * pow + 0.7 * sstep(0.8, 1, pow)) * errK;
  if (drop) { sx = 0.45 * errK / st.touch; sz = 0.5 * errK / st.touch; }
  else if (spin < -0.2) { sx /= Math.sqrt(st.touch); sz /= Math.sqrt(st.touch); }
  // (The random draws come back with the shot, so a steer after the follow-through keeps the same scatter.)
  const ex = o.ex ?? gauss(), ez = o.ez ?? gauss(), xl = aim.x + ex * sx, dl = Math.max(1.3, aim.depth + ez * sz);
  const vk = drop ? lerp(10.5, 13, pow / 0.3) : lerp(15, 33.5, Math.pow(pow, 0.9)) * (1 - 0.12 * Math.max(0, -spin));
  const speed = vk * st.pow * (0.6 + 0.4 * q);
  // Topspin grows with the swing's rise and a little with pace (a flat drive still turns over ~1000 rpm).
  const rpm = (drop ? -2100 : spin >= 0 ? lerp(900, 3300, spin) + 400 * pow * (1 - spin) : -lerp(600, 2400, -spin)) * st.spin;
  const sol = solveShot(o.from, o.side * xl, -o.side * dl, speed, rpm * RPM, { minNet: drop ? 0.1 : 0.3 });
  return { sol, rpm, kind, tau: o.tau, q, power: pow, aim: aim.x, land: { x: xl, z: dl }, ex, ez, ballSide: bs, mx: o.mx || 0 };
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
