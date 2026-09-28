// The swing → shot model (src/shot.js). Pure Node, no browser:   node test/shot.test.mjs [-v]
// Plays thousands of shots through the real ball physics and checks where they land: on-time swings at normal power
// go in about 90%+ of the time, very hard ones still mostly; misses come from timing, pressure, power and the lines.
import { DT, SURFACES, newBall, stepBall, inCourt, inServiceBox, clamp, sstep } from '../src/core.js';
import { humanGround, humanServe, aimGround, ballSide } from '../src/shot.js';

let failures = 0, checks = 0;
const verbose = process.argv.includes('-v');
const ok = (c, msg) => { checks++; if (!c) { failures++; console.log('  FAIL ' + msg); } else if (verbose) console.log('  ok   ' + msg); return c; };
const section = (name) => console.log('- ' + name);
// Seeded randomness, so a run is repeatable (the model's scatter uses Math.random through gauss()).
let seed = 12345;
Math.random = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const R = Math.random, U = (a, b) => a + R() * (b - a);
const G = () => { let u = 0; while (!u) u = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * R()); };

// Fly a shot to its first bounce: 'in', 'long', 'wide' or 'net' (and where it landed).
export function land(p, sol, serve = null) {
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

// The game's timing quality for a swing tau (see humanShot): 1 on time, less early or late.
const quality = (tau) => 1 - 0.25 * sstep(0.3, 1.0, Math.abs(tau)) - 0.75 * sstep(1.0, 1.6, Math.abs(tau));
// One groundstroke from a typical baseline contact, by player 0 (side +1) or 1.
function stroke(o) {
  const side = R() < 0.5 ? 1 : -1, x = U(-3.4, 3.4), from = { x, y: U(0.7, 1.25), z: side * U(11.2, 13.2) };
  const tau = o.tau ?? G() * 0.18, st = o.stroke || (R() < 0.6 ? 'fh' : 'bh'), handed = o.handed || 'R';
  const shot = humanGround({ from, side, mx: x * side, stroke: st, handed, pow: o.pow, spin: o.spin ?? 0.25, drop: o.drop, dirX: o.dirX === undefined ? U(-1, 1) : o.dirX, tau, q: quality(tau), diff: o.diff ?? 0.4 });
  return { shot, ...land(from, shot.sol), side, st, handed };
}
function rate(o, n = 600) {
  const c = { in: 0, long: 0, wide: 0, net: 0, none: 0 };
  for (let i = 0; i < n; i++) c[stroke(o).res]++;
  for (const k in c) c[k] /= n;
  return c;
}
const pct = (v) => `${Math.round(v * 100)}%`;
const row = (c) => `in ${pct(c.in)} (long ${pct(c.long)}, wide ${pct(c.wide)}, net ${pct(c.net)})`;

section('on-time groundstrokes land in');
{
  const table = [];
  for (const diff of [0.2, 0.5, 0.8]) {
    const cells = [0.3, 0.5, 0.65, 0.8, 0.95].map((pow) => { const c = rate({ pow, diff }); return [pow, c]; });
    table.push(`  pressure ${diff}: ` + cells.map(([p, c]) => `p${p} ${pct(c.in)}`).join(' · '));
    for (const [pow, c] of cells) {
      if (pow <= 0.8 && diff <= 0.5) ok(c.in >= 0.9, `on time, power ${pow}, pressure ${diff}: ${row(c)}`);
      if (pow <= 0.8 && diff > 0.5) ok(c.in >= 0.82, `on time, power ${pow}, heavy pressure: ${row(c)}`);
      if (pow > 0.9) ok(c.in >= (diff > 0.5 ? 0.6 : 0.7) && c.in <= 0.95, `on time, flat out (${pow}), pressure ${diff}: mostly in but not free: ${row(c)}`);
    }
  }
  console.log(table.join('\n'));
  for (const spin of [-0.6, 0.1, 0.9]) { const c = rate({ pow: 0.7, spin }); ok(c.in >= 0.9, `on time, spin ${spin}: ${row(c)}`); }
}

section('misses come from timing, power and the lines');
{
  const on = rate({ pow: 0.65, tau: 0 }), early = rate({ pow: 0.65, tau: -1.2, dirX: 0 }), late = rate({ pow: 0.65, tau: 1.3, dirX: null });
  ok(early.in < on.in - 0.1 && late.in < on.in - 0.15, `very early / late costs: on time ${pct(on.in)}, early ${pct(early.in)}, late (timing aims) ${pct(late.in)}`);
  ok(late.wide > late.long, `a late swing misses wide more than long: ${row(late)}`);
  const safe = rate({ pow: 0.65, dirX: 1 }), lines = rate({ pow: 0.65, dirX: 1.3 });
  ok(safe.in >= 0.88 && lines.in < safe.in - 0.08, `going for the lines is a risk: to the side ${row(safe)}; at the line ${row(lines)}`);
  const hard = rate({ pow: 1 }), normal = rate({ pow: 0.6 });
  ok(hard.in < normal.in - 0.1, `flat out misses more than normal: ${row(hard)} vs ${row(normal)}`);
}

section('direction follows the aim');
{
  // Straight from the middle lands in the middle; a hard swing to one side lands on that side, for both strokes.
  for (const st of ['fh', 'bh']) for (const handed of ['R', 'L']) {
    const bs = ballSide(st, handed), mean = (dirX) => { let s = 0; for (let i = 0; i < 300; i++) s += aimGround({ pow: 0.6, spin: 0.3, dirX, tau: 0, mx: 0, side: bs }).x; return s / 300; };
    ok(Math.abs(mean(0)) < 0.2 && mean(-1) < -2.4 && mean(1) > 2.4, `${handed} ${st}: straight ${mean(0).toFixed(2)}, left ${mean(-1).toFixed(2)}, right ${mean(1).toFixed(2)}`);
    // Timing is a smaller nudge: early pulls across (away from the ball's side).
    const e = aimGround({ pow: 0.6, spin: 0.3, dirX: 0, tau: -1, mx: 0, side: bs }).x;
    ok(Math.sign(e) === -bs && Math.abs(e) < 1.2, `${handed} ${st}: early pulls across a little (${e.toFixed(2)})`);
  }
  // Landing spots agree with the aim.
  let hit = 0, n = 0;
  for (let i = 0; i < 600; i++) {
    const dirX = R() < 0.5 ? -1 : 1, r = stroke({ pow: 0.6, dirX, tau: 0 });
    if (r.res === 'in') { n++; if (Math.sign(r.x * r.side) === dirX) hit++; }
  }
  ok(hit / n > 0.95, `hard left / right swings land on that side: ${pct(hit / n)}`);
}

section('drop shots');
{
  let short = 0, inn = 0; const n = 800;
  for (let i = 0; i < n; i++) { const r = stroke({ pow: 0.15, spin: -0.7, drop: true, dirX: 0 }); if (r.res === 'in') { inn++; if (Math.abs(r.z) < 5) short++; } }
  ok(inn / n >= 0.75 && short / inn > 0.9, `on-time drop shots: in ${pct(inn / n)}, short (inside 5 m of the net) ${pct(short / inn)}`);
}

section('serves');
{
  const serve = (power, second = false, q = 1) => {
    const c = { in: 0, out: 0, net: 0 };
    for (let i = 0; i < 600; i++) {
      const side = R() < 0.5 ? 1 : -1, court = R() < 0.5 ? 'deuce' : 'ad', from = { x: side * (court === 'deuce' ? 0.8 : -0.8), y: 2.75, z: side * 11.85 };
      const s = humanServe({ from, side, court, second, power, a: R(), q });
      const r = land(from, s.sol, court).res; c[r === 'in' ? 'in' : r === 'net' ? 'net' : 'out']++;
    }
    return c.in / 600;
  };
  const p5 = serve(0.5), p8 = serve(0.8), p1 = serve(1), sec = serve(0.9, true), off = serve(0.7, false, 0.5);
  console.log(`  first serves on time: power 0.5 ${pct(p5)}, 0.8 ${pct(p8)}, 1.0 ${pct(p1)}; second ${pct(sec)}; mistimed ${pct(off)}`);
  ok(p5 >= 0.85 && p8 >= 0.75 && p1 >= 0.5 && p1 < p8, 'on-time first serves land in, flat out a little less');
  ok(sec >= 0.9, 'second serves are safe');
  ok(off < p8 - 0.1, 'a mistimed serve misses more');
}

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(failures ? 1 : 0);
