// Palm Court: controller mapping. Pure (no DOM, no three.js), so test/pad.test.mjs runs it in plain Node.
// - Which pad it is (for the button names) and its buttons in the standard order. Browsers report most pads in the
//   "standard" layout; Firefox can report a PlayStation pad in its raw layout instead, which is remapped here by its id.
// - The Buttons scheme: which shot a button asks for, the power from how long it was held, and the stick's aim.
import { clamp, lerp, sstep } from './core.js';

// Standard-mapping button indices (by position: 0 is the bottom face button on every pad).
export const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16, PAD: 17 };
export const NB = 18;
// Button names by layout. `back` switches the camera: View on an Xbox pad, the touchpad (or Share / Create) on a
// PlayStation one.
export const GLYPHS = {
  xbox: { a: 'A', b: 'B', x: 'X', y: 'Y', start: '☰', back: 'View', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', ls: 'L stick', rs: 'R stick', dpad: 'D-pad' },
  ps: { a: '✕', b: '○', x: '□', y: '△', start: 'Options', back: 'Touchpad', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', ls: 'L stick', rs: 'R stick', dpad: 'D-pad' },
  nintendo: { a: 'B', b: 'A', x: 'Y', y: 'X', start: '+', back: '−', lb: 'L', rb: 'R', lt: 'ZL', rt: 'ZR', ls: 'L stick', rs: 'R stick', dpad: 'D-pad' },
};
export const LAYOUT_NAME = { xbox: 'Xbox-style', ps: 'PlayStation', nintendo: 'Nintendo-style' };
export const glyph = (kind, k) => (GLYPHS[kind] || GLYPHS.xbox)[k] || String(k).toUpperCase();

// ("Xbox Wireless Controller" also says "wireless controller", so Xbox first; a DualShock 4 is "Wireless Controller … 054c".)
export function padKind(id = '') {
  return /xbox|xinput|045e/i.test(id) ? 'xbox' : /054c|playstation|dualshock|dualsense|wireless controller/i.test(id) ? 'ps' : /057e|nintendo|pro controller|joy-con/i.test(id) ? 'nintendo' : 'xbox';
}

// Raw PlayStation layouts: btn[i] = the standard button that raw button i is; axes = the raw axes of LX LY RX RY.
// hid (Windows, macOS: the pad's own report order): □ ✕ ○ △ L1 R1 L2 R2 Share Options L3 R3 PS Touchpad; the right
//   stick on axes 2 and 5, the triggers on 3 and 4 (-1 released .. 1 full), the D-pad a hat on axis 9.
// evdev (Linux): ✕ ○ △ □ L1 R1 L2 R2 Share Options PS L3 R3; the right stick on 3 and 4, triggers 2 and 5, D-pad 6 and 7.
const RAW = {
  hid: { btn: [2, 0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 16, 17], axes: [0, 1, 2, 5], trig: [3, 4], hat: 9 },
  evdev: { btn: [0, 1, 3, 2, 4, 5, 6, 7, 8, 9, 16, 10, 11], axes: [0, 1, 3, 4], trig: [2, 5], dpad: [6, 7] },
};
// Which layout a pad's buttons come in: 'standard'; 'hid' or 'evdev' for a PlayStation pad the browser reports raw
// (Sony's vendor id is 054c); 'unknown' for any other pad without the standard layout (read as if it were standard).
export function padLayout(gp, ua = '') {
  if (!gp || gp.mapping === 'standard') return 'standard';
  if (!/054c|dualsense|dualshock|playstation/i.test(gp.id || '')) return 'unknown';
  const n = (gp.buttons || []).length, linux = /linux|x11|cros/i.test(ua) && !/android/i.test(ua);
  return n === 13 || (linux && n < 14) ? 'evdev' : 'hid';
}
export const newPadState = () => ({ v: new Float32Array(NB), d: new Uint8Array(NB), ax: new Float32Array(4) });
const pressed = (b) => !!b && (typeof b === 'object' ? !!b.pressed || (b.value || 0) > 0.5 : +b > 0.5);
const value = (b) => (!b ? 0 : typeof b === 'object' ? +b.value || (b.pressed ? 1 : 0) : +b || 0);
// A gamepad snapshot in the standard order: S.d[i] 1 while held, S.v[i] its value (triggers 0..1), S.ax the two
// sticks (LX LY RX RY, -1..1, up is -1). Fills S in place: polled every frame, so nothing is allocated.
export function normalize(gp, layout, S = newPadState()) {
  const B = gp.buttons || [], A = gp.axes || [], R = RAW[layout];
  S.v.fill(0); S.d.fill(0);
  if (!R) {
    for (let i = 0; i < NB && i < B.length; i++) { S.d[i] = pressed(B[i]) ? 1 : 0; S.v[i] = value(B[i]); }
    for (let i = 0; i < 4; i++) S.ax[i] = +A[i] || 0;
    return S;
  }
  for (let i = 0; i < R.btn.length && i < B.length; i++) { const to = R.btn[i]; S.d[to] = pressed(B[i]) ? 1 : 0; S.v[to] = value(B[i]); }
  for (let i = 0; i < 4; i++) S.ax[i] = +A[R.axes[i]] || 0;
  // Analog triggers (a trigger axis reads exactly 0 until it is first touched: then the digital button stands in).
  R.trig.forEach((ai, k) => { const a = A[ai]; if (Number.isFinite(a) && a !== 0) { const v = (a + 1) / 2; S.v[6 + k] = Math.max(S.v[6 + k], v); if (v > 0.5) S.d[6 + k] = 1; } });
  if (R.hat != null) {
    // A hat: -1 up, rising clockwise in eighths to 1 (up-left); over 1 when released (0 before any data).
    const h = A[R.hat];
    if (Number.isFinite(h) && h !== 0 && h >= -1.001 && h <= 1.001) {
      S.d[BTN.UP] = h < -0.7 || h >= 0.95 ? 1 : 0; S.d[BTN.RIGHT] = h >= -0.75 && h < -0.1 ? 1 : 0;
      S.d[BTN.DOWN] = h >= -0.2 && h < 0.45 ? 1 : 0; S.d[BTN.LEFT] = h >= 0.4 ? 1 : 0;
    }
  } else if (R.dpad) {
    const x = +A[R.dpad[0]] || 0, y = +A[R.dpad[1]] || 0;
    S.d[BTN.LEFT] = x < -0.5 ? 1 : 0; S.d[BTN.RIGHT] = x > 0.5 ? 1 : 0; S.d[BTN.UP] = y < -0.5 ? 1 : 0; S.d[BTN.DOWN] = y > 0.5 ? 1 : 0;
  }
  for (const i of [BTN.UP, BTN.DOWN, BTN.LEFT, BTN.RIGHT]) S.v[i] = S.d[i];
  return S;
}

// ---- the Buttons scheme ----
export const FACE = [BTN.A, BTN.B, BTN.X, BTN.Y];
// What each shot asks of the shot model (src/shot.js readPad): spin -1 slice .. 1 heavy topspin; g = its button.
export const SHOTS = {
  flat: { name: 'Flat', spin: 0.12, g: 'a' },
  topspin: { name: 'Topspin', spin: 0.9, g: 'b' },
  slice: { name: 'Slice', spin: -0.8, g: 'x' },
  lob: { name: 'Lob', spin: 0.5, g: 'y' },
  drop: { name: 'Drop shot', spin: -0.85, g: 'x' },
};
export const SERVES = { flat: { name: 'Flat serve', g: 'a' }, kick: { name: 'Kick serve', g: 'b' }, slice: { name: 'Slice serve', g: 'x' } };
// ✕ flat, ○ topspin, □ slice (with L1 held, a drop shot), △ lob. Serving: ✕ flat, ○ (or △) kick, □ slice.
export const shotFor = (btn, l1 = false) => (btn === BTN.B ? 'topspin' : btn === BTN.X ? (l1 ? 'drop' : 'slice') : btn === BTN.Y ? 'lob' : 'flat');
export const serveFor = (btn) => (btn === BTN.B || btn === BTN.Y ? 'kick' : btn === BTN.X ? 'slice' : 'flat');

// The charge, 0..1: nothing for a tap, full after about 0.8 s held (it fills evenly, like the meter shows it).
export const TAP_S = 0.1, FILL_S = 0.8;
export const chargeOf = (hold) => clamp((hold - TAP_S) / (FILL_S - TAP_S), 0, 1);
// Power for each shot from a tap (a solid medium ball) to a full charge: [tap, full, tap with R1, full with R1]. R1 is
// the riskier power version: harder, and (shot.js) aimed nearer the lines.
const PWR = { flat: [0.52, 0.88, 0.72, 1], topspin: [0.5, 0.86, 0.7, 1], slice: [0.34, 0.66, 0.5, 0.82], lob: [0.3, 0.62, 0.42, 0.76], drop: [0.1, 0.26, 0.12, 0.3] };
export function holdPower(hold, shot, risk = false) {
  const r = PWR[shot] || PWR.flat, c = chargeOf(hold);
  return risk ? lerp(r[2], r[3], c) : lerp(r[0], r[1], c);
}
// A serve's release, in seconds after the toss, that meets the ball at the top of its flight: the best timing (game.js
// humanServe times a serve from the toss, with the same 20 ms display allowance as a click).
export const SERVE_BEST = [0.6, 0.8];
// Serve power builds as the toss rises and holds from the top: ✕ flat is the fastest, ○ kick and □ slice trade pace
// for margin; R1 goes flat out.
export function servePower(since, type = 'flat', risk = false) {
  const top = risk ? 1 : ({ flat: 0.9, kick: 0.74, slice: 0.82 }[type] ?? 0.85);
  return clamp(top * (0.55 + 0.45 * sstep(0.2, 0.6, since)), 0.15, 1);
}
// The serve's aim from the stick's sideways push: 0 the left of the box .. 1 its right, as the server sees it (so wide
// or the T depending on the court), the body when centred.
export const serveAim = (x) => clamp(0.5 + 0.5 * x, 0, 1);
export const serveWhere = (a, court) => (a < 0.34 ? (court === 'deuce' ? 'Wide' : 'T') : a > 0.66 ? (court === 'deuce' ? 'T' : 'Wide') : 'Body');

// A stick as an aim: x -1 left .. 1 right, y -1 short (stick pulled down) .. 1 deep (pushed up; the pad's own axis is
// -1 up). A round dead zone, so a stick resting a little off centre still plays the safe middle ball.
export function stickAim(x, y, dead = 0.25) {
  const r = Math.hypot(x, y);
  if (!(r > dead)) return { x: 0, y: 0 };
  const k = Math.min(1, (r - dead) / (1 - dead)) / r;
  return { x: clamp(x * k, -1, 1), y: clamp(-y * k, -1, 1) };
}
// Words for an aim, for a stroke (stroke 'fh'/'bh', handed 'R'/'L'): Cross / Down the line / Middle, deep or short.
export function aimWords(ax, ay, stroke = 'fh', handed = 'R') {
  const bs = (stroke === 'bh' ? -1 : 1) * (handed === 'L' ? -1 : 1);
  const side = Math.abs(ax) < 0.2 ? 'Middle' : Math.sign(ax) === -bs ? 'Cross' : 'Down the line', arrow = Math.abs(ax) < 0.2 ? '↑' : ax < 0 ? '←' : '→';
  const len = ay > 0.4 ? ' · deep' : ay < -0.4 ? (Math.abs(ax) < 0.2 ? ' · short' : ' · short angle') : '';
  return `${arrow} ${side}${len}`;
}
