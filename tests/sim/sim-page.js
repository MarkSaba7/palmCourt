// In-page simulation driver + rule checker for Palm Court. Loaded INTO the game page by the runner (run.mjs):
//   const S = await import('/tests/sim/sim-page.js');
// It never changes game code: it drives time with a virtual clock, runs the same per-frame calls as main.js's tick,
// and wraps Game's flow methods (calling the originals) to check every transition, line call and score change.
import { Game } from '/src/game.js';
import { Replay } from '/src/replay.js';
import { UI } from '/src/ui.js';
import { Input } from '/src/input.js';
import { Clock, Settings, COURT, BALL_R, LINE_TOL, FORMATS, LEVELS, netHeight } from '/src/core.js';
import { BallView, Cam } from '/src/render/actors.js';
import { BallKids } from '/src/render/ballkids.js';

// ---- virtual time: Clock.perf drives Clock.now() and the replay timers, so a match runs as fast as the CPU allows ----
export const V = { t: 0, on: false, frames: 0 };
export function install() {
  if (V.on) return;
  // Stop the page's own loop (rAF) so only we move the game. main.js's hidden-tab setInterval fallback still calls
  // tick() between our evaluate() calls, but with the virtual clock standing still it only nudges animations.
  if (!window.__pcRaf) { window.__pcRaf = window.requestAnimationFrame; window.__pcHeld = []; window.requestAnimationFrame = (cb) => { window.__pcHeld.push(cb); return 0; }; }
  V.t = performance.now() / 1000;
  Clock.perf = () => V.t;
  V.on = true;
}
// One frame, exactly like main.js tick() (minus rendering).
export function frame(dt) {
  V.t += dt; V.frames++;
  if (!Replay.update(dt)) {
    Game.update(dt);
    BallKids.update(Clock.paused ? 0 : dt, Game);
    Replay.record(Game.ball, BallView.mesh.visible);
    Cam.update(dt, Game.mode === 'cpu' || Game.mode === 'online' ? Game.me() : null, Game);
  }
  if (!Clock.paused) for (const p of Game.players) p.avatar.updateBlur();
  UI.frame(dt);
  if (C) C.afterFrame(dt);
}
// Run frames until pred() is true or `secs` of virtual time pass. Returns true if pred was met.
export function runUntil(pred, secs, dt = 1 / 60) {
  const end = V.t + secs;
  while (V.t < end) { frame(dt); if (pred && pred()) return true; }
  return !pred;
}
export const run = (secs, dt) => runUntil(null, secs, dt);

// The CPU plays the local side too (as the team brief describes).
export function cpuBoth() {
  const [a, b] = Game.players;
  a.ctl = 'cpu'; a.level = b.level; a.maxSpeed = b.maxSpeed; a.acc = b.acc; a.react = b.react;
}
// Start a practice match through the real UI entry point.
export async function startPractice({ format = 'short', surface = 'hard', level = 'club', cpu = true, replays = true, first } = {}) {
  Settings.control = 'mouse'; Settings.format = format; Settings.surface = surface; Settings.level = level; Settings.replays = replays;
  const rnd = Math.random;
  if (first != null) Math.random = () => (first === 0 ? 0.1 : 0.9);   // startCpu picks the first server with Math.random() < 0.5
  const p = UI.startCpu({});
  Math.random = rnd;
  await p;
  if (cpu) cpuBoth();
}

// ---- an independent scorer (not the Match class) ----
export class RefScore {
  constructor(fmt, first) { const f = FORMATS[fmt]; this.G = f.games; this.pts = [0, 0]; this.games = [0, 0]; this.tb = !!f.tbOnly; this.server = first; this.tbFirst = first; this.over = false; this.winner = -1; }
  get n() { return this.pts[0] + this.pts[1]; }
  get currentServer() { const n = this.n; return !this.tb ? this.server : n === 0 ? this.tbFirst : [1 - this.tbFirst, 1 - this.tbFirst, this.tbFirst, this.tbFirst][(n - 1) % 4]; }
  get court() { return this.n % 2 ? 'ad' : 'deuce'; }
  point(p) {
    const o = 1 - p; this.pts[p]++;
    if (this.tb) { if (this.pts[p] >= 7 && this.pts[p] >= this.pts[o] + 2) { this.games[p]++; this.over = true; this.winner = p; } return; }
    if (this.pts[p] >= 4 && this.pts[p] >= this.pts[o] + 2) {
      this.games[p]++; this.pts = [0, 0]; this.server = 1 - this.server;
      if (this.games[p] >= this.G && this.games[p] >= this.games[o] + 2) { this.over = true; this.winner = p; }
      else if (this.games[p] === this.G && this.games[o] === this.G) { this.tb = true; this.tbFirst = this.server; }
    }
  }
}
// ITF geometry, written out again rather than calling core.js: lines lie inside the court; a ball touching a line
// (within the contact patch LINE_TOL) is in. The centre service line is 5 cm wide, split evenly by x = 0.
export function inSingles(x, z) { return Math.abs(x) <= 4.115 + LINE_TOL && Math.abs(z) <= 11.885 + LINE_TOL; }
export function inBox(x, z, rSide, court) {
  if ((z > 0 ? 1 : -1) !== rSide || Math.abs(z) > 6.40 + LINE_TOL) return false;
  // The receiver faces the net; their right hand points to +x for the +z player and -x for the -z player.
  const right = x * rSide, lx = court === 'deuce' ? right : -right;
  return lx >= -0.025 - LINE_TOL && lx <= 4.115 + LINE_TOL;
}

// ---- the checker ----
const LEGAL = new Set(['idle>serve', 'serve>toss', 'toss>serve', 'toss>rally', 'rally>dead', 'dead>serve', 'dead>over']);
let C = null;
export function checker(opts = {}) { if (!C) C = new Checker(); C.opts = { stall: { serve: 7, toss: 1.8, dead: 16 }, humanServe: false, ...opts }; return C; }
export function getChecker() { return C; }

class Checker {
  constructor() {
    this.errors = []; this.log = []; this.counts = {}; this.calls = []; this.depth = 0; this.inStart = 0;
    this.state = Game.state; this.since = Clock.now(); this.ref = null; this.frameFlags = { net: false, reset: false };
    this.prevBall = null; this.matches = []; this.points = 0; this.maxRally = 0; this.replays = {};
    this.wrap();
  }
  err(msg, extra) {
    if (this.errors.length < 60) this.errors.push({ msg, t: +Clock.now().toFixed(3), state: Game.state, score: Game.match && JSON.stringify({ p: Game.match.pts, g: Game.match.games, s: Game.match.serveNo, tb: Game.match.tb }), ...(extra ? { extra } : {}) });
  }
  count(k, n = 1) { this.counts[k] = (this.counts[k] || 0) + n; }
  transition(from, to, via) {
    if (from === to) return;
    if (!this.inStart && !LEGAL.has(`${from}>${to}`)) this.err(`illegal transition ${from} -> ${to} via ${via}`);
    this.count(`${from}>${to}`);
    this.state = to; this.since = Clock.now();
  }
  wrap() {
    const G = Game, self = this;
    const w = (name, before, after) => {
      const orig = G[name];
      G[name] = function (...args) {
        const s0 = G.state, ctx = before ? before.apply(self, args) : null;
        self.depth++;
        let r;
        try { r = orig.apply(this, args); } finally { self.depth--; }
        if (G.state !== s0) self.transition(s0, G.state, name);
        if (after) after.call(self, ctx, args, r);
        return r;
      };
    };
    w('startMatch', function (cfg) { this.inStart++; this.ref = new RefScore(cfg.format, cfg.first); return cfg; }, function (cfg) {
      this.inStart--; this.state = G.state; this.since = Clock.now(); this.prevBall = null;
      this.matches.push({ cfg: { mode: cfg.mode, format: cfg.format, surface: cfg.surface, level: cfg.level, first: cfg.first }, points: 0, over: false });
    });
    w('startPoint', null, function () {
      this.frameFlags.reset = true;
      const m = G.match, r = this.ref;
      if (!r || G.mode === 'attract') return;
      const srv = m.currentServer;
      if (srv !== r.currentServer) this.err(`startPoint: server ${srv}, expected ${r.currentServer}`);
      if (m.court !== r.court) this.err(`startPoint: court ${m.court}, expected ${r.court}`);
      const S = G.players[srv], R = G.players[1 - srv], right = m.court === 'deuce' ? 1 : -1;
      // The server stands to the right of the centre mark in the deuce court (+x for the +z player), the receiver diagonally opposite.
      if (Math.sign(S.x * S.side) !== right || Math.sign(S.z) !== S.side || Math.abs(S.z) < 11.8) this.err(`startPoint: server at ${S.x.toFixed(2)},${S.z.toFixed(2)} for ${m.court}`);
      if (Math.sign(R.x * R.side) !== right || Math.sign(R.z) !== R.side) this.err(`startPoint: receiver at ${R.x.toFixed(2)},${R.z.toFixed(2)} for ${m.court}`);
      if (G.state !== 'serve' || G.ball.active) this.err('startPoint: ball not held for the serve');
    });
    w('toss', null, function () { if (G.state === 'toss') { this.frameFlags.reset = true; this.count('toss'); } });
    w('retoss', null, function () { this.frameFlags.reset = true; this.count('retoss'); });
    w('applyHit', function (pl, shot, meta) {
      const b = G.ball, m = G.match;
      if (meta.serve) {
        if (G.state !== 'toss') this.err(`serve struck in state ${G.state}`);
        if (pl.idx !== m.currentServer) this.err(`serve by ${pl.idx}, server is ${m.currentServer}`);
        if (meta.serve.court !== m.court || meta.serve.no !== m.serveNo) this.err(`serve meta ${JSON.stringify(meta.serve)} vs court ${m.court} no ${m.serveNo}`);
        this.count(`serve${m.serveNo}`);
      } else {
        if (G.state !== 'rally') this.err(`ground stroke in state ${G.state}`);
        if (b.lastHitter === pl.idx) this.err(`player ${pl.idx} hit the ball twice in a row`);
        if (b.bounces > 1) this.err(`hit after ${b.bounces} bounces`);
        if (b.serve && b.bounces !== 1) this.err('return of serve before the bounce');
        if ((b.p.z > 0 ? 1 : -1) !== pl.side) this.err(`player ${pl.idx} hit the ball on the other side of the net (z ${b.p.z.toFixed(2)})`);
        this.count('groundStroke');
      }
      if (!Number.isFinite(shot.sol.v.x + shot.sol.v.y + shot.sol.v.z)) this.err('non-finite shot velocity');
    }, function () { this.frameFlags.reset = true; this.maxRally = Math.max(this.maxRally, G.ball.rally); });
    w('pointOver', function (wnr, reason) { return { live: G.state === 'rally', wnr, reason }; }, function (ctx) {
      if (!ctx.live) return;
      this.calls.push({ kind: 'point', w: ctx.wnr, reason: ctx.reason });
      this.count('reason:' + ctx.reason); this.points++;
      const mm = this.matches[this.matches.length - 1]; if (mm) mm.points++;
      const m = G.match, r = this.ref;
      if (r && G.mode !== 'attract') {
        r.point(ctx.wnr);
        const got = { pts: m.pts, games: m.games, tb: m.tb, over: m.over, winner: m.winner }, want = { pts: r.pts, games: r.games, tb: r.tb, over: r.over, winner: r.winner };
        if (JSON.stringify(got) !== JSON.stringify(want)) this.err('score mismatch after a point', { got, want });
      }
      if (m.serveNo !== 1) this.err(`serveNo ${m.serveNo} after a point`);
      if (G.state !== 'dead') this.err(`state ${G.state} after pointOver`);
    });
    w('fault', function (reason) { return { live: G.state === 'rally', no: G.match.serveNo, pts: G.match.pts.slice(), reason }; }, function (ctx) {
      if (!ctx.live) return;
      if (ctx.no === 1) {
        this.calls.push({ kind: 'fault', reason: ctx.reason }); this.count('fault:' + ctx.reason);
        if (G.match.serveNo !== 2) this.err('first-serve fault did not give a second serve');
        if (JSON.stringify(G.match.pts) !== JSON.stringify(ctx.pts)) this.err('a fault changed the points');
      }
    });
    w('letCall', function () { return { no: G.match.serveNo, pts: G.match.pts.slice() }; }, function (ctx) {
      this.calls.push({ kind: 'let' }); this.count('let');
      if (G.match.serveNo !== ctx.no || JSON.stringify(G.match.pts) !== JSON.stringify(ctx.pts)) this.err('a let changed the score or serve number');
    });
    w('onBallEvent', function (e) {
      if (e.type === 'net') this.frameFlags.net = true;
      this.calls.length = 0;
      const b = G.ball, m = G.match;
      if (G.state !== 'rally' || e.type !== 'bounce' || !G.isReferee()) return null;
      const hitter = b.lastHitter, recv = 1 - hitter, rSide = G.players[recv].side, n = b.bounces + 1, half = e.z >= 0 ? 1 : -1;
      let exp = null;
      if (n === 1) {
        const fault = (reason) => (m.serveNo === 2 ? { kind: 'point', w: recv, reason: 'df' } : { kind: 'fault', reason });
        if (half !== rSide) exp = b.serve ? fault('net') : { kind: 'point', w: recv, reason: 'net' };
        else if (b.serve) {
          const inside = inBox(e.x, e.z, rSide, b.serve.court);
          exp = !inside ? fault(b.netTouched ? 'net' : 'out') : b.netTouched ? { kind: 'let' } : null;
          if (this.opts.lineLog && Math.abs(Math.abs(e.x) - 4.115) < 0.03) this.log.push(`serve near sideline x=${e.x.toFixed(4)} in=${inside}`);
        } else if (!inSingles(e.x, e.z)) exp = { kind: 'point', w: recv, reason: 'out' };
        // near-line bookkeeping: calls within 3 cm of a line
        const near = b.serve ? null : Math.min(Math.abs(Math.abs(e.x) - 4.115), Math.abs(Math.abs(e.z) - 11.885));
        if (near != null && near < 0.03) this.count('closeCall');
      } else exp = { kind: 'point', w: hitter, reason: b.serve ? 'ace' : 'winner' };
      return { exp, e: { x: +e.x.toFixed(4), z: +e.z.toFixed(4) }, serve: !!b.serve, n };
    }, function (ctx) {
      if (!ctx) return;
      const got = this.calls.filter((c) => c.kind !== 'fault' || !this.calls.some((d) => d.reason === 'df'));
      const want = ctx.exp ? [ctx.exp] : [];
      const norm = (a) => JSON.stringify(a.map((c) => ({ kind: c.kind, w: c.w, reason: c.reason })));
      if (norm(got) !== norm(want)) this.err('line call mismatch', { bounce: ctx.e, n: ctx.n, serve: ctx.serve, got, want });
      this.count('checkedBounce');
    });
    w('finish', null, function () {
      const m = G.match, r = this.ref, mm = this.matches[this.matches.length - 1];
      if (G.mode === 'attract') return;
      if (mm) mm.over = true;
      if (!m.over) this.err('finish() before the match was over');
      if (r && (r.winner !== m.winner || !r.over)) this.err(`winner ${m.winner}, reference ${r.winner}`);
      const over = document.getElementById('over');
      if (G.state !== 'over') this.err('state not over after finish');
      if (G.mode === 'cpu' && (UI.screen !== 'over' || !over || over.hidden)) this.err(`over screen not shown (screen ${UI.screen})`);
      const title = document.getElementById('overTitle').textContent;
      const wantTitle = m.winner === G.localIdx ? 'You win' : `${G.names[m.winner]} wins`;
      if (title !== wantTitle) this.err(`over title "${title}", want "${wantTitle}"`);
      this.count('matchOver');
    });
    const origRB = G.updateState;
    G.updateState = function (now) {
      const b = G.ball, timeout = G.state === 'rally' && G.isReferee() && b.simT - b.hitT > 8;
      if (timeout) { self.count('eightSecondRule'); self.log.push(`8 s rule: rally ${b.rally} ball at ${b.p.x.toFixed(2)},${b.p.y.toFixed(2)},${b.p.z.toFixed(2)} v ${Math.hypot(b.v.x, b.v.y, b.v.z).toFixed(2)} rolling ${b.rolling} bounces ${b.bounces}`); }
      const s0 = G.state, r = origRB.call(this, now);
      if (G.state !== s0 && s0 === 'dead') {/* transition recorded by startPoint/finish */}
      return r;
    };
    const origReplay = Replay.consider;
    Replay.consider = function (spec) { const r = origReplay.call(this, spec); if (this.phase === 'wait') self.count('replay:' + this.spec.style); return r; };
  }
  afterFrame() {
    const G = Game, b = G.ball, now = Clock.now();
    if (G.state !== this.state) { this.err(`unexplained state change ${this.state} -> ${G.state}`); this.state = G.state; this.since = now; }
    // stall detector
    const age = now - this.since, lim = this.opts.stall;
    const humanServing = G.match && G.players[G.match.currentServer] && G.players[G.match.currentServer].ctl === 'human';
    if (!Clock.paused && G.mode !== 'idle') {
      if (G.state === 'serve' && !humanServing && age > lim.serve && !this.stalled) { this.stalled = true; this.err(`stall: serve for ${age.toFixed(1)} s`); }
      if (G.state === 'toss' && age > lim.toss && !this.stalled) { this.stalled = true; this.err(`stall: toss for ${age.toFixed(1)} s`); }
      if (G.state === 'dead' && age > lim.dead && !this.stalled) { this.stalled = true; this.err(`stall: dead for ${age.toFixed(1)} s (replay ${Replay.phase})`); }
      if (G.state === 'rally' && b.simT - b.hitT > 8.6 && G.isReferee() && !this.stalled) { this.stalled = true; this.err(`stall: rally ball unplayed for ${(b.simT - b.hitT).toFixed(1)} s`); }
      if (!['serve', 'toss', 'dead', 'rally'].includes(G.state) || age < 0.5) this.stalled = false;
    }
    // one ball, and it is where the rules say
    if (!Replay.active) {
      // (in 'dead' a ball kid may hide the ball after Game.update drew it: one frame late is fine)
      if (G.state !== 'dead' && BallView.mesh.visible !== !!b.visible) this.err('rendered ball visibility differs from the game ball');
      if ((G.state === 'toss' || G.state === 'rally') && !(b.active && b.visible)) this.err(`ball not in play during ${G.state}`);
      if (G.state === 'serve' && b.active) this.err('ball in flight during serve');
    }
    if (!Number.isFinite(b.p.x + b.p.y + b.p.z + b.v.x + b.v.y + b.v.z)) this.err('non-finite ball');
    if (b.p.y < BALL_R - 1e-6) this.err(`ball below the court (y ${b.p.y})`);
    for (const pl of G.players) if (!Number.isFinite(pl.x + pl.z)) this.err(`non-finite player ${pl.idx}`);
    // the ball never passes through the net
    const cur = { x: b.p.x, y: b.p.y, z: b.p.z, active: b.active, st: G.state };
    const p = this.prevBall;
    if (p && p.active && cur.active && !this.frameFlags.reset && !this.frameFlags.net && (p.z > 0) !== (cur.z > 0) && p.z !== 0 && ['rally', 'dead'].includes(cur.st)) {
      const f = p.z / (p.z - cur.z), x = p.x + (cur.x - p.x) * f, y = p.y + (cur.y - p.y) * f;
      if (Math.abs(x) < COURT.postX + 0.05 && y - netHeight(x) < BALL_R - 0.005) this.err(`ball passed through the net at x ${x.toFixed(2)} y ${y.toFixed(3)} (${p.st} -> ${cur.st}, rolling ${b.rolling})`);
      this.count('netCrossing');
    }
    this.prevBall = cur; this.frameFlags.reset = false; this.frameFlags.net = false;
  }
  reset() { this.errors = []; this.counts = {}; this.log = []; this.matches = []; this.points = 0; this.maxRally = 0; this.stalled = false; this.state = Game.state; this.since = Clock.now(); }
  report() { return { errors: this.errors, counts: this.counts, log: this.log.slice(-20), matches: this.matches, points: this.points, maxRally: this.maxRally, frames: V.frames }; }
}
