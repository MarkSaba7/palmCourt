// Controller mapping and pad shots (src/padmap.js, the pad parts of src/shot.js). Pure Node, no browser:
//   node test/pad.test.mjs [-v]
// Pad ids → PlayStation / Xbox names; the standard layout and the raw PlayStation layouts Firefox can report; the
// Buttons scheme's shot map, hold → power, serve aim and stick aim; then the shot model: every shot reads as itself,
// the stick aims (direction, deep, short angle), on-time shots go in, close-to-the-line and power shots miss more.
import { DT, SURFACES, newBall, stepBall, inCourt, inServiceBox } from '../src/core.js';
import { readPointer, humanGround, humanServe } from '../src/shot.js';
import * as M from '../src/padmap.js';

let failures = 0, checks = 0;
const verbose = process.argv.includes('-v');
const ok = (c, msg) => { checks++; if (!c) { failures++; console.log('  FAIL ' + msg); } else if (verbose) console.log('  ok   ' + msg); return c; };
const section = (name) => console.log('- ' + name);
let seed = 4242;
Math.random = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const U = (a, b) => a + Math.random() * (b - a);
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

// ---- which pad, which names ----
section('pad kind and button names');
const IDS = {
  ds5: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
  ds4: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)',
  xbox: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
  xbox360: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)',
  pro: 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)',
  ffDs5: '054c-0ce6-Wireless Controller',
  ffXbox: '045e-0b13-Xbox Wireless Controller',
  other: '2dc8-3106-8BitDo Pro 2',
};
ok(M.padKind(IDS.ds5) === 'ps' && M.padKind(IDS.ds4) === 'ps' && M.padKind(IDS.ffDs5) === 'ps', 'DualSense / DualShock 4 (Chrome and Firefox ids) are PlayStation');
ok(M.padKind(IDS.xbox) === 'xbox' && M.padKind(IDS.xbox360) === 'xbox' && M.padKind(IDS.ffXbox) === 'xbox', 'Xbox pads are Xbox (even though "Xbox Wireless Controller" says wireless controller)');
ok(M.padKind(IDS.pro) === 'nintendo', 'Switch Pro is Nintendo-style');
ok(M.padKind(IDS.other) === 'xbox' && M.padKind('') === 'xbox' && M.padKind(undefined) === 'xbox', 'anything else reads as Xbox names');
const names = (kind) => ['a', 'b', 'x', 'y', 'lb', 'rb'].map((k) => M.glyph(kind, k)).join(' ');
ok(names('ps') === '✕ ○ □ △ L1 R1', 'PlayStation glyphs: ' + names('ps'));
ok(names('xbox') === 'A B X Y LB RB', 'Xbox glyphs: ' + names('xbox'));
ok(M.glyph('ps', 'start') === 'Options' && M.glyph('ps', 'back') === 'Touchpad' && M.glyph('xbox', 'back') === 'View', 'Options / Touchpad and Start / View');
ok(M.glyph('xbox', 'zzz') === 'ZZZ', 'an unknown name falls back to itself');

// ---- layouts ----
section('layouts: standard, and a PlayStation pad the browser reports raw');
const pad = (o) => ({ id: IDS.ds5, mapping: 'standard', buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0], ...o });
const rawHid = (n = 18, ax = 10) => pad({ mapping: '', id: IDS.ffDs5, buttons: Array.from({ length: n }, () => ({ pressed: false, value: 0 })), axes: new Array(ax).fill(0) });
ok(M.padLayout(pad({})) === 'standard', 'mapping "standard" is standard');
ok(M.padLayout(rawHid(18, 10), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0') === 'hid', 'Firefox on Windows: 18 raw buttons → hid layout');
ok(M.padLayout(rawHid(13, 8), 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0') === 'evdev', 'Firefox on Linux: 13 raw buttons → evdev layout');
ok(M.padLayout(pad({ mapping: '', id: IDS.other })) === 'unknown', 'a non-standard pad we do not know is "unknown"');
const press = (gp, i) => { gp.buttons[i] = { pressed: true, value: 1 }; };
const S = M.newPadState();
let gp = pad({}); press(gp, 0); press(gp, 4); gp.axes = [0.5, -0.5, 0.25, 0.75];
M.normalize(gp, 'standard', S);
ok(S.d[M.BTN.A] === 1 && S.d[M.BTN.LB] === 1 && S.d[M.BTN.B] === 0 && S.ax[0] === 0.5 && S.ax[1] === -0.5 && S.ax[3] === 0.75, 'standard: buttons and both sticks come through');
gp = rawHid(); press(gp, 1); press(gp, 2); press(gp, 0); press(gp, 3); press(gp, 4); press(gp, 5); press(gp, 9); press(gp, 13);
gp.axes[0] = -1; gp.axes[1] = 1; gp.axes[2] = 0.3; gp.axes[5] = -0.6;
M.normalize(gp, 'hid', S);
ok(S.d[M.BTN.A] && S.d[M.BTN.B] && S.d[M.BTN.X] && S.d[M.BTN.Y], 'hid: raw ✕ ○ □ △ (1 2 0 3) land on A B X Y');
ok(S.d[M.BTN.LB] && S.d[M.BTN.RB] && S.d[M.BTN.START] && S.d[M.BTN.PAD], 'hid: L1 R1 Options and the touchpad');
ok(S.ax[0] === -1 && S.ax[1] === 1 && Math.abs(S.ax[2] - 0.3) < 1e-6 && Math.abs(S.ax[3] + 0.6) < 1e-6, 'hid: the right stick is on axes 2 and 5');
gp = rawHid(); gp.axes[3] = 1; gp.axes[4] = -1 + 2 * 0.2;   // L2 fully pressed; R2 20% (a trigger axis rests at -1)
M.normalize(gp, 'hid', S);
ok(S.v[M.BTN.LT] === 1 && S.d[M.BTN.LT] === 1 && Math.abs(S.v[M.BTN.RT] - 0.2) < 1e-6 && S.d[M.BTN.RT] === 0, 'hid: analog triggers (-1 released .. 1 full) become 0..1 values, pressed past a half');
const hat = (h) => { const g = rawHid(); g.axes[9] = h; M.normalize(g, 'hid', S); return ['UP', 'RIGHT', 'DOWN', 'LEFT'].filter((k) => S.d[M.BTN[k]]).join('+') || '-'; };
ok([-1, -0.714, -0.43, -0.143, 0.143, 0.43, 0.714, 1, 1.2857].map(hat).join(' ') === 'UP UP+RIGHT RIGHT RIGHT+DOWN DOWN DOWN+LEFT LEFT UP+LEFT -', 'hid: the D-pad hat axis decodes to eight directions and released: ' + [-1, -0.714, -0.43, -0.143, 0.143, 0.43, 0.714, 1, 1.2857].map(hat).join(' '));
gp = rawHid(13, 8); press(gp, 0); press(gp, 3); press(gp, 2); press(gp, 1); press(gp, 10);
gp.axes[3] = 0.4; gp.axes[4] = -0.2; gp.axes[6] = -1; gp.axes[7] = 1;
M.normalize(gp, 'evdev', S);
ok(S.d[M.BTN.A] && S.d[M.BTN.X] && S.d[M.BTN.Y] && S.d[M.BTN.B], 'evdev: raw ✕ ○ △ □ (0 1 2 3) land on A B Y X');
ok(S.d[M.BTN.HOME] === 1 && Math.abs(S.ax[2] - 0.4) < 1e-6 && Math.abs(S.ax[3] + 0.2) < 1e-6, 'evdev: PS button, right stick on axes 3 and 4');
ok(S.d[M.BTN.LEFT] === 1 && S.d[M.BTN.DOWN] === 1 && S.d[M.BTN.RIGHT] === 0 && S.d[M.BTN.UP] === 0, 'evdev: the D-pad on axes 6 and 7');
// (normalize fills S in place: nothing is allocated when it is polled every frame.)
ok(M.normalize(pad({}), 'standard', S) === S, 'normalize reuses its state object');

// ---- the Buttons scheme ----
section('shots, hold power, serve, stick');
ok(M.shotFor(M.BTN.A) === 'flat' && M.shotFor(M.BTN.B) === 'topspin' && M.shotFor(M.BTN.X) === 'slice' && M.shotFor(M.BTN.Y) === 'lob', '✕ flat, ○ topspin, □ slice, △ lob');
ok(M.shotFor(M.BTN.X, true) === 'drop' && M.shotFor(M.BTN.A, true) === 'flat' && M.shotFor(M.BTN.B, true) === 'topspin', 'L1 + □ is a drop shot; L1 with the others changes nothing');
ok(M.serveFor(M.BTN.A) === 'flat' && M.serveFor(M.BTN.B) === 'kick' && M.serveFor(M.BTN.X) === 'slice', 'serve: ✕ flat, ○ kick, □ slice');
ok(M.chargeOf(0) === 0 && M.chargeOf(M.TAP_S) === 0 && M.chargeOf(M.FILL_S) === 1 && M.chargeOf(9) === 1, 'the charge is empty for a tap and full after about 0.8 s');
for (const sh of ['flat', 'topspin', 'slice', 'lob', 'drop']) {
  const p = [0, 0.1, 0.3, 0.5, 0.8, 2].map((h) => M.holdPower(h, sh)), r = [0, 0.4, 0.8].map((h) => M.holdPower(h, sh, true));
  ok(p.every((v, i) => i === 0 || v >= p[i - 1]) && p[0] > 0 && p[5] <= 1, `${sh}: power rises with the hold (${p.map((v) => v.toFixed(2)).join(' ')})`);
  ok(r.every((v, i) => v > M.holdPower([0, 0.4, 0.8][i], sh)), `${sh}: R1 is harder at every charge`);
}
ok(M.holdPower(0.05, 'flat') > 0.4 && M.holdPower(0.05, 'flat') < 0.62, 'a quick tap is a medium ball');
ok(M.holdPower(0.8, 'slice') < M.holdPower(0.8, 'flat') && M.holdPower(0.8, 'drop') < 0.3, 'a slice is softer than a drive; a drop shot is soft');
const sp = (t, ty, r) => M.servePower(t, ty, r);
ok(sp(0.7, 'flat') > sp(0.7, 'kick') && sp(0.7, 'flat') > sp(0.7, 'slice') && sp(0.7, 'flat', true) > sp(0.7, 'flat'), 'serve power: flat is the fastest, R1 goes flat out');
ok(sp(0.1) < sp(0.4) && sp(0.4) <= sp(0.8), 'serve power builds up as the toss rises');
ok(M.serveAim(-1) === 0 && M.serveAim(0) === 0.5 && M.serveAim(1) === 1, 'serve aim: stick left / centre / right → 0 / 0.5 / 1 across the box');
ok(M.serveWhere(0, 'deuce') === 'Wide' && M.serveWhere(1, 'deuce') === 'T' && M.serveWhere(0.5, 'deuce') === 'Body' && M.serveWhere(0, 'ad') === 'T' && M.serveWhere(1, 'ad') === 'Wide', 'serve target words follow the court');
const near = (a, b) => Math.abs(a - b) < 1e-9;
ok(near(M.stickAim(0.1, -0.1).x, 0) && near(M.stickAim(0.1, -0.1).y, 0) && near(M.stickAim(0.15, 0.15).x, 0), 'a stick resting near the middle is a safe middle ball (dead zone)');
const st = M.stickAim(1, 0), su = M.stickAim(0, -1), sd = M.stickAim(0, 1), sl = M.stickAim(-0.7, 0);
ok(st.x === 1 && su.y === 1 && sd.y === -1 && sl.x < 0 && sl.x > -1, 'right is +x, up (the pad axis is -1) is deep, down is short');
ok(Math.hypot(M.stickAim(1, 1).x, M.stickAim(1, 1).y) <= 1.0001, 'a diagonal at the rim is no more than full');
const w1 = M.aimWords(0, 0, 'fh', 'R'), w2 = M.aimWords(-0.8, 0, 'fh', 'R'), w3 = M.aimWords(0.8, 0, 'fh', 'R'), w4 = M.aimWords(0.8, 0, 'bh', 'R'), w5 = M.aimWords(0.8, 0, 'fh', 'L');
ok(/Middle/.test(w1) && /Cross/.test(w2) && /Down the line/.test(w3), `words: ${w1} | ${w2} | ${w3}`);
ok(/Cross/.test(w4) && /Cross/.test(w5), 'a right-hander’s backhand and a left-hander’s forehand cross to the right');
ok(/deep/.test(M.aimWords(0, 0.9)) && /short/.test(M.aimWords(0, -0.9)) && /short angle/.test(M.aimWords(0.9, -0.9)), 'deep / short / short angle');

// ---- the shot model ----
section('pad shots in the model');
const swing = (shot, o = {}) => {
  const power = o.power ?? M.holdPower(o.hold ?? 0.4, shot, !!o.risk), spin = M.SHOTS[shot].spin;
  return readPointer({ src: 'pad', power, spin, drop: shot === 'drop', pad: { shot, risk: !!o.risk, ax: o.ax || 0, ay: o.ay || 0 } });
};
const r0 = swing('lob', { ax: 0.4, ay: 0.5, risk: true });
ok(r0.pad && r0.pad.lob && r0.pad.risk && r0.dirX > 0.4 && r0.final && r0.across === null, 'readPad: lob flag, risk, direction and no follow-through to wait for');
ok(swing('drop').drop && !swing('slice').drop, 'only L1 + □ is a drop shot');
ok(Math.abs(swing('flat', { ax: 1 }).dirX) === 1 && Math.abs(swing('flat', { ax: 1, risk: true }).dirX) > 1.2, 'the stick asks for up to the sidelines; R1 goes for the lines');
const mouse = readPointer({ src: 'mouse', power: 0.5, spin: 0.3, aim: 0.6 });
ok(!mouse.pad && mouse.dirX === 0.6, 'a mouse swing is unchanged');
// Where a shot lands (its first bounce) in the hitter's frame.
function land(p, sol, serve = null) {
  const b = newBall(); b.p = { ...p }; b.v = { ...sol.v }; b.w = { ...sol.w }; const ev = [];
  for (let i = 0; i < 6 / DT; i++) {
    ev.length = 0; stepBall(b, SURFACES.hard, ev);
    for (const e of ev) {
      if (e.type === 'net' && !e.over) return { res: 'net' };
      if (e.type !== 'bounce') continue;
      if (Math.sign(e.z) === Math.sign(p.z)) return { res: 'net' };
      if (serve) return { res: inServiceBox(e.x, e.z, -Math.sign(p.z), serve) ? 'in' : 'out', x: e.x, z: e.z };
      return { res: inCourt(e.x, e.z) ? 'in' : Math.abs(e.z) > 11.885 + 0.015 ? 'long' : 'wide', x: e.x, z: e.z };
    }
  }
  return { res: 'none' };
}
const N = 500;
// n groundstrokes from a forehand at the baseline: tau is the timing (0 on time), diff the pressure.
function batch(read, o = {}) {
  const out = [];
  for (let i = 0; i < N; i++) {
    const side = o.side ?? (i % 2 ? 1 : -1), from = { x: side * U(-1.5, 1.5), y: U(0.7, 1.1), z: side * 12.2 };
    const g = humanGround({ from, side, mx: from.x * side, stroke: o.stroke || 'fh', handed: 'R', pow: read.pow, spin: read.spin, drop: read.drop, dirX: read.dirX, pad: read.pad, tau: o.tau ?? U(-0.15, 0.15), q: o.q ?? 1, diff: o.diff ?? U(0, 0.4), volley: false });
    const L = land(from, g.sol);
    out.push({ ...L, g, x: L.x == null ? NaN : L.x * side, z: L.z == null ? NaN : Math.abs(L.z), from });
  }
  return out;
}
const inPct = (a) => a.filter((x) => x.res === 'in').length / a.length;
const okOnly = (a, k) => a.filter((x) => x.res === 'in').map((x) => x[k]);
const KIND = { flat: 'Drive', topspin: 'Topspin', slice: 'Slice', lob: 'Lob', drop: 'Drop shot' };
const R = {};
for (const sh of ['flat', 'topspin', 'slice', 'lob', 'drop']) {
  const a = R[sh] = batch(swing(sh, { hold: 0.05 })), b = batch(swing(sh, { hold: 0.9 }));
  ok(a.every((x) => x.g.kind === KIND[sh]) && b.every((x) => x.g.kind === KIND[sh]), `${sh}: reads as a ${KIND[sh]}`);
  ok(inPct(a) >= 0.93, `${sh} tap, on time: ${Math.round(100 * inPct(a))}% in`);
  ok(inPct(b) >= (sh === 'flat' || sh === 'topspin' ? 0.8 : 0.9), `${sh} full charge, on time: ${Math.round(100 * inPct(b))}% in`);
}
const rpm = (sh) => mean(R[sh].map((x) => x.g.rpm)), kmh = (sh) => mean(R[sh].map((x) => Math.hypot(x.g.sol.v.x, x.g.sol.v.y, x.g.sol.v.z) * 3.6));
ok(rpm('topspin') > rpm('flat') + 800 && rpm('flat') > 500 && rpm('slice') < -1200 && rpm('drop') < -1500, `spin: topspin ${Math.round(rpm('topspin'))}, flat ${Math.round(rpm('flat'))}, slice ${Math.round(rpm('slice'))}, drop ${Math.round(rpm('drop'))} rpm`);
ok(mean(okOnly(R.lob, 'z')) > 9.4 && mean(okOnly(R.slice, 'z')) < mean(okOnly(R.topspin, 'z')), 'a lob lands deep; a slice sits shorter than a topspin drive');
ok(mean(okOnly(R.drop, 'z')) < 4.5 && kmh('drop') < 60, `a drop shot lands short (${mean(okOnly(R.drop, 'z')).toFixed(1)} m) and soft (${Math.round(kmh('drop'))} km/h)`);
const fullT = batch(swing('topspin', { hold: 0.9 })), tapT = R.topspin;
ok(mean(fullT.map((x) => Math.hypot(x.g.sol.v.x, x.g.sol.v.y, x.g.sol.v.z))) > 1.15 * mean(tapT.map((x) => Math.hypot(x.g.sol.v.x, x.g.sol.v.y, x.g.sol.v.z))), 'a full charge is well faster than a tap');
// Aim: the stick steers the direction, up goes deeper, down comes up short.
const A = (ax, ay, sh = 'topspin', risk = false) => batch(swing(sh, { hold: 0.4, ax, ay, risk }));
const aL = A(-1, 0), aC = A(0, 0), aR = A(1, 0), aH = A(0.5, 0);
ok(mean(okOnly(aL, 'x')) < -1.8 && mean(okOnly(aR, 'x')) > 1.8 && Math.abs(mean(okOnly(aC, 'x'))) < 0.5, `left / centre / right land at x ${mean(okOnly(aL, 'x')).toFixed(1)} / ${mean(okOnly(aC, 'x')).toFixed(1)} / ${mean(okOnly(aR, 'x')).toFixed(1)} m`);
ok(mean(okOnly(aH, 'x')) > mean(okOnly(aC, 'x')) + 0.4 && mean(okOnly(aH, 'x')) < mean(okOnly(aR, 'x')), 'half a push is half the way');
ok(inPct(aL) >= 0.88 && inPct(aR) >= 0.88, `full sideways aim, on time, stays mostly in (${Math.round(100 * inPct(aL))}% / ${Math.round(100 * inPct(aR))}%)`);
const dp = A(0, 1), sh1 = A(0, -1), sa = A(1, -1), sal = A(-1, -1);
ok(mean(okOnly(dp, 'z')) > mean(okOnly(aC, 'z')) + 0.4 && mean(okOnly(sh1, 'z')) < mean(okOnly(aC, 'z')) - 2, `deep ${mean(okOnly(dp, 'z')).toFixed(1)} m, neutral ${mean(okOnly(aC, 'z')).toFixed(1)} m, short ${mean(okOnly(sh1, 'z')).toFixed(1)} m`);
ok(mean(okOnly(sa, 'x')) > 1.8 && mean(okOnly(sal, 'x')) < -1.8 && mean(okOnly(sa, 'z')) < 8.5, `short angles go wide and short (${mean(okOnly(sa, 'x')).toFixed(1)} m, ${mean(okOnly(sa, 'z')).toFixed(1)} m deep)`);
ok(inPct(dp) < inPct(aC) + 0.02 && inPct(dp) >= 0.85, `aiming deep is a little riskier (${Math.round(100 * inPct(dp))}% vs ${Math.round(100 * inPct(aC))}%)`);
// Aiming close to the lines at full power misses more.
const rk = A(1, 1, 'flat', true), rk0 = A(0, 0, 'flat', true), fl = A(0, 0, 'flat');
ok(inPct(rk) < inPct(A(1, 0, 'flat')) && inPct(rk0) < inPct(fl), `R1 power / lines miss more (${Math.round(100 * inPct(rk))}% at the line, ${Math.round(100 * inPct(rk0))}% centred, vs ${Math.round(100 * inPct(fl))}%)`);
ok(mean(rk0.map((x) => Math.hypot(x.g.sol.v.x, x.g.sol.v.y, x.g.sol.v.z))) > 1.05 * mean(fl.map((x) => Math.hypot(x.g.sol.v.x, x.g.sol.v.y, x.g.sol.v.z))), 'and it is harder');
ok(inPct(rk) >= 0.4, `even the riskiest ball goes in sometimes (${Math.round(100 * inPct(rk))}%)`);
// Timing: early and late pull and push, and cost accuracy.
// (q, the timing quality, is worked out from tau in game.js humanShot: the same formula here.)
const qOf = (tau) => { const a = Math.abs(tau), ss = (lo, hi) => { const t = Math.min(1, Math.max(0, (a - lo) / (hi - lo))); return t * t * (3 - 2 * t); }; return 1 - 0.25 * ss(0.3, 1.0) - 0.75 * ss(1.0, 1.6); };
const late = batch(swing('topspin', { ax: 0 }), { tau: 1.3, q: qOf(1.3) }), early = batch(swing('topspin', { ax: 0 }), { tau: -1.3, q: qOf(1.3) });
ok(inPct(late) < inPct(aC) - 0.1 && inPct(early) < inPct(aC) - 0.1, `mistimed shots miss more (early ${Math.round(100 * inPct(early))}%, late ${Math.round(100 * inPct(late))}%, on time ${Math.round(100 * inPct(aC))}%)`);
// A backhand is the same aim: the stick means left / right for the player.
const bhR = batch(swing('topspin', { ax: 1 }), { stroke: 'bh' }), bhL = batch(swing('topspin', { ax: -1 }), { stroke: 'bh' });
ok(mean(okOnly(bhR, 'x')) > 1.8 && mean(okOnly(bhL, 'x')) < -1.8, 'a backhand goes where the stick points too');

section('pad serves');
const serveBatch = (type, a, o = {}) => {
  const out = [];
  for (let i = 0; i < 300; i++) {
    const side = i % 2 ? 1 : -1, court = i % 4 < 2 ? 'deuce' : 'ad', from = { x: side * (court === 'deuce' ? 0.8 : -0.8), y: 2.9, z: side * 12.25 };
    const power = M.servePower(o.since ?? U(0.62, 0.74), type, !!o.risk), s = humanServe({ from, side, court, second: !!o.second, power, a, q: o.q ?? 1, pad: { shot: type, risk: !!o.risk, handed: 'R' } });
    const L = land(from, s.sol, court);
    out.push({ ...L, s, side, court, x: L.x == null ? NaN : L.x * side, z: L.z == null ? NaN : Math.abs(L.z), kmh: Math.hypot(s.sol.v.x, s.sol.v.y, s.sol.v.z) * 3.6 });
  }
  return out;
};
const F = serveBatch('flat', 0.5), K = serveBatch('kick', 0.5), Sl = serveBatch('slice', 0.5);
for (const [n, a] of [['flat', F], ['kick', K], ['slice', Sl]]) ok(inPct(a) >= 0.8, `${n} serve, on time, at the body: ${Math.round(100 * inPct(a))}% in, ${Math.round(mean(a.map((x) => x.kmh)))} km/h`);
ok(mean(F.map((x) => x.kmh)) > mean(Sl.map((x) => x.kmh)) && mean(Sl.map((x) => x.kmh)) > mean(K.map((x) => x.kmh)), 'flat is the fastest serve, then slice, then kick');
ok(mean(K.map((x) => Math.abs(x.s.rpm))) > mean(F.map((x) => Math.abs(x.s.rpm))) + 1500, 'a kick serve has a lot more spin');
ok(humanServe({ from: { x: 0.8, y: 2.9, z: 12.25 }, side: 1, court: 'deuce', power: 0.7, a: 0.5, q: 1, pad: { shot: 'slice', handed: 'R' } }).sol.w.y !== 0 && humanServe({ from: { x: 0.8, y: 2.9, z: 12.25 }, side: 1, court: 'deuce', power: 0.7, a: 0.5, q: 1, pad: { shot: 'flat' } }).sol.w.y === 0, 'only the slice serve has sidespin');
const wide = serveBatch('flat', 0), tee = serveBatch('flat', 1);
const dc = (a) => a.filter((x) => x.court === 'deuce'), ac = (a) => a.filter((x) => x.court === 'ad');   // (wide = stick left, tee = stick right)
ok(mean(okOnly(dc(wide), 'x')) < mean(okOnly(dc(tee), 'x')) - 1.5 && mean(okOnly(ac(wide), 'x')) < mean(okOnly(ac(tee), 'x')) - 1.5, 'the stick aims the serve: left is left of right in both courts (wide in the deuce court, the T in the ad court)');
ok(inPct(wide) >= 0.7 && inPct(tee) >= 0.7, `stick left / right serves stay in (${Math.round(100 * inPct(wide))}% / ${Math.round(100 * inPct(tee))}%)`);
const mistimed = serveBatch('flat', 0.5, { q: 0.3 });
ok(inPct(mistimed) < inPct(F) - 0.05, 'a mistimed release serves worse');
const risk = serveBatch('flat', 0.5, { risk: true, since: 0.7 });
ok(inPct(risk) < inPct(F) - 0.05 && inPct(risk) > 0.5, `R1 serve: goes for the lines, so it misses more (${Math.round(100 * inPct(risk))}% vs ${Math.round(100 * inPct(F))}% in) but not always`);
const second = serveBatch('flat', 0.5, { second: true, since: 0.7 });
ok(inPct(second) >= 0.93, `second serves go in (${Math.round(100 * inPct(second))}%)`);

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(failures ? 1 : 0);
