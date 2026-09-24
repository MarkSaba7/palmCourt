import { clamp, lerp, sstep, damp, rand, pick, gauss, RPM, DT, BALL_R, SURFACES, LEVELS, inCourt, inServiceBox, newBall, stepBall, predictPath, solveShot, travelTime, Clock, Settings } from './core.js';
import { PT_SHOW, Match, Sound } from './match.js';
import { camera, Crowd, World } from './render/world.js';
import { KITS, OUTFITS, Avatar, BallView, Cam } from './render/actors.js';
import { Input, swingPower, swingSpin, TOSS_LINE } from './input.js';
import { Net } from './net.js';
import { Phone } from './phone.js';
import { UI } from './ui.js';
import { Replay, lineMargin } from './replay.js';
import { judgeCameraSwing, strokeDir } from './camswing.js';
import { Bus } from './events.js';

// =====================================================================
// GAME: players, CPU, serve and rally flow, line calls
// =====================================================================
const BOUNCE_T = 0.62;   // one pre-serve bounce, hand to court and back

function rotateElevation(v, dth) {
  const h = Math.hypot(v.x, v.z), s = Math.hypot(h, v.y);
  if (h < 1e-6 || !dth) return;
  const th = Math.atan2(v.y, h) + dth, nh = s * Math.cos(th);
  v.y = s * Math.sin(th); v.x *= nh / h; v.z *= nh / h;
}

function makePlayer(idx) {
  const side = idx === 0 ? 1 : -1;
  return {
    idx, side, ctl: 'cpu', handed: 'R', name: '', level: LEVELS.club,
    x: 0, z: side * 12, vx: 0, vz: 0, tx: 0, tz: side * 12, maxSpeed: 6, acc: 13, react: 0,
    plan: null, path: null, chase: null, moveAfter: 0, hitFor: -1, cpuServeAt: 0, net: null,
    avatar: new Avatar(KITS[idx]),
  };
}

const Game = {
  mode: 'idle', state: 'idle', match: null, localIdx: -1, names: ['', ''], cfg: null,
  players: [],
  ball: Object.assign(newBall(), { simT: 0, active: false, visible: false, lastHitter: -1, bounces: 0, serve: null, netTouched: false, hitT: 0, rally: 0 }),
  hist: [], bounceLog: [], pending: null, ev: [], deadUntil: 0, deadKind: '', tossT: 0, serveReadyAt: 0, stTimer: 0, markerA: 0,

  me() { return this.localIdx >= 0 ? this.players[this.localIdx] : null; },
  inPlay() { return (this.mode === 'cpu' || this.mode === 'online') && !Clock.paused && this.state !== 'over' && this.state !== 'idle'; },
  isReferee() { return this.mode !== 'online' || this.ball.lastHitter !== this.localIdx; },
  isServerLocal() { return this.players[this.match.currentServer].ctl !== 'remote'; },
  camDist(p) { return Math.hypot(p.x - camera.position.x, p.y - camera.position.y, p.z - camera.position.z); },

  startMatch(cfg) {
    this.mode = cfg.mode; this.localIdx = cfg.localIdx; this.names = cfg.names.slice(); this.cfg = cfg;
    World.setSurface(cfg.surface);
    BallView.clearMarks();
    Replay.cancel(); Sound.hush();   // quitting mid-replay or mid-call must not carry the old match over
    this.match = new Match(cfg.format, cfg.first);
    this.players.forEach((pl, i) => {
      pl.ctl = cfg.ctl[i]; pl.handed = cfg.handed[i]; pl.name = cfg.names[i]; pl.avatar.setHanded(pl.handed);
      pl.level = LEVELS[cfg.level] || LEVELS.club;
      const cpu = pl.ctl === 'cpu';
      pl.maxSpeed = cpu ? pl.level.speed : 6.0; pl.acc = cpu ? pl.level.acc : 8.8; pl.react = cpu ? pl.level.react : 0.04;
      pl.net = null;
    });
    // The opponent turns up in a different outfit each match (online games keep the standard kits both sides see).
    if (cfg.mode !== 'online') {
      const mine = this.players[0].avatar.kit.shirt;
      this.players[1].avatar.setKit(pick(OUTFITS.filter((o) => o.shirt !== mine)));
    }
    Cam.mode = this.localIdx >= 0 ? 'play' : 'orbit';
    this.startPoint();
    if (this.localIdx >= 0) { Cam.snap(this.me()); Phone.send({ type: 'resync' }); }
    Bus.emit('match:start', { cfg });
  },
  startAttract() {
    this.startMatch({ mode: 'attract', localIdx: -1, names: ['Vega', 'Okafor'], handed: ['R', 'L'], ctl: ['cpu', 'cpu'], surface: Settings.surface, format: 'full', first: 0, level: 'pro' });
  },

  startPoint() {
    const m = this.match, srv = m.currentServer, court = m.court, S = this.players[srv], R = this.players[1 - srv], now = Clock.now();
    this.state = 'serve'; this.serveReadyAt = now + 0.6; this.tossQueued = false;
    S.x = S.side * (court === 'deuce' ? 0.8 : -0.8); S.z = S.side * 12.25;
    R.x = R.side * (court === 'deuce' ? 2.6 : -2.6); R.z = R.side * 12.8;
    if (R.ctl === 'cpu') this.cpuReceive(R, S, court);
    for (const p of this.players) {
      p.vx = p.vz = 0; p.tx = p.x; p.tz = p.z; p.plan = null; p.path = null; p.hitFor = -1;
      p.avatar.idle(false); p.avatar.prep = 0;
    }
    S.avatar.idle(true);
    // The server bounces the ball before serving: the CPU always, a human only if they take their time.
    this.bounceN = this.mode === 'online' ? 0 : S.ctl === 'cpu' ? pick([2, 2, 3]) : 2;
    this.bounceT0 = now + (S.ctl === 'cpu' ? 0.45 : 1.3);
    this.bouncePhase = -1;
    S.cpuServeAt = this.bounceT0 + this.bounceN * BOUNCE_T + rand(0.3, 0.7);
    const b = this.ball;
    b.active = false; b.visible = true; b.lastHitter = -1; b.serve = null; b.bounces = 0; b.rally = 0; b.netTouched = false; b.rolling = false; b.netDone = false;
    this.holdBall(S);
    this.pending = null; this.hist.length = 0; this.bounceLog.length = 0;
    Replay.reset();
    UI.updateScore();
  },
  // Pre-serve bounce: the ball drops from the hand, is fastest as it meets the court, and slows as it comes back
  // up into the hand. Returns true while a bounce is in progress.
  serveBall(S, now) {
    this.holdBall(S);
    const k = (now - this.bounceT0) / BOUNCE_T;
    if (!(k >= 0 && k < this.bounceN)) return false;
    const b = this.ball, u = k % 1, s = Math.abs(2 * u - 1), ground = BALL_R, H = b.p.y - ground;
    b.p.y = ground + H * (1 - (1 - s) * (1 - s));
    const half = Math.floor(k * 2);
    if (half !== this.bouncePhase) {
      if (half % 2 === 1 && this.mode !== 'attract') Sound.bounce(3.5, this.camDist(b.p), World.surface);
      this.bouncePhase = half;
    }
    return true;
  },
  bouncing(now) { const k = (now - this.bounceT0) / BOUNCE_T; return k >= 0 && k < this.bounceN; },
  holdBall(S) {
    const b = this.ball, hs = S.handed === 'R' ? 1 : -1;
    b.p = { x: S.x - S.side * 0.28 * hs, y: 0.95, z: S.z - S.side * 0.3 };
    b.v = { x: 0, y: 0, z: 0 }; b.w = { x: 0, y: 0, z: 0 };
  },

  update(dt) {
    if (this.mode === 'idle') return;
    const now = Clock.now();
    if (!Clock.paused) {
      for (const pl of this.players) this.updatePlayer(pl, dt, now);
      this.updateBall(now);
      this.updateState(now);
      if (this.mode === 'online') this.sendState(now);
    }
    for (const pl of this.players) pl.avatar.update(Clock.paused ? 0 : dt, now, pl);
    if (this.state === 'serve') this.serveBall(this.players[this.match.currentServer], now);
    BallView.update(this.shownBall(Clock.paused ? 0 : dt), this.ball.visible, dt);
    this.updateMarker(now, dt);
  },

  updatePlayer(pl, dt, now) {
    if (pl.ctl === 'remote') return this.updateRemote(pl, dt);
    if (pl.ctl === 'cpu') this.cpuThink(pl, now); else this.humanThink(pl, now);
    if (this.state === 'serve' || this.state === 'toss') { pl.vx = pl.vz = 0; return; }
    if (this.state === 'dead' || this.state === 'over') {
      const k = Math.exp(-6 * dt); pl.vx *= k; pl.vz *= k; pl.x += pl.vx * dt; pl.z += pl.vz * dt;
      return;
    }
    this.movePlayer(pl, dt, now);
  },
  movePlayer(pl, dt, now) {
    let tx = pl.tx, tz = pl.tz;
    if (now < pl.moveAfter) { tx = pl.x; tz = pl.z; }
    const dx = tx - pl.x, dz = tz - pl.z, d = Math.hypot(dx, dz);
    let wx = 0, wz = 0;
    if (d > 0.02) { const vs = Math.min(pl.maxSpeed, Math.sqrt(2 * pl.acc * d) * 0.95); wx = (dx / d) * vs; wz = (dz / d) * vs; }
    const ex = wx - pl.vx, ez = wz - pl.vz, em = Math.hypot(ex, ez), dv = pl.acc * 1.6 * dt;
    if (em > dv) { pl.vx += (ex / em) * dv; pl.vz += (ez / em) * dv; } else { pl.vx = wx; pl.vz = wz; }
    pl.x = clamp(pl.x + pl.vx * dt, -9.8, 9.8);
    pl.z += pl.vz * dt;
    pl.z = pl.side > 0 ? clamp(pl.z, 1.5, 19.5) : clamp(pl.z, -19.5, -1.5);
  },
  humanThink(pl, now) {
    const b = this.ball, plan = pl.plan;
    // A toss asked for during the short pause before a serve happens as soon as it's allowed.
    if (this.tossQueued && this.state === 'serve' && now >= this.serveReadyAt && !this.bouncing(now)) { this.tossQueued = false; if (this.match.currentServer === pl.idx) this.toss(pl); }
    // Camera: a hand still held above the toss line tosses as soon as the serve may start, so raising it while the
    // score is being called isn't lost. Each raise tosses once.
    if (Input.tossHeld && this.state === 'serve' && this.match.currentServer === pl.idx && now >= this.serveReadyAt && !this.bouncing(now) && !this.tossQueued) {
      if (Input.valid && Input.y < TOSS_LINE + 0.05) { Input.tossHeld = false; this.toss(pl); }
    }
    if (this.state === 'rally' && plan && b.lastHitter !== pl.idx && pl.hitFor !== b.rally) {
      pl.avatar.prepStroke = plan.stroke;
      // The racket goes back as the ball comes, and at once when a camera player takes theirs back (a wind-up).
      pl.avatar.prep = Math.max(clamp(1 - (plan.t - now - 0.22) / 0.5, 0, 1), now - (pl.windAt ?? -9) < 0.5 ? 1 : 0);
    } else pl.avatar.prep = Math.max(0, pl.avatar.prep - 0.08);
    pl.avatar.armLift = Settings.control !== 'mouse' && Input.valid ? (0.5 - Input.y) * 0.5 : 0;
  },
  cpuThink(pl, now) {
    const b = this.ball, m = this.match;
    this.cpuTune(pl);
    if (this.state === 'serve') {
      const ai = this.cpuMind(pl); ai.mode = 'base'; ai.leave = false;
      if (m.currentServer === pl.idx && now > pl.cpuServeAt && now > this.serveReadyAt) this.toss(pl);
    } else if (this.state === 'toss') {
      if (m.currentServer === pl.idx && !this.pending && pl.hitFor !== -2) {
        pl.hitFor = -2;
        const t = this.tossT + clamp(0.66 + gauss() * 0.035 * pl.level.err, 0.42, 0.9);
        this.pending = { t, pl, kind: 'serve' };
        pl.avatar.serveHit(t);
      }
    } else if (this.state === 'rally') {
      const plan = pl.plan;
      if (plan && b.lastHitter !== pl.idx && pl.hitFor !== b.rally && !this.pending) {
        pl.avatar.prepStroke = plan.stroke;
        pl.avatar.prep = clamp(1 - (plan.t - now - 0.22) / 0.5, 0, 1);
        if (plan.t - now < 0.5) { pl.hitFor = b.rally; this.pending = { t: plan.t, pl, kind: 'ground' }; pl.avatar.swing(plan.stroke, plan.t); }
      } else if (!plan) { pl.avatar.prep = Math.max(0, pl.avatar.prep - 0.08); this.cpuPosition(pl, now); }
    }
  },
  // The CPU's personality: player.persona (0..1 per trait, 0.5 = neutral; missing traits or no persona = neutral).
  cpuStyle(pl) {
    const p = pl.persona;
    if (pl.styleOf === p && pl.style) return pl.style;
    const s = { aggression: 0.5, topspin: 0.5, slice: 0.5, drop: 0.5, net: 0.5, serve: 0.5, consistency: 0.5, defense: 0.5, speed: 0.5 };
    if (p) for (const k in s) if (Number.isFinite(p[k])) s[k] = clamp(p[k], 0, 1);
    pl.styleOf = p; pl.style = s;
    return s;
  },
  // Tactical state: 'base' (baseline) or 'net', where it aimed last, whether it is letting a ball go, recent serves.
  cpuMind(pl) { return pl.ai || (pl.ai = { mode: 'base', aim: null, leave: false, serves: [], snv: false }); },
  // Legs from the level, scaled by persona.speed (startMatch resets maxSpeed, which triggers a retune).
  cpuTune(pl) {
    if (pl.maxSpeed === pl.tunedSpeed && pl.tunedFor === pl.persona && pl.tunedLevel === pl.level) return;
    const L = pl.level, k = this.cpuStyle(pl).speed - 0.5;
    pl.maxSpeed = L.speed * (1 + 0.16 * k); pl.acc = L.acc * (1 + 0.2 * k); pl.react = L.react * (1 - 0.3 * k);
    pl.tunedSpeed = pl.maxSpeed; pl.tunedFor = pl.persona; pl.tunedLevel = L;
  },
  // Reaction to a new ball: a little variable, and slower when caught moving the wrong way.
  cpuReact(pl) {
    const plan = pl.plan;
    let r = pl.react * rand(0.8, 1.3);
    if (plan) {
      const dx = plan.bx - pl.x, dz = plan.bz - pl.z, d = Math.hypot(dx, dz) || 1, along = (pl.vx * dx + pl.vz * dz) / d;
      if (along < -0.5) r += 0.05 * Math.min(1.5, -along / 3);
    }
    return r;
  },
  // Between shots (no ball to play): recover to the spot that splits the opponent's angles, at the baseline or the
  // net, and split-step as they strike. A ball it won't reach it still chases; one landing clearly out it watches go.
  cpuPosition(pl, now) {
    const b = this.ball, ai = this.cpuMind(pl), S = this.cpuStyle(pl), opp = this.players[1 - pl.idx];
    if (b.lastHitter < 0) return;
    if (b.lastHitter !== pl.idx) {
      const b1 = pl.path && pl.path.bounce1;
      if (ai.leave || !b1 || (b1.z > 0 ? 1 : -1) !== pl.side) { pl.tx = pl.x; pl.tz = pl.z; return; }
      const vh = Math.hypot(b.v.x, b.v.z) || 1;
      pl.tx = clamp(b1.x + (b.v.x / vh) * 1.5, -9, 9); pl.tz = b1.z + (b.v.z / vh) * 1.5;
      return;
    }
    const op = opp.plan, tHit = this.pending && this.pending.pl === opp ? this.pending.t : op ? op.t : null;
    if (tHit != null && tHit - now < 0.12 && Math.hypot(pl.x - pl.tx, pl.z - pl.tz) < 1.5) { pl.tx = pl.x; pl.tz = pl.z; return; }
    const net = ai.mode === 'net';
    const zc = pl.side * (net ? lerp(4.4, 2.6, S.net) : 12.2 + 1.3 * (S.defense - 0.5) - 0.8 * (S.aggression - 0.5));
    // The opponent's contact point: where they will play our ball, else where we aimed it.
    const ox = op ? op.x : ai.aim ? ai.aim.x : opp.x, oz = op ? op.z : ai.aim ? ai.aim.z : opp.z;
    // Bisect the angle between the two sidelines as seen from there.
    const W = 4.115, ux = -W - ox, vx = W - ox, dz = zc - oz, l1 = Math.hypot(ux, dz), l2 = Math.hypot(vx, dz);
    const bx = ox + ((ux / l1 + vx / l2) / (dz / l1 + dz / l2)) * dz;
    pl.tx = clamp(bx, net ? -2.8 : -2.3, net ? 2.8 : 2.3); pl.tz = zc;
  },
  // Where the CPU waits for a serve: splitting the server's wide and T serves, further back against first serves
  // (defenders further still, attackers closer; everyone steps in for a second serve).
  cpuReceive(R, srv, court) {
    const S = this.cpuStyle(R), first = this.match.serveNo === 1, bs = court === 'deuce' ? R.side : -R.side;
    const d = first ? 12.7 + 1.6 * (S.defense - 0.5) - 0.9 * (S.aggression - 0.5) : 11.9 + 1.0 * (S.defense - 0.5) - 1.0 * (S.aggression - 0.5);
    const zr = R.side * clamp(d, 11.2, 14.2), k = (zr - srv.z) / (R.side * 5.6 - srv.z);
    const xw = srv.x + (bs * 3.75 - srv.x) * k, xt = srv.x + (bs * 0.3 - srv.x) * k;
    R.x = clamp((xw + xt) / 2, -3.8, 3.8); R.z = zr;
  },

  updateBall(now) {
    const b = this.ball;
    if (!b.active) return;
    if (now - b.simT > 2) b.simT = now - 2;
    const surf = SURFACES[World.surface];
    let n = 0;
    while (b.simT + DT <= now && n++ < 600) {
      if (this.pending && this.pending.t <= b.simT + DT * 0.5) { const pc = this.pending; this.pending = null; this.contact(pc); continue; }
      this.hist.push({ t: b.simT, p: { ...b.p }, v: { ...b.v }, w: { ...b.w }, netDone: b.netDone, rolling: b.rolling, bounces: b.bounces, netTouched: b.netTouched });
      if (this.hist.length > 150) this.hist.shift();
      const ev = this.ev; ev.length = 0;
      stepBall(b, surf, ev);
      b.simT += DT;
      for (const e of ev) this.onBallEvent(e);
    }
  },
  rollback(t) {
    const h = this.hist, b = this.ball;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].t <= t + 1e-9) {
        const s = h[i], V = this.view, before = b.simT;
        b.p = { ...s.p }; b.v = { ...s.v }; b.w = { ...s.w }; b.netDone = s.netDone; b.rolling = s.rolling; b.bounces = s.bounces; b.netTouched = s.netTouched; b.simT = s.t;
        h.length = i;
        // The view replays the new flight from here instead of jumping to where it has got to by now.
        while (V.ring.length && V.ring[V.ring.length - 1].t > s.t) V.ring.pop();
        V.ring.push({ t: s.t, x: s.p.x, y: s.p.y, z: s.p.z });
        V.lag = Math.min(0.3, Math.max(V.lag, before - s.t));
        if (V.shown) V.from = { ...V.shown };
        return true;
      }
    }
    return false;
  },

  // ---- what the screen shows of the ball ----
  // A rollback rewinds the ball to the contact. Rather than jumping, the view replays the new flight from the
  // contact a little faster than real time until it has caught up, easing out what's left of the gap. With camera
  // or phone controls, whose swings reach the game a tenth of a second or so after the real ones, the ball on
  // screen also slows as it reaches the racket, so there is less to make up. Only the view: physics and timing
  // judgement are untouched (and replays show the real flight).
  view: { lag: 0, ring: [], from: null, off: null, shown: null, out: { p: { x: 0, y: 0, z: 0 }, v: null, w: null } },
  shownBall(dt) {
    const b = this.ball, V = this.view, R = V.ring;
    if (!b.active) { R.length = 0; V.lag = 0; V.from = V.off = V.shown = null; return b; }
    const last = R[R.length - 1];
    if (last && b.simT < last.t - 1e-6) { R.length = 0; V.lag = 0; if (V.shown) V.from = { ...V.shown }; }   // set back by something else (an online hit)
    if (!R.length || b.simT > R[R.length - 1].t + 1e-6) R.push({ t: b.simT, x: b.p.x, y: b.p.y, z: b.p.z });
    while (R.length > 2 && R[1].t < b.simT - 0.45) R.shift();
    const me = this.me(), plan = me && me.plan, ctl = Settings.control;
    const wait = (ctl === 'hand' || ctl === 'paddle' || ctl === 'phone') && me && me.ctl === 'human' && this.state === 'rally' && plan && b.lastHitter >= 0 &&
      b.lastHitter !== me.idx && me.hitFor !== b.rally && !this.pending && b.simT > plan.t && b.simT < plan.t + 0.25;
    V.lag = wait ? Math.min(0.1, V.lag + dt * 0.7) : Math.max(0, V.lag - dt * (0.7 + 2 * V.lag));
    const t = b.simT - V.lag, o = V.out.p;
    let i = R.length - 1;
    while (i > 0 && R[i - 1].t >= t) i--;
    const A = R[Math.max(0, i - 1)], B = R[i], k = B.t > A.t ? clamp((t - A.t) / (B.t - A.t), 0, 1) : 1;
    o.x = A.x + (B.x - A.x) * k; o.y = A.y + (B.y - A.y) * k; o.z = A.z + (B.z - A.z) * k;
    if (V.from) { V.off = { x: V.from.x - o.x, y: V.from.y - o.y, z: V.from.z - o.z }; V.from = null; }
    if (V.off) {
      const f = V.off, e = Math.exp(-dt / 0.05);
      f.x *= e; f.y *= e; f.z *= e;
      o.x += f.x; o.y += f.y; o.z += f.z;
      if (Math.abs(f.x) + Math.abs(f.y) + Math.abs(f.z) < 0.01) V.off = null;
    }
    o.y = Math.max(o.y, BALL_R);
    V.out.v = b.v; V.out.w = b.w;
    V.shown = V.shown || { x: 0, y: 0, z: 0 };
    V.shown.x = o.x; V.shown.y = o.y; V.shown.z = o.z;
    return V.out;
  },

  onBallEvent(e) {
    const b = this.ball, loud = this.mode !== 'attract';
    if (e.type === 'bounce') {
      if (loud) Sound.bounce(e.vin, this.camDist(b.p), World.surface);
      if (e.vin > 2) BallView.mark(e.x, e.z, b.v.x, b.v.z);
      this.bounceLog.push({ x: e.x, z: e.z, t: b.simT, vx: b.v.x, vz: b.v.z });
    } else if (e.type === 'net') {
      if (loud) Sound.net(e, this.camDist(b.p));
      b.netTouched = true;
      World.netHit(e.x, e.y, Clock.now(), Math.sign(b.v.z || 1));
    }
    if (this.state === 'toss') { if (e.type === 'bounce' && this.isServerLocal()) this.retoss(); return; }
    if (this.state !== 'rally') return;
    if (e.type === 'net') { this.replanAll(); return; }
    if (!this.isReferee()) return;
    b.bounces++;
    const hitter = b.lastHitter, recv = 1 - hitter, rSide = this.players[recv].side, half = e.z >= 0 ? 1 : -1;
    if (b.bounces === 1) {
      if (half !== rSide) return b.serve ? this.fault('net') : this.pointOver(recv, 'net');
      if (b.serve) {
        if (!inServiceBox(e.x, e.z, rSide, b.serve.court)) return this.fault(b.netTouched ? 'net' : 'out');
        if (b.netTouched) return this.letCall();
      } else if (!inCourt(e.x, e.z)) return this.pointOver(recv, 'out');
    } else this.pointOver(hitter, b.serve ? 'ace' : 'winner');
  },

  toss(pl) {
    const now = Clock.now();
    if (this.state !== 'serve' || this.match.currentServer !== pl.idx || now < this.serveReadyAt) return;
    if (this.bouncing(now)) {   // finish this bounce first, then toss straight away
      this.bounceN = Math.floor((now - this.bounceT0) / BOUNCE_T) + 1;
      this.tossQueued = true;
      return;
    }
    const b = this.ball, hs = pl.handed === 'R' ? 1 : -1;
    b.p = { x: pl.x + pl.side * 0.14 * hs, y: 1.5, z: pl.z - pl.side * 0.42 };
    b.v = { x: 0, y: 5.45, z: 0 }; b.w = { x: 0, y: 0, z: 0 }; b.netDone = false; b.rolling = false;
    b.simT = now; b.active = true; b.visible = true;
    this.hist.length = 0; this.bounceLog.length = 0;
    this.state = 'toss'; this.tossT = now; pl.hitFor = -1;
    pl.avatar.serveToss(now);
    Crowd.flashBurst(3 + (Math.random() * 4 | 0), 0.9);   // photographers catch the serve
    if (pl.ctl === 'human') { Input.swing = null; Input.lastEnd = -9; }
    if (this.mode === 'online') Net.send({ type: 'toss', t: now, p: b.p, v: b.v });
    UI.prompt();
  },
  retoss() {
    const S = this.players[this.match.currentServer];
    this.state = 'serve'; this.serveReadyAt = Clock.now() + 0.5; this.pending = null; this.bounceN = 0;
    this.ball.active = false; this.holdBall(S);
    S.avatar.idle(true); S.hitFor = -1; S.cpuServeAt = Clock.now() + rand(0.8, 1.4);
    if (this.mode === 'online' && S.ctl !== 'remote') Net.send({ type: 'retoss' });
    UI.prompt();
  },
  updateState(now) {
    const b = this.ball;
    if (this.state === 'toss' && this.isServerLocal() && !this.pending && b.v.y < 0 && b.p.y < 1.3) this.retoss();
    else if (this.state === 'rally' && this.isReferee() && b.simT - b.hitT > 8) this.pointOver(b.lastHitter, 'winner');
    else if (this.state === 'dead' && now >= this.deadUntil && !Replay.busy()) { if (this.match.over) this.finish(); else this.startPoint(); }
  },

  // ---- the local player's swings ----
  onInput(ev) {
    const cam = !!ev.swing && (ev.swing.src === 'hand' || ev.swing.src === 'paddle');
    if (Replay.active) {
      // Swinging skips a replay; a camera swing only once it has run a moment, not the arm settling after the point.
      if (ev.type === 'toss' || (ev.type === 'swing' && (!cam || Clock.now() - Replay.lastAt > 0.6))) Replay.skip();
      return;
    }
    if (!this.inPlay()) return;
    const me = this.me();
    if (!me || me.ctl !== 'human') return;
    const m = this.match, b = this.ball, now = Clock.now();
    if (ev.type === 'toss') {
      if (this.state === 'serve' && m.currentServer === me.idx) { Input.tossHeld = false; if (now < this.serveReadyAt) this.tossQueued = true; else this.toss(me); }
      return;
    }
    if (ev.type === 'swingStart') { this.swingStart(me, ev, now); return; }
    if (ev.type !== 'swing') return;
    Sound.init();
    const sw = ev.swing, camSrc = cam;
    sw.tEff = sw.t0 - (camSrc ? Settings.latency : sw.src === 'phone' ? 0.012 : 0.02);
    if (m.currentServer === me.idx && this.state === 'serve') {
      if (sw.src === 'phone') UI.timing('Tap your phone to toss');
      else if (!camSrc) { if (now < this.serveReadyAt) this.tossQueued = true; else this.toss(me); }
      else if (now - this.tossT < 1.4 && sw.vy > 0) UI.timing('Too late');   // a swing at a toss that has just dropped
      return;
    }
    if (m.currentServer === me.idx && this.state === 'toss') return this.humanServe(me, sw, now);
    const plan = me.plan;
    // When the racket meets the ball on screen for a swing that isn't a hit. Camera and phone swings arrive around
    // their peak, which is the contact, so at once; a click or key press starts a swing.
    const swingT = camSrc || sw.src === 'phone' ? Math.max(now, sw.tEff) : Math.max(now, sw.tEff + 0.17);
    // Camera: the arm coming back after a swing (the other way, soon after) is not a swing of its own.
    const back = camSrc && this.armReturn(me, sw, now);
    const busy = camSrc && (back || (me.avatar.mode === 'swing' && now < me.avatar.contactT + 0.45));
    if (this.state !== 'rally' || !plan || b.lastHitter === me.idx || b.lastHitter < 0 || me.hitFor === b.rally) {
      // (Between points a camera swing is mostly the arm relaxing: leave the player's reaction be.)
      if (this.state !== 'toss' && !busy && !(camSrc && this.state === 'dead')) {
        const t = camSrc ? swingT : now + 0.12;
        this.animSwing(me, plan ? plan.stroke : sw.dir || 'fh', t, sw); this.sendSwing(me, t);
      }
      return;
    }
    const dt = sw.tEff - plan.t;
    const dir = sw.dir || this.cameraSwingDir(sw, me);
    sw.mismatch = !!dir && dir !== plan.stroke;
    if (camSrc) {
      // Camera: taking the racket back (a swing the other way, or one we can't read, before the ball arrives) is not
      // a hit attempt, and a swing that's too early doesn't use up the shot, so the real swing still counts. Near the
      // ball any swing hits the stroke the ball needs.
      const j = judgeCameraSwing(dt, dir, plan.stroke);
      if (j === 'ignore' || j === 'windup') { if (dir !== plan.stroke) me.windAt = now; return; }   // the racket goes back too
      if (j === 'early') {
        if (!busy) this.animSwing(me, plan.stroke, swingT, sw);
        UI.timing('Too early');
        return;
      }
      if (j === 'late' && back) return;   // the arm coming back from an early swing isn't a late one
      me.hitFor = b.rally;
      if (j === 'late') {
        this.animSwing(me, plan.stroke, swingT, sw); this.sendSwing(me, swingT);
        UI.timing('Too late');
        return;
      }
    } else {
      // A swing the other way well before the ball arrives is the wind-up (taking the racket back): not a hit attempt.
      if (dt < -0.45 || (sw.mismatch && dt < -0.1)) return;
      me.hitFor = b.rally;
      if (dt < -0.3 || dt > 0.2) {
        this.animSwing(me, plan.stroke, swingT, sw); this.sendSwing(me, swingT);
        UI.timing(dt < 0 ? 'Too early' : 'Too late');
        return;
      }
    }
    const tc = plan.t + clamp(0.3 * dt, -0.05, 0.04);
    // A camera swing is usually heard after the ball has reached the racket: the racket swings through at once and
    // the ball is rewound to the moment of the real swing (see rollback and shownBall).
    this.animSwing(me, plan.stroke, Math.max(tc, now), sw);
    if (tc >= b.simT) this.pending = { t: tc, pl: me, kind: 'ground', swing: sw };
    else if (this.rollback(tc)) this.contact({ pl: me, kind: 'ground', swing: sw });
    else UI.timing('Too late');   // further back than the ball's history goes
  },
  humanServe(me, sw, now) {
    const b = this.ball, cam = sw.src === 'hand' || sw.src === 'paddle';
    if (me.hitFor === -3) return;
    const ts = sw.tEff - this.tossT;
    // Too soon after the toss to be the serve: say so (a camera swing upward is just the tossing arm still rising).
    if (ts < 0.22) { if (!cam || sw.vy > 0) UI.timing('Too early'); return; }
    me.hitFor = -3;
    const tc = this.tossT + clamp(ts, 0.3, 0.98);
    me.avatar.serveHit(Math.max(tc, now));
    if (cam) this.noteCamSwing(me, sw, now);
    const q = 1 - sstep(0.1, 0.38, Math.abs(ts - 0.68));
    const a = sw.src === 'key' || sw.src === 'phone' ? clamp(0.5 + gauss() * 0.25, 0, 1) : clamp((sw.x - 0.2) / 0.6, 0, 1);
    sw.serve = true;   // (power is learned separately for serves)
    const shot = { pl: me, kind: 'serve', swing: sw, serve: { power: swingPower(sw), a, q } };
    if (cam) Input.learn(sw);
    if (tc >= b.simT) this.pending = { ...shot, t: tc };
    else if (this.rollback(tc)) this.contact(shot);
    else UI.timing('Too late');
  },
  // Show a stroke whose racket meets the ball at time t. A swing already under way isn't wound back for a small
  // change (a racket jerking backwards looks worse than meeting the ball a few hundredths early).
  animSwing(pl, stroke, t, sw) {
    const a = pl.avatar, now = Clock.now();
    if (sw && (sw.src === 'hand' || sw.src === 'paddle')) this.noteCamSwing(pl, sw, now);
    if (a.mode === 'swing' && a.stroke === stroke && t > a.contactT && t - a.contactT < 0.12 && a.contactT > now - 0.1) return;
    a.swing(stroke, t);
  },
  // Is this camera swing the arm coming back from the last one that moved the racket (the other way, soon after)?
  armReturn(pl, sw, now) {
    const l = pl.lastCam, m = Math.hypot(sw.vx, sw.vy) || 1;
    return !!l && l.sw !== sw && now - l.t < 0.7 && (sw.vx * l.ux + sw.vy * l.uy) / m < -0.3;
  },
  noteCamSwing(pl, sw, now) { const m = Math.hypot(sw.vx, sw.vy) || 1; pl.lastCam = { sw, t: now, ux: sw.vx / m, uy: sw.vy / m }; },
  sendSwing(pl, t) { if (this.mode === 'online') Net.send({ type: 'sw', stroke: (pl.plan && pl.plan.stroke) || 'fh', t }); },
  // Direction of a camera swing: in the mirrored image a right-hander's forehand sweeps right to left.
  // (Camera swings normally arrive with dir already set by the detector; this is the fallback.)
  cameraSwingDir(sw, pl) {
    if (sw.src !== 'hand' && sw.src !== 'paddle') return null;
    return strokeDir(sw.vx, sw.vy, pl.handed);
  },
  // The phone reports the start of a swing before its peak: start the animation now so it feels instant.
  swingStart(me, ev, now) {
    const plan = me.plan, b = this.ball;
    if (this.state !== 'rally' || !plan || b.lastHitter === me.idx || b.lastHitter < 0 || me.hitFor === b.rally) return;
    if (ev.t0 - plan.t < -0.5 || me.avatar.mode === 'swing') return;
    if (ev.dir && ev.dir !== plan.stroke) { me.windAt = now; return; }   // turning the other way: that's the wind-up
    me.avatar.swing(plan.stroke, Math.max(now + 0.08, plan.t));
  },

  // ---- contact and shot making ----
  contact(pc) {
    const pl = pc.pl, b = this.ball, m = this.match;
    if (pc.kind === 'serve') {
      if (this.state !== 'toss' || m.currentServer !== pl.idx || b.p.y < 1.9) return;
      const shot = this.serveShot(pl, pc.serve || this.cpuServeParams(pl));
      this.applyHit(pl, shot, { serve: { no: m.serveNo, court: m.court } });
      return;
    }
    if (this.state !== 'rally' || b.lastHitter === pl.idx || (b.serve && b.bounces === 0)) return;
    const plan = pl.plan;
    if (!plan) return;
    const reach = Math.hypot(pl.x - plan.bx, pl.z - plan.bz);
    if (reach > 1.05 || b.p.y > 2.4 || b.p.y < 0.08) { if (pl.ctl === 'human') UI.timing('Missed'); return; }
    const shot = pl.ctl === 'cpu' ? this.cpuShot(pl, reach) : this.humanShot(pl, pc.swing, reach);
    this.applyHit(pl, shot, {});
  },
  // How hard the incoming ball is to play, 0..1: its pace at contact, how far the player had to run for it and how
  // little time they had. Hard balls cause more errors, and a person must time them more precisely.
  shotDifficulty(pl) {
    const b = this.ball, c = pl.chase || { run: 0, slack: 1 };
    const pace = sstep(9, 16, Math.hypot(b.v.x, b.v.y, b.v.z));
    return clamp(0.4 * pace + 0.45 * sstep(2.5, 6.5, c.run) + 0.35 * sstep(0.4, -0.2, c.slack), 0, 1);
  },
  humanShot(pl, sw, reach) {
    const plan = pl.plan, diff = this.shotDifficulty(pl), cam = sw.src === 'hand' || sw.src === 'paddle';
    // A camera swing's timing carries the tracker's jitter on top of the player's, so it gets a wider window. With the
    // assist on (the default), an off-time camera swing also keeps more control and aims further inside the lines.
    const assist = cam && Settings.assist;
    const tau = clamp((sw.tEff - plan.t) / ((cam ? (assist ? 0.19 : 0.16) : 0.14) * (1 - 0.5 * diff)), -1.8, 1.8);
    const stretch = sstep(0.45, 1.05, reach);
    // The wrong stroke costs some control; less on camera, where the stroke is read from the hand's path.
    let q = (1 - 0.25 * sstep(0.3, 1.0, Math.abs(tau)) - 0.75 * sstep(1.0, 1.6, Math.abs(tau))) * (1 - 0.45 * stretch) * (sw.mismatch ? (cam ? 0.85 : 0.7) : 1);
    if (assist) q = 0.35 + 0.65 * q;
    const hs = pl.handed === 'R' ? 1 : -1, ss = plan.stroke === 'fh' ? 1 : -1;
    const power = swingPower(sw);
    if (cam) Input.learn(sw);   // this player's usual swing speed, for the next swings' power
    return this.groundShot(pl, { power: power * (1 - 0.35 * stretch), spin: swingSpin(sw), aimX: clamp(tau, -1.15, 1.15) * ss * hs * (assist ? 2.6 : 3.3), q, tau, diff });
  },
  // The CPU's stroke: read the situation (how hard the ball is, where both players are), pick a shot the way a player
  // of its level and style would, and aim it with margins that fit its own consistency. Misses then come from pressure:
  // running, low or high balls, pace, and the risk it chose.
  cpuShot(pl, reach) {
    const L = pl.level, S = this.cpuStyle(pl), ai = this.cpuMind(pl), b = this.ball, opp = this.players[1 - pl.idx], plan = pl.plan;
    const W = 4.115, side = pl.side, iq = L.iq, volley = b.bounces === 0, y = b.p.y;
    // Hitting frame: +x is where groundShot's aimX > 0 lands. Our own spot, and where the opponent is heading.
    const mx = pl.x * side, md = Math.abs(pl.z);
    const ox = clamp((opp.x + opp.vx * 0.3) * side, -6, 6), od = Math.abs(opp.z + opp.vz * 0.3), bhX = opp.handed === 'R' ? 1 : -1;
    const diff = this.shotDifficulty(pl), stretch = sstep(0.3, 0.95, reach);
    const low = sstep(volley ? 0.8 : 0.7, 0.35, y), high = volley ? 0 : sstep(1.35, 1.9, y), hurry = sstep(0.25, -0.15, pl.chase ? pl.chase.slack : 1);
    const press = clamp(0.55 * diff + 0.5 * stretch + 0.3 * low + 0.25 * high + 0.3 * hurry, 0, 1);
    const q = clamp(1 - 0.45 * stretch - 0.2 * low - 0.15 * high - 0.2 * hurry, 0.35, 1);
    const errMul = L.err * lerp(1.3, 0.75, S.consistency);
    const short = sstep(11.3, 8.5, md) * (1 - press);
    const risk = clamp(0.32 + 0.55 * (S.aggression - 0.5) - 0.55 * press + 0.35 * short - 0.15 * (S.consistency - 0.5), 0, 1);
    // Margins from its own typical scatter: a precise player aims closer to the lines.
    const kx = lerp(2.3, 1.0, risk), kz = lerp(2.3, 1.15, risk);
    const wideAim = (p, k = kx) => W - clamp((0.4 + p * p) * errMul * 1.25 * k, 0.45, 2.6);
    const deepAim = (p, k = kz) => 11.885 - clamp((0.45 + 0.95 * p * p) * errMul * 1.25 * k, 0.9, 3.4);
    const drive = (t) => lerp(L.power[0], L.power[1], clamp(t, 0, 1));
    const open = Math.abs(ox) < 0.5 ? (Math.random() < 0.5 ? -1 : 1) : -Math.sign(ox);
    const cc = Math.abs(mx) < 0.6 ? open : -Math.sign(mx);   // crosscourt from where it stands
    let power = drive(0.25 + 0.5 * S.aggression + 0.3 * short + gauss() * 0.12) * (1 - 0.45 * press);
    let spin = clamp(lerp(0.15, 0.95, S.topspin) + gauss() * 0.15, -0.2, 1), aimX = 0, depth = null, lob = false, kind = null;
    let mode = md > 9 ? 'base' : ai.mode;
    if (volley) {
      mode = 'net';
      if (y > 1.7 && press < 0.7) {
        power = lerp(0.8, 1, S.aggression) * (1 - 0.3 * press); spin = 0.15; aimX = open * wideAim(power); depth = rand(7.5, 9.5); kind = 'Smash';
      } else if (od > 11 && y < 1.3 && Math.random() < (0.08 + 0.5 * Math.max(0, S.drop - 0.3)) * (1 - press)) {
        power = 0.1; spin = -0.85; aimX = open * rand(1.2, 2.6); depth = rand(2.3, 3.2); kind = 'Drop volley';
      } else {
        const angle = y > 1.0 && md < 5 && press < 0.4 && Math.random() < 0.35;
        power = (y > 1.0 ? rand(0.5, 0.75) : rand(0.3, 0.5)) * (1 - 0.35 * press); spin = -0.35;
        aimX = (press > 0.6 ? bhX : open) * wideAim(power) * (angle ? 1 : rand(0.6, 0.95)); depth = angle ? rand(5.2, 6.5) : deepAim(power); kind = 'Volley';
      }
    } else if (od < 7 && md > 6.5) {
      // The opponent is at the net: pass them, or lob them (more when stretched or when they crowd the net).
      const pLob = clamp(0.06 + 0.45 * press + 0.3 * sstep(5, 2.5, od) + 0.25 * (S.defense - 0.5) + 0.15 * (S.topspin - 0.5), 0.03, 0.8);
      if (Math.random() < pLob) {
        lob = true; power = 0.35; spin = press < 0.5 ? 0.5 + 0.35 * S.topspin : -0.35; kind = 'Lob';
        aimX = (Math.abs(ox) > 1 ? -Math.sign(ox) : bhX) * rand(0.8, 2.4); depth = deepAim(0.5, kz + 0.4);
      } else {
        let dir = W - ox > ox + W ? 1 : -1;
        if (Math.random() < 0.1 + 0.2 * (1 - iq)) dir = -dir;
        const dtl = Math.abs(mx) > 0.6 && Math.sign(mx) === dir;
        power = drive(0.55 + 0.35 * S.aggression) * (1 - 0.4 * press); spin = 0.55 + 0.4 * S.topspin; kind = 'Passing shot';
        aimX = dir * wideAim(power); depth = dtl ? deepAim(power) : rand(5.8, 7.5);
      }
    } else if (b.serve) {
      // Return: block a first serve back deep, crosscourt or through the middle; attack a second serve.
      const second = b.serve.no === 2, chip = Math.random() < 0.08 + 0.6 * Math.max(0, S.slice - 0.5) + 0.3 * stretch;
      power = drive(second ? 0.35 + 0.5 * S.aggression : 0.1 + 0.35 * S.aggression) * (1 - 0.4 * press);
      if (chip) { spin = rand(-0.6, -0.3); kind = 'Slice'; }
      const r = Math.random();
      aimX = (r < 0.55 ? cc : r < 0.8 ? bhX : open) * wideAim(power, kx + (second ? 0.2 : 0.6)) * rand(0.45, 0.95);
      depth = deepAim(power, kz + (second ? 0 : 0.3));
    } else if (press > 0.62) {
      // Defending: buy time with a deep crosscourt ball, high heavy topspin or a floated slice, well inside the lines.
      const sl = Math.random() < clamp(0.15 + 0.8 * (S.slice - 0.5) + 0.3 * low + (plan && plan.stroke === 'bh' ? 0.15 : 0), 0.05, 0.85);
      power = lerp(0.22, 0.5, 1 - press) * lerp(0.9, 1.15, S.aggression);
      spin = sl ? rand(-0.8, -0.45) : 0.55 + 0.35 * S.topspin; if (sl) kind = 'Slice';
      aimX = cc * wideAim(power, kx + 0.6) * rand(0.3, 0.8); depth = deepAim(power, kz + 0.5);
    } else if (short > 0.3 && y > 0.6) {
      // A short ball: drop shot (opponent deep), approach and come in (net players), or go for the open court.
      const dropP = od > 12.2 ? clamp(0.03 + 0.6 * Math.max(0, S.drop - 0.35), 0, 0.5) : 0;
      const netP = clamp(0.03 + 1.1 * Math.max(0, S.net - 0.3), 0, 0.85) * sstep(11, 8.5, md);
      const r = Math.random();
      if (r < dropP) { power = 0.1; spin = -0.85; aimX = open * rand(0.8, 2.4); depth = rand(2.4, 3.6); kind = 'Drop shot'; }
      else if (r < dropP + netP) {
        const sl = Math.random() < 0.15 + 0.9 * Math.max(0, S.slice - 0.4);
        power = sl ? rand(0.45, 0.6) : drive(0.65); spin = sl ? -0.5 : 0.35 + 0.3 * S.topspin; kind = 'Approach'; mode = 'net';
        aimX = (Math.abs(mx) > 0.8 && Math.random() < 0.7 ? Math.sign(mx) : bhX) * wideAim(power, kx + 0.2); depth = deepAim(power);
      } else {
        const angle = Math.abs(mx) > 1.5 && Math.random() < 0.35;
        power = drive(0.75 + 0.3 * S.aggression + 0.1 * gauss()); spin = lerp(0.05, 0.75, S.topspin);
        aimX = open * wideAim(power); depth = angle ? rand(6, 7.5) : deepAim(power);
      }
    } else {
      // Neutral rally: mostly crosscourt (safest from out wide, over the low middle of the net), sometimes down the line
      // or at the backhand, behind a player who is running, the odd slice and (for some) a surprise drop shot.
      const r = Math.random(), wide = Math.abs(mx) > 2.0, pDTL = (wide ? 0.1 : 0.22) + 0.25 * risk;
      let dir = r < pDTL ? Math.sign(mx) || open : r < pDTL + 0.25 * iq ? bhX : cc;
      if (Math.abs(opp.vx) > 3 && Math.random() < 0.25 * iq) dir = -Math.sign(opp.vx * side);
      const dtl = Math.abs(mx) > 0.6 && dir === Math.sign(mx);
      aimX = dir * wideAim(power, kx + (dtl ? 0.35 : 0)) * rand(0.7, 1); depth = deepAim(power);
      if (Math.random() < clamp(0.04 + 0.5 * (S.slice - 0.4) + (plan && plan.stroke === 'bh' ? 0.08 : -0.03) + 0.2 * low, 0, 0.6)) {
        spin = rand(-0.7, -0.35); power *= 0.85; kind = 'Slice'; depth = deepAim(power, kz + 0.3);
      } else if (od > 12.4 && md < 12.6 && Math.random() < 0.1 * Math.max(0, S.drop - 0.55) * (1 - press)) {
        power = 0.1; spin = -0.85; aimX = open * rand(0.8, 2.2); depth = rand(2.6, 3.6); kind = 'Drop shot';
      }
    }
    // A low-IQ player often just hits it back somewhere.
    if (!volley && !lob && power > 0.15 && Math.random() < 0.45 * (1 - iq)) { aimX = rand(-2.8, 2.8); depth = null; }
    ai.mode = mode;
    const shot = this.groundShot(pl, { power, spin, aimX, depth, lob, q, tau: 0, errMul, diff });
    if (kind) shot.kind = kind;
    ai.aim = { x: side * aimX, z: -side * (depth ?? 9) };
    return shot;
  },
  // Pick a landing spot from power/spin/aim, scatter it by the error model, then solve the physics for it.
  groundShot(pl, o) {
    const b = this.ball, from = { ...b.p };
    let depth = lerp(7.0, 10.5, 0.25 + 0.75 * o.power), vk = lerp(15.5, 35, Math.pow(o.power, 0.85)), kind = 'Drive';
    if (o.lob) { depth = 9.8; vk = 17; kind = 'Lob'; }
    else if (o.spin < -0.55 && o.power < 0.2) { depth = 3.4; vk = 11.5; kind = 'Drop shot'; }
    else if (o.spin < 0) { depth -= 0.8 * -o.spin; kind = 'Slice'; }
    else if (o.spin > 0.6) kind = 'Topspin';
    if (o.depth != null) depth = o.depth;   // the CPU picks its own length (angles, approaches)
    // Harder incoming balls are harder to control.
    const pressure = o.diff || 0;
    const errK = (1 + 1.6 * (1 - o.q)) * (1 + 1.2 * pressure) * (o.errMul || 1);
    const sx = (0.4 + 1.0 * o.power * o.power) * errK, sz = (0.45 + 0.95 * o.power * o.power) * errK;
    const xl = clamp(o.aimX, -3.6, 3.6) + gauss() * sx, dl = Math.max(1.2, depth + gauss() * sz);
    const speed = vk * (1 - 0.13 * Math.abs(o.spin)) * (0.55 + 0.45 * o.q);
    const rpm = o.spin >= 0 ? lerp(700, 3100, o.spin) : -lerp(500, 2300, -o.spin);
    const sol = solveShot(from, pl.side * xl, -pl.side * dl, speed, rpm * RPM, o.lob ? { minNet: 0.12, lo: 0.45, hi: 0.8 } : { minNet: 0.12 });
    rotateElevation(sol.v, gauss() * (0.005 + 0.006 * o.power + 0.03 * (1 - o.q)) * (1 + 0.6 * pressure) * (o.errMul || 1));
    return { sol, rpm, kind, tau: o.tau, q: o.q, power: o.power, aim: o.aimX };
  },
  cpuServeParams(pl) {
    const L = pl.level, first = this.match.serveNo === 1;
    return { power: first ? rand(L.serve[0], L.serve[1]) : rand(0.3, 0.52), a: clamp(pick([0.06, 0.5, 0.94]) + gauss() * 0.07, 0, 1), q: 0.93, errMul: L.err * (first ? 1 : 0.65) };
  },
  serveShot(pl, o) {
    const b = this.ball, m = this.match, second = m.serveNo === 2;
    const a = clamp(o.a, 0, 1), xl = m.court === 'deuce' ? lerp(-3.75, -0.3, a) : lerp(0.3, 3.75, a);
    const power = second ? Math.min(o.power, 0.62) : o.power;
    const dl = 5.55 + (power - 0.5) * 0.5;
    const errK = (1 + 1.5 * (1 - o.q)) * (o.errMul || 1);
    const sx = (0.16 + 0.6 * power * power) * errK, sz = (0.18 + 0.62 * power * power) * errK;
    const kmh = second ? lerp(105, 160, power) : lerp(115, 205, power);
    const rpm = lerp(2800, 800, power) * (second ? 1.25 : 1);
    const sol = solveShot({ ...b.p }, pl.side * (xl + gauss() * sx), -pl.side * (dl + gauss() * sz), kmh / 3.6, rpm * RPM, { lo: -0.45, hi: 0.3, minNet: 0.03 });
    rotateElevation(sol.v, gauss() * 0.003 * errK);
    return { sol, rpm, kind: second ? 'Second serve' : 'Serve', q: o.q, power };
  },
  applyHit(pl, shot, meta) {
    const b = this.ball, sol = shot.sol;
    b.v = { ...sol.v }; b.w = { ...sol.w }; b.netDone = false; b.rolling = false;
    b.lastHitter = pl.idx; b.bounces = 0; b.netTouched = false; b.serve = meta.serve || null; b.rally++; b.hitT = b.simT;
    this.hist.length = 0; this.bounceLog.length = 0;
    if (b.serve) this.state = 'rally';
    const kmh = Math.round(Math.hypot(b.v.x, b.v.y, b.v.z) * 3.6);
    if (this.mode !== 'attract') Sound.hit(shot.power ?? 0.6, this.camDist(b.p), shot.q ?? 1, !!b.serve);
    if (b.serve) this.match.stats.fastest[pl.idx] = Math.max(this.match.stats.fastest[pl.idx], kmh);
    UI.shot(pl, { kmh, rpm: shot.rpm, kind: shot.kind, tau: shot.tau, q: shot.q, aim: shot.aim, serve: !!b.serve });
    if (pl.ctl === 'human') Phone.send({ type: 'hit', power: shot.power ?? 0.6 });
    if (this.mode === 'online' && pl.ctl === 'human') {
      Net.send({ type: 'hit', t: b.simT, p: b.p, v: b.v, w: b.w, serve: b.serve, rally: b.rally, kmh, rpm: shot.rpm, kind: shot.kind, stroke: (pl.plan && pl.plan.stroke) || 'fh' });
    }
    Bus.emit('hit', { idx: pl.idx, human: pl.ctl === 'human', local: pl.idx === this.localIdx, stroke: b.serve ? 'serve' : (pl.plan && pl.plan.stroke) || 'fh', kind: shot.kind, kmh, rpm: shot.rpm, serve: !!b.serve, rally: b.rally, mode: this.mode, q: shot.q, tau: shot.tau });
    pl.plan = null; pl.path = null;
    pl.tx = clamp(pl.x * 0.3, -1.5, 1.5); pl.tz = pl.side * 12.5;
    this.players[1 - pl.idx].avatar.splitStep(Clock.now() + 0.05);   // the opponent split-steps as the ball is struck
    if (kmh > 150 && pl.idx === this.localIdx) Cam.shake(0.018);
    this.replanAll();
    UI.prompt();
  },

  // ---- running to the ball ----
  replanAll() {
    const now = Clock.now(), b = this.ball;
    for (const pl of this.players) {
      if (pl.ctl === 'remote') continue;
      if (this.state === 'rally' && b.lastHitter >= 0 && b.lastHitter !== pl.idx) {
        const fresh = !pl.plan;
        this.planFor(pl, now);
        if (pl.ctl === 'cpu' && fresh) pl.moveAfter = now + pl.react;
        // Remember how far this ball makes the player run, and how much time it leaves, for shotDifficulty.
        if (fresh && pl.plan) {
          const d = Math.hypot(pl.plan.bx - pl.x, pl.plan.bz - pl.z);
          pl.chase = { run: d, slack: pl.plan.t - now - travelTime(Math.max(0, d - 0.55), pl.maxSpeed, pl.acc) - pl.react };
        }
      }
    }
  },
  // Choose where and when to meet the ball: after its bounce, near waist height, forehand or backhand side, reachable in time.
  planFor(pl, now) {
    const b = this.ball;
    const path = predictPath(b, SURFACES[World.surface], 3.2, b.simT);
    pl.path = path;
    const hs = pl.handed === 'R' ? 1 : -1;
    let best = null;
    for (const s of path) {
      const tAvail = s.t - now;
      if (tAvail < 0.05 || s.b < 1) continue;
      if (s.b >= 2) break;
      if ((s.z > 0 ? 1 : -1) !== pl.side) continue;
      if (s.y < 0.3 || s.y > 1.8 || Math.abs(s.z) < 1.2 || Math.abs(s.z) > 17) continue;
      for (const stroke of ['fh', 'bh']) {
        const lat = (stroke === 'fh' ? 1 : -1) * hs * 0.8;
        const bx = s.x - pl.side * lat, bz = s.z + pl.side * 0.3;
        const need = travelTime(Math.max(0, Math.hypot(bx - pl.x, bz - pl.z) - 0.55), pl.maxSpeed, pl.acc) + pl.react;
        let cost = Math.abs(s.y - 0.95) * 1.1 + (stroke === 'bh' ? 0.2 : 0) + tAvail * 0.18;
        const late = need - tAvail;
        if (late > 0) cost += 8 + late * 6;
        if (!best || cost < best.cost) best = { cost, t: s.t, x: s.x, y: s.y, z: s.z, bx, bz, stroke, ok: late <= 0 };
      }
    }
    pl.plan = best;
    if (best) { pl.tx = best.bx; pl.tz = best.bz; }
  },

  // ---- rulings (made by whichever machine the ball is travelling towards) ----
  enterDead(dur, kind) {
    this.state = 'dead'; this.deadUntil = Clock.now() + dur; this.deadKind = kind; this.pending = null;
    for (const pl of this.players) { pl.plan = null; pl.avatar.prep = 0; }
    UI.prompt();
  },
  pointOver(w, reason) {
    if (this.state !== 'rally') return;
    const m = this.match, b = this.ball, lose = 1 - w, st = m.stats;
    if (reason === 'ace') st.aces[w]++; else if (reason === 'df') st.df[lose]++; else if (reason === 'winner') st.winners[w]++; else st.errors[lose]++;
    st.longest = Math.max(st.longest, b.rally);
    const ev = m.pointTo(w);
    this.enterDead(ev.match ? 3.4 : 2.7, 'point');
    this.announcePoint(w, reason, ev, b.rally);
    this.maybeReplay(reason, ev);
    if (this.mode === 'online') Net.send({ type: 'call', kind: 'point', w, reason, ev, rally: b.rally, m: m.toJSON() });
    UI.updateScore();
    Bus.emit('point', { w, reason, rally: b.rally, ev, mode: this.mode, localIdx: this.localIdx });
  },
  fault(reason) {
    const m = this.match;
    if (m.serveNo === 2) return this.pointOver(1 - this.ball.lastHitter, 'df');
    m.serveNo = 2;
    this.enterDead(1.6, 'fault');
    this.announceFault(reason);
    if (reason === 'out') this.maybeReplay('fault', null);
    if (this.mode === 'online') Net.send({ type: 'call', kind: 'fault', reason, m: m.toJSON() });
    UI.updateScore();
    Bus.emit('fault', { reason, serveNo: 1, mode: this.mode });
  },
  letCall() {
    this.enterDead(1.6, 'let');
    this.announceLet();
    if (this.mode === 'online') Net.send({ type: 'call', kind: 'let', m: this.match.toJSON() });
  },
  // Big points and close calls get an instant replay (practice matches; online play keeps both sides in step).
  maybeReplay(reason, ev) {
    if (this.mode !== 'cpu') return;
    const b = this.ball, hitter = this.players[b.lastHitter], recv = this.players[1 - b.lastHitter], b1 = this.bounceLog[0];
    if (!hitter) return;
    const line = b1 ? lineMargin(b1.x, b1.z, b.serve ? { rSide: recv.side, court: b.serve.court } : null) : null;
    Replay.consider({ reason, rally: b.rally, matchPoint: !!(ev && ev.match), hitT: b.hitT, tossT: this.tossT, endT: Clock.now(), bounces: this.bounceLog.slice(), line, hitter, receiver: recv });
  },
  scoreLine() {
    const m = this.match, s = m.currentServer, r = 1 - s, a = m.pts[s], b = m.pts[r];
    if (m.tb) return `${a}–${b}`;
    if (a >= 3 && b >= 3) return a === b ? 'Deuce' : `Advantage ${this.names[a > b ? s : r]}`;
    return `${PT_SHOW[a]}–${PT_SHOW[b]}`;
  },
  announcePoint(w, reason, ev, rally) {
    const m = this.match, names = this.names;
    const big = { ace: 'Ace', df: 'Double fault', out: 'Out', net: 'Net', winner: 'Winner' }[reason] || 'Point';
    const small = ev.match ? `Game, set and match · ${names[w]}` : ev.game ? (ev.tbStart ? `Game ${names[w]} · Tiebreak` : `Game · ${names[w]}`) : this.scoreLine();
    const amp = ev.match ? 1 : reason === 'ace' || reason === 'winner' ? clamp(0.5 + rally * 0.05, 0.5, 1) : 0.3;
    Crowd.cheer(amp);
    Crowd.flashBurst(Math.round(4 + amp * 10), 1.4);
    const now = Clock.now();
    this.players[w].avatar.react('win', now + 0.35);
    this.players[1 - w].avatar.react('lose', now + 0.35);
    if (this.mode === 'attract') return;
    UI.callout(big, small);
    if (this.localIdx >= 0) Phone.send({ type: 'point', won: w === this.localIdx, big, small });
    Sound.pointEnd(reason, rally, ev, this.callMargin());
    if (reason === 'out') Sound.say('Out!', { rate: 1.15, pitch: 1.1, cancel: true });
    else if (reason === 'df') Sound.say('Fault. Double fault.', { rate: 1.05, cancel: true });
    const call = ev.match ? `Game, set and match, ${names[w]}.` : ev.game ? `Game, ${names[w]}. ${ev.tbStart ? 'Tiebreak.' : m.gamesCall(names)}` : m.scoreCall(names);
    setTimeout(() => { if (this.match === m && this.mode !== 'attract') Sound.say(call); }, reason === 'out' || reason === 'df' ? 950 : 650);
  },
  announceFault(reason) {
    if (this.mode === 'attract') return;
    UI.callout('Fault', 'Second serve');
    if (reason === 'out') Sound.nearMiss(this.callMargin(), 0.6);
    Sound.say('Fault', { rate: 1.1, pitch: 1.05, cancel: true });
  },
  // How far the deciding bounce was from the line (metres, positive = out), for the crowd's reaction.
  callMargin() {
    const b = this.ball, b1 = this.bounceLog[0], recv = this.players[1 - b.lastHitter];
    if (!b1 || !recv) return null;
    return lineMargin(b1.x, b1.z, b.serve ? { rSide: recv.side, court: b.serve.court } : null).d;
  },
  announceLet() {
    if (this.mode === 'attract') return;
    UI.callout('Let', this.match.serveNo === 1 ? 'First serve' : 'Second serve');
    Sound.say('Let. ' + (this.match.serveNo === 1 ? 'First serve.' : 'Second serve.'), { cancel: true });
  },
  finish() {
    this.state = 'over';
    if (this.mode === 'attract') { this.startAttract(); return; }
    Bus.emit('match:end', { winner: this.match.winner, localIdx: this.localIdx, mode: this.mode, cfg: this.cfg, stats: this.match.stats, match: this.match });
    UI.showOver();
  },
  updateMarker(now, dt) {
    const me = this.me(), b = this.ball;
    let a = 0, x = 0, z = 0;
    if (Settings.assist && me && this.state === 'rally' && b.lastHitter >= 0 && b.lastHitter !== me.idx && b.bounces === 0 && me.path && me.path.bounce1) {
      const b1 = me.path.bounce1, tt = b1.t - now;
      x = b1.x; z = b1.z; a = tt > 0 ? clamp(1 - tt / 1.2, 0.15, 0.85) : 0;
    }
    this.markerA = damp(this.markerA, a, 10, dt);
    if (a > 0) BallView.marker(x, z, this.markerA); else BallView.marker(this.lastMX ?? 0, this.lastMZ ?? 0, this.markerA);
    if (a > 0) { this.lastMX = x; this.lastMZ = z; }
  },

  // ---- online: the other player's machine ----
  sendState(now) {
    if (now - this.stTimer < 0.05) return;
    this.stTimer = now;
    const me = this.me();
    if (me) Net.send({ type: 'st', x: me.x, z: me.z, vx: me.vx, vz: me.vz, pr: me.avatar.prep, ps: me.avatar.prepStroke, al: me.avatar.armLift });
  },
  updateRemote(pl, dt) {
    const n = pl.net;
    if (!n) return;
    const age = Math.min(0.25, Clock.now() - n.t);
    pl.x = damp(pl.x, n.x + n.vx * age, 14, dt); pl.z = damp(pl.z, n.z + n.vz * age, 14, dt);
    pl.vx = n.vx; pl.vz = n.vz;
    if (this.state === 'serve' || this.state === 'toss') { pl.vx = pl.vz = 0; }
  },
  remote() { return this.players[1 - this.localIdx]; },
  onRemoteState(m) {
    if (this.mode !== 'online') return;
    const pl = this.remote();
    if (this.state === 'serve' || this.state === 'toss') pl.net = null;
    else pl.net = { x: m.x, z: m.z, vx: m.vx, vz: m.vz, t: Clock.now() };
    pl.avatar.prep = m.pr || 0; pl.avatar.prepStroke = m.ps === 'bh' ? 'bh' : 'fh'; pl.avatar.armLift = m.al || 0;
  },
  onRemoteToss(m) {
    if (this.mode !== 'online') return;
    if (this.state === 'dead') this.startPoint();
    const pl = this.players[this.match.currentServer];
    if (pl.ctl !== 'remote' || this.state !== 'serve') return;
    const b = this.ball;
    b.p = { ...m.p }; b.v = { ...m.v }; b.w = { x: 0, y: 0, z: 0 }; b.simT = m.t; b.active = b.visible = true; b.netDone = false; b.rolling = false;
    this.state = 'toss'; this.tossT = m.t;
    pl.avatar.serveToss(m.t);
    UI.prompt();
  },
  onRemoteRetoss() {
    if (this.mode !== 'online' || this.state !== 'toss') return;
    const S = this.players[this.match.currentServer];
    this.state = 'serve'; this.ball.active = false; this.holdBall(S); S.avatar.idle(true);
    UI.prompt();
  },
  onRemoteHit(m) {
    if (this.mode !== 'online' || this.state === 'dead' || this.state === 'over') return;
    const b = this.ball, pl = this.remote();
    b.p = { ...m.p }; b.v = { ...m.v }; b.w = { ...m.w }; b.simT = m.t; b.netDone = false; b.rolling = false; b.active = b.visible = true;
    b.lastHitter = pl.idx; b.bounces = 0; b.netTouched = false; b.serve = m.serve || null; b.rally = m.rally; b.hitT = m.t;
    this.hist.length = 0; this.pending = null; this.state = 'rally';
    if (m.serve) pl.avatar.serveHit(m.t); else pl.avatar.swing(m.stroke === 'bh' ? 'bh' : 'fh', m.t);
    Sound.hit(0.6, this.camDist(b.p), 1, !!m.serve);
    if (m.serve) this.match.stats.fastest[pl.idx] = Math.max(this.match.stats.fastest[pl.idx], m.kmh || 0);
    UI.shot(pl, { kmh: m.kmh, rpm: m.rpm, kind: m.kind, serve: !!m.serve });
    this.replanAll();
    UI.prompt();
  },
  onRemoteSwing(m) { if (this.mode === 'online') this.remote().avatar.swing(m.stroke === 'bh' ? 'bh' : 'fh', m.t); },
  onRemoteCall(m) {
    if (this.mode !== 'online') return;
    this.match.load(m.m);
    if (m.kind === 'point') { this.state = 'rally'; this.enterDead(m.m.over ? 3.4 : 2.7, 'point'); this.announcePoint(m.w, m.reason, m.ev, m.rally); }
    else if (m.kind === 'fault') { this.enterDead(1.6, 'fault'); this.announceFault(m.reason); }
    else if (m.kind === 'let') { this.enterDead(1.6, 'let'); this.announceLet(); }
    UI.updateScore();
  },
};
Game.init = function () {
  this.players = [makePlayer(0), makePlayer(1)];
  for (const pl of this.players) pl.avatar.lookTarget = BallView.mesh.position;   // players watch the ball
  Replay.init(this.players.map((p) => p.avatar), {
    onEnd: () => { if (this.state === 'dead') this.deadUntil = Math.min(this.deadUntil, Clock.now() + 0.7); },
    onBoard: (note, ms) => UI.boardNote(note, ms),
  });
  Input.on((ev) => Game.onInput(ev));
};

export { rotateElevation, makePlayer, Game };
