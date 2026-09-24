// Ball physics that the line calls depend on (src/core.js). Pure Node, no browser:
//   node tests/sim/physics.test.mjs          exit 1 on failure
import { stepBall, newBall, simLanding, solveShot, SURFACES, COURT, LINE_TOL, BALL_R, DT, RPM, netHeight, inCourt, inServiceBox } from '../../src/core.js';

let failures = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { failures++; if (failures < 40) console.log('  FAIL ' + msg); } return c; };
const section = (name) => console.log('- ' + name);
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const r = rng(99);
const U = (a, b) => a + r() * (b - a);

// Step a ball until its first bounce (or maxT). Returns the bounce event and whether it touched the net.
function firstBounce(p, v, w, surf = SURFACES.hard, maxT = 4) {
  const b = newBall(); b.p = { ...p }; b.v = { ...v }; b.w = { ...w };
  const ev = [];
  let net = false;
  for (let i = 0; i < maxT / DT; i++) {
    ev.length = 0; stepBall(b, surf, ev);
    for (const e of ev) { if (e.type === 'net') net = true; if (e.type === 'bounce') return { e, net }; }
  }
  return { e: null, net };
}

section('line judges geometry (inCourt / inServiceBox, lines inside the court, LINE_TOL contact patch)');
{
  const edge = COURT.halfSW + LINE_TOL, base = COURT.halfL + LINE_TOL;
  ok(inCourt(edge - 1e-6, 0) && !inCourt(edge + 1e-3, 0), 'sideline: touching is in, a millimetre past the patch is out');
  ok(inCourt(0, base - 1e-6) && !inCourt(0, -base - 1e-3), 'baseline');
  ok(inCourt(-edge + 1e-6, -base + 1e-6), 'corner');
  // Receiver on the -z half (player 1, facing +z): their deuce box is on their right, which is -x.
  ok(inServiceBox(-2, -4, -1, 'deuce') && !inServiceBox(2, -4, -1, 'deuce'), 'deuce box of the -z receiver is at -x');
  ok(inServiceBox(2, -4, -1, 'ad') && !inServiceBox(-2, -4, -1, 'ad'), 'ad box of the -z receiver is at +x');
  ok(inServiceBox(2, 4, 1, 'deuce') && inServiceBox(-2, 4, 1, 'ad'), 'boxes of the +z receiver');
  ok(!inServiceBox(-2, 4, -1, 'deuce'), 'the server\'s own half is never in');
  ok(inServiceBox(-1, -(COURT.svc + LINE_TOL - 1e-6), -1, 'deuce') && !inServiceBox(-1, -(COURT.svc + LINE_TOL + 1e-3), -1, 'deuce'), 'service line');
  // centre service line: 5 cm wide, shared by both boxes
  ok(inServiceBox(0.02, -3, -1, 'deuce') && inServiceBox(-0.02, -3, -1, 'ad'), 'centre line belongs to both boxes');
  ok(!inServiceBox(0.025 + LINE_TOL + 1e-3, -3, -1, 'deuce'), 'past the centre line is out');
}

section('the line is judged where the ball meets the court (not at the end of a physics step)');
{
  let worst = 0, n = 0;
  for (let i = 0; i < 400; i++) {
    const serve = i % 2 === 0, side = r() < 0.5 ? 1 : -1;
    const p0 = serve ? { x: side * U(0.3, 1), y: U(2.6, 3.0), z: side * 12.2 } : { x: U(-4, 4), y: U(0.5, 1.4), z: side * U(8, 13) };
    const tx = serve ? -side * U(0.2, 4) : U(-4.5, 4.5), tz = serve ? -side * U(5, 6.6) : -side * U(8, 12.2);
    const kmh = serve ? U(120, 215) : U(60, 140), rpm = U(-2000, 3000);
    const sol = solveShot(p0, tx, tz, kmh / 3.6, rpm * RPM, serve ? { lo: -0.45, hi: 0.3, minNet: 0.03 } : { minNet: 0.12 });
    const land = simLanding(p0, sol.v, sol.w), { e, net } = firstBounce(p0, sol.v, sol.w);
    if (!e || net) continue;
    const d = Math.hypot(e.x - land.x, e.z - land.z);
    worst = Math.max(worst, d); n++;
  }
  ok(n > 300, `enough clean shots (${n})`);
  ok(worst < 0.004, `bounce spot within 4 mm of the true contact point (worst ${(worst * 100).toFixed(1)} cm)`);
}

section('ITF rebound: a 2.54 m drop on hard court comes back up 1.35-1.47 m');
{
  const b = newBall(); b.p = { x: 0, y: 2.54, z: 5 };
  let top = 0, bounced = false;
  const ev = [];
  for (let i = 0; i < 3 / DT; i++) { ev.length = 0; stepBall(b, SURFACES.hard, ev); if (ev.some((e) => e.type === 'bounce')) bounced = true; if (bounced) { top = Math.max(top, b.p.y); if (b.v.y < 0 && top > 0.5) break; } }
  ok(top > 1.30 && top < 1.50, `rebound ${top.toFixed(2)} m`);
}

section('the ball never passes through the net (rallies, net cords, drop-backs, rolling, bounce-backs off the fence)');
{
  let crossings = 0, through = 0, cords = 0, samples = [];
  for (let i = 0; i < 3000; i++) {
    const side = r() < 0.5 ? 1 : -1, surf = [SURFACES.hard, SURFACES.clay, SURFACES.grass][i % 3];
    const b = newBall();
    b.p = { x: U(-4, 4), y: U(0.2, 2.8), z: side * U(3, 12) };
    // aim at the tape, low into the net, or just over, with any spin
    const sp = U(8, 45), aimY = U(0.2, 1.3), dz = -b.p.z, T = Math.abs(dz) / sp;
    b.v = { x: U(-3, 3), y: (aimY - b.p.y) / T + 0.5 * 9.81 * T, z: -side * sp };
    b.w = { x: U(-300, 300), y: U(-50, 50), z: U(-100, 100) };
    const ev = [];
    let x0 = b.p.x, y0 = b.p.y, z0 = b.p.z;
    for (let k = 0; k < 12 / DT; k++) {
      ev.length = 0; stepBall(b, surf, ev);
      const net = ev.some((e) => e.type === 'net');
      if (ev.some((e) => e.cord)) cords++;
      const p = b.p;
      if (!net && z0 !== 0 && (z0 > 0) !== (p.z > 0)) {
        crossings++;
        const f = z0 / (z0 - p.z), x = x0 + (p.x - x0) * f, y = y0 + (p.y - y0) * f;
        if (Math.abs(x) < COURT.postX && y - netHeight(x) < BALL_R - 1e-3) { through++; if (samples.length < 3) samples.push(`x ${x.toFixed(2)} y ${y.toFixed(3)} rolling ${b.rolling} step ${k}`); }
      }
      x0 = p.x; y0 = p.y; z0 = p.z;
      if (b.rolling && Math.hypot(b.v.x, b.v.z) < 0.02) break;
    }
  }
  ok(cords > 50, `net cords exercised (${cords})`);
  ok(through === 0, `${through} of ${crossings} crossings went through the net${samples.length ? ': ' + samples.join('; ') : ''}`);
}

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(failures ? 1 : 0);
