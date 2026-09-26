
// =====================================================================
// CORE: constants, math, ball physics, shot solver
// =====================================================================
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
function gauss() { let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const RPM = (2 * Math.PI) / 60;

// Court (ITF, metres). z runs baseline to baseline with the net at z = 0, x runs across.
// Player 0 plays from the +z half, player 1 from the -z half. Lines lie inside these dimensions.
const COURT = { halfL: 11.885, halfSW: 4.115, halfDW: 5.485, svc: 6.40, netC: 0.914, netP: 1.07, postX: 6.40 };
const LINE_TOL = 0.015;          // contact-patch radius: a ball this close outside a line still touches it
const BALL_R = 0.0335;           // 6.7 cm ball, 57.7 g
const BALL_M = 0.0577;
const K_AIR = (0.5 * 1.21 * Math.PI * BALL_R * BALL_R) / BALL_M;
const CD = 0.55;
const GRAV = 9.81;
const DT = 1 / 240;
const SURFACES = {
  hard:  { label: 'Hard',  e: 0.76, mu: 0.55 },
  clay:  { label: 'Clay',  e: 0.81, mu: 0.80 },
  grass: { label: 'Grass', e: 0.70, mu: 0.38 },
};
const FORMATS = {
  tiebreak: { label: 'Tiebreak', games: 0, tbOnly: true },
  short:    { label: 'Short set', games: 4 },
  full:     { label: 'Full set', games: 6 },
};
// CPU opponents. speed/acc/react: legs (m/s, m/s², s). err: shot scatter. power/serve: pace ranges (0..1).
// iq: shot choice (0 hits anywhere, 1 plays the percentages). pos: footwork, how far from the ideal contact point it
// tends to arrive (m). judge: how far out (m) a ball must be before it lets it go. sErr: serve scatter. risk: how close
// to the lines first serves go.
const LEVELS = {
  rookie: { label: 'Rookie', speed: 4.3, acc: 3.6, react: 0.42, err: 1.7,  power: [0.22, 0.55], serve: [0.1, 0.4], iq: 0.25, pos: 0.26, judge: 0.9, sErr: 2.0, risk: 0.25 },
  club:   { label: 'Club',   speed: 5.1, acc: 4.5, react: 0.3, err: 1.05, power: [0.32, 0.76], serve: [0.35, 0.68], iq: 0.55, pos: 0.18, judge: 0.45, sErr: 1.5, risk: 0.5 },
  pro:    { label: 'Pro',    speed: 5.7, acc: 5.1, react: 0.24, err: 0.62, power: [0.45, 0.92], serve: [0.64, 1.0], iq: 0.9,  pos: 0.1,  judge: 0.2, sErr: 1.3, risk: 0.8 },
};

function netHeight(x) {
  const a = Math.min(Math.abs(x) / COURT.postX, 1);
  return COURT.netC + (COURT.netP - COURT.netC) * Math.pow(a, 1.6);
}
function inCourt(x, z) { return Math.abs(x) <= COURT.halfSW + LINE_TOL && Math.abs(z) <= COURT.halfL + LINE_TOL; }
// Service box on the receiver's half. rSide is the sign of the receiver's z; 'deuce' is the receiver's right-hand box.
function inServiceBox(x, z, rSide, court) {
  if (Math.sign(z) !== rSide || Math.abs(z) > COURT.svc + LINE_TOL) return false;
  const lx = x * (court === 'deuce' ? rSide : -rSide);
  return lx >= -0.025 - LINE_TOL && lx <= COURT.halfSW + LINE_TOL;
}

function newBall() { return { p: { x: 0, y: 1, z: 0 }, v: { x: 0, y: 0, z: 0 }, w: { x: 0, y: 0, z: 0 }, netDone: false, rolling: false }; }
function copyBall(b) { return { p: { ...b.p }, v: { ...b.v }, w: { ...b.w }, netDone: b.netDone, rolling: b.rolling }; }

// Gravity + quadratic drag + Magnus lift (Cl from the spin parameter, after Watts & Ferrer).
function flight(s, dt = DT) {
  const p = s.p, v = s.v, w = s.w;
  const sp = Math.hypot(v.x, v.y, v.z);
  let ax = 0, ay = -GRAV, az = 0;
  if (sp > 0.05) {
    const d = K_AIR * CD * sp;
    ax -= d * v.x; ay -= d * v.y; az -= d * v.z;
    const wm = Math.hypot(w.x, w.y, w.z);
    if (wm > 1) {
      const S = (BALL_R * wm) / sp;
      const cl = Math.min(0.32, 1 / (2 + 1 / S));
      const cx = w.y * v.z - w.z * v.y, cy = w.z * v.x - w.x * v.z, cz = w.x * v.y - w.y * v.x;
      const cm = Math.hypot(cx, cy, cz);
      if (cm > 1e-9) { const f = (K_AIR * cl * sp * sp) / cm; ax += f * cx; ay += f * cy; az += f * cz; }
    }
  }
  v.x += ax * dt; v.y += ay * dt; v.z += az * dt;
  p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;
  const k = 1 - 0.02 * dt; w.x *= k; w.y *= k; w.z *= k;
}

function walls(s) {
  const p = s.p, v = s.v;
  if (Math.abs(p.z) > 20.6 && Math.sign(v.z) === Math.sign(p.z)) { v.z *= -0.3; v.x *= 0.6; p.z = Math.sign(p.z) * 20.6; }
  if (Math.abs(p.x) > 10.6 && Math.sign(v.x) === Math.sign(p.x)) { v.x *= -0.3; v.z *= 0.6; p.x = Math.sign(p.x) * 10.6; }
}

// One fixed physics step, with net and ground collisions. Pushes events into ev.
function stepBall(s, surf, ev) {
  if (s.rolling) {
    const k = Math.max(0, 1 - 1.2 * DT), z0 = s.p.z;
    s.v.x *= k; s.v.z *= k; s.v.y = 0;
    s.p.x += s.v.x * DT; s.p.z += s.v.z * DT; s.p.y = BALL_R;
    // A rolling ball stops against the net instead of rolling through it.
    if (z0 !== 0 && (z0 > 0) !== (s.p.z > 0) && Math.abs(s.p.x) < COURT.postX + 0.05) { s.p.z = Math.sign(z0) * (BALL_R + 0.005); s.v.z *= -0.2; s.v.x *= 0.5; }
    walls(s);
    return;
  }
  const x0 = s.p.x, y0 = s.p.y, z0 = s.p.z;
  flight(s);
  const p = s.p, v = s.v, w = s.w;
  let netHit = false;
  if (z0 !== 0 && (z0 > 0) !== (p.z > 0)) {
    const f = z0 / (z0 - p.z);
    const xc = x0 + (p.x - x0) * f, yc = y0 + (p.y - y0) * f;
    if (Math.abs(xc) < COURT.postX + 0.05) {
      const top = netHeight(xc), d = yc - top;
      if (d < BALL_R) {
        const side0 = z0 > 0 ? 1 : -1, cord = !s.netDone && d > -0.4 * BALL_R;
        // One tape clip per shot; after that (a ball coming back at the net) the net just stops it.
        s.netDone = netHit = true;
        if (cord) {
          // Clipped the tape: the ball pops up and dribbles over, or drops back.
          const q = (d + 0.4 * BALL_R) / (1.4 * BALL_R);
          const over = q > 0.3;
          v.x *= 0.65; v.y = 0.6 + 1.6 * q + Math.max(0, v.y) * 0.3; v.z *= over ? 0.2 + 0.45 * q : -0.12;
          w.x *= 0.3; w.y *= 0.3; w.z *= 0.3;
          p.x = xc; p.y = Math.max(yc, top + 0.01); p.z = (over ? -side0 : side0) * 0.045;
          ev.push({ type: 'net', cord: true, over, x: xc, y: yc });
        } else {
          v.z *= -0.1; v.x *= 0.3; v.y *= 0.25; w.x *= 0.2; w.y *= 0.2; w.z *= 0.2;
          p.x = xc; p.y = yc; p.z = side0 * (BALL_R + 0.03);
          ev.push({ type: 'net', cord: false, over: false, x: xc, y: yc });
        }
      }
    }
  }
  if (p.y < BALL_R && v.y < 0) {
    // Where the ball met the court: part-way through this step, not where the step ends (that is up to v * DT deeper,
    // 15 cm on a fast serve, and the line is judged at this spot).
    const fc = netHit || !(y0 > p.y) ? 1 : clamp((y0 - BALL_R) / (y0 - p.y), 0, 1), cx = x0 + (p.x - x0) * fc, cz = z0 + (p.z - z0) * fc;
    p.y = BALL_R;
    const vin = -v.y;
    if (vin < 0.35) { s.rolling = true; v.y = 0; }
    else {
      const e = surf.e * (vin < 2 ? 0.85 : 1);
      v.y = vin * e;
      // Friction impulse at the contact point, limited by mu * normal impulse (hollow sphere, I = 2/3 m r^2).
      const N = (1 + e) * vin;
      const ux = v.x + w.z * BALL_R, uz = v.z - w.x * BALL_R;
      const um = Math.hypot(ux, uz);
      if (um > 1e-6) {
        const j = Math.min(um * 0.4, surf.mu * N);
        const jx = (-ux / um) * j, jz = (-uz / um) * j;
        v.x += jx; v.z += jz;
        const k = 1.5 / BALL_R;
        w.x -= k * jz; w.z += k * jx;
      }
      ev.push({ type: 'bounce', x: cx, z: cz, vin });
    }
  }
  walls(s);
}

// Future path samples (every 2 steps) until the second bounce.
function predictPath(state, surf, tMax, t0) {
  const s = copyBall(state), out = [], ev = [];
  let t = t0, bounces = 0;
  const n = Math.ceil(tMax / DT);
  out.bounce1 = null; out.net = null;
  for (let i = 0; i < n; i++) {
    ev.length = 0;
    stepBall(s, surf, ev);
    t += DT;
    for (const e of ev) {
      if (e.type === 'bounce') { bounces++; if (bounces === 1) out.bounce1 = { x: e.x, z: e.z, t }; }
      else if (e.type === 'net') out.net = e;
    }
    if (i % 2 === 0 || bounces >= 2) out.push({ t, x: s.p.x, y: s.p.y, z: s.p.z, vx: s.v.x, vy: s.v.y, vz: s.v.z, b: bounces });
    if (bounces >= 2 || s.rolling) break;
  }
  return out;
}

// Flight only (no collisions) until the ball first reaches the ground.
function simLanding(p0, v0, w0) {
  const s = { p: { ...p0 }, v: { ...v0 }, w: { ...w0 } };
  let t = 0, netMargin = Infinity, crossed = false;
  for (let i = 0; i < 1400; i++) {
    const x0 = s.p.x, y0 = s.p.y, z0 = s.p.z;
    flight(s); t += DT;
    if (!crossed && z0 !== 0 && (z0 > 0) !== (s.p.z > 0)) {
      crossed = true;
      const f = z0 / (z0 - s.p.z);
      netMargin = y0 + (s.p.y - y0) * f - BALL_R - netHeight(x0 + (s.p.x - x0) * f);
    }
    if (s.p.y <= BALL_R && s.v.y < 0) {
      const f = (y0 - BALL_R) / (y0 - s.p.y);
      return { x: x0 + (s.p.x - x0) * f, z: z0 + (s.p.z - z0) * f, t, netMargin, crossed };
    }
  }
  return { x: s.p.x, z: s.p.z, t, netMargin, crossed };
}

// Launch velocity that lands the ball at (tx, tz) at roughly `speed` m/s with `spin` rad/s of topspin
// (negative = backspin). Takes the low trajectory, and slows the ball down if it would not clear the net.
function solveShot(p0, tx, tz, speed, spin, opt = {}) {
  const dx = tx - p0.x, dz = tz - p0.z, D = Math.hypot(dx, dz) || 1;
  const hx = dx / D, hz = dz / D;
  const w = { x: hz * spin, y: 0, z: -hx * spin };
  const minNet = opt.minNet ?? 0.1, lo0 = opt.lo ?? -0.4, hi0 = opt.hi ?? 0.62;
  const dist = (th, sp) => {
    const c = Math.cos(th), sn = Math.sin(th);
    const r = simLanding(p0, { x: hx * c * sp, y: sn * sp, z: hz * c * sp }, w);
    r.d = (r.x - p0.x) * hx + (r.z - p0.z) * hz;
    return r;
  };
  let sp = speed, best = null;
  for (let iter = 0; iter < 16; iter++) {
    if (dist(hi0, sp).d < D) { sp *= 1.1; continue; }
    if (dist(lo0, sp).d > D) { sp *= 0.88; continue; }
    let lo = lo0, hi = hi0;
    for (let k = 0; k < 16; k++) { const m = (lo + hi) / 2; if (dist(m, sp).d < D) lo = m; else hi = m; }
    const th = (lo + hi) / 2, r = dist(th, sp);
    best = { th, sp, r };
    if (r.crossed && r.netMargin < minNet && sp > 9) { sp *= 0.94; continue; }
    break;
  }
  if (!best) best = { th: 0.2, sp, r: { netMargin: 0, t: 1 } };
  const c = Math.cos(best.th), sn = Math.sin(best.th);
  return { v: { x: hx * c * best.sp, y: sn * best.sp, z: hz * c * best.sp }, w, speed: best.sp, theta: best.th, flightT: best.r.t, netMargin: best.r.netMargin };
}

// Time to cover d metres from a standstill with accel/decel limits.
function travelTime(d, vmax, acc) {
  const dAcc = (vmax * vmax) / acc;
  return d < dAcc ? 2 * Math.sqrt(d / acc) : (2 * vmax) / acc + (d - dAcc) / vmax;
}

// Game clock in seconds. Online guests add an offset so both machines share the host's clock.
const Clock = {
  offset: 0, pausedAt: 0, pausedTotal: 0, paused: false,
  perf() { return performance.now() / 1000; },
  now() { return (this.paused ? this.pausedAt : this.perf()) - this.pausedTotal + this.offset; },
  fromPerf(t) { return t - this.pausedTotal + this.offset; },
  pause() { if (!this.paused) { this.paused = true; this.pausedAt = this.perf(); } },
  resume() { if (this.paused) { this.pausedTotal += this.perf() - this.pausedAt; this.paused = false; } },
};

const Settings = {
  name: 'Player', control: 'mouse', handed: 'R', surface: 'hard', format: 'short', level: 'club',
  voice: true, assist: true, replays: true, sens: 1, latency: 0.09, paddle: null, cam: 'player', gfx: 'auto', showFps: false, phoneCode: '', tod: 'day',
  playAs: 'custom', opponent: 'random',   // pros.js ids: who you play as, and the CPU ('random' pro, or 'custom' for the club player)
  sfxVol: 1, crowdVol: 1, voiceVol: 1, timingMeter: true, reduceMotion: false, bigHud: false, cbSafe: false,   // Settings screen (options.js)
  load() { try { Object.assign(this, JSON.parse(localStorage.getItem('palmcourt.v1') || '{}')); } catch (e) { /* storage blocked */ } },
  save() {
    try {
      const data = {};
      for (const k of Object.keys(this)) if (typeof this[k] !== 'function') data[k] = this[k];
      localStorage.setItem('palmcourt.v1', JSON.stringify(data));
    } catch (e) { /* storage blocked */ }
  },
};
Settings.load();

export { clamp, lerp, sstep, damp, rand, pick, gauss, RPM, COURT, LINE_TOL, BALL_R, BALL_M, K_AIR, CD, GRAV, DT, SURFACES, FORMATS, LEVELS, netHeight, inCourt, inServiceBox, newBall, copyBall, flight, walls, stepBall, predictPath, simLanding, solveShot, travelTime, Clock, Settings };
