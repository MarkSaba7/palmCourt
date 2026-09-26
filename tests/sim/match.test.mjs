// Scoring rules for the Match class (src/match.js). Pure Node, no browser:
//   node tests/sim/match.test.mjs          exit 1 on failure
// Explicit scenarios (deuce/advantage, sets, tiebreaks with the serve rotating every two points, every format in
// FORMATS, umpire calls, save/load) plus thousands of random matches checked against an independent scorer.
import { Match } from '../../src/match.js';
import { FORMATS } from '../../src/core.js';

let failures = 0, checks = 0;
const eq = (a, b, msg) => { checks++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { failures++; console.log(`  FAIL ${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } return ok; };
const ok = (c, msg) => { checks++; if (!c) { failures++; console.log('  FAIL ' + msg); } return c; };
const section = (name) => console.log('- ' + name);
const names = ['Ann', 'Bea'];
const win = (m, p, n = 1) => { let ev; for (let i = 0; i < n; i++) ev = m.pointTo(p); return ev; };
// Win a whole game for p from 0-0.
const game = (m, p) => win(m, p, 4);
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

section('a game: love, fifteen, thirty, forty, deuce, advantage');
{
  const m = new Match('full', 0);
  eq(m.pointLabels(), ['0', '0'], 'start labels');
  eq(m.scoreCall(names), '', 'no call at love all before the first point');
  eq(m.court, 'deuce', 'first point from the deuce court');
  win(m, 0); eq(m.pointLabels(), ['15', '0'], '15-0'); eq(m.scoreCall(names), 'Fifteen Love', 'call 15-0'); eq(m.court, 'ad', 'second point from the ad court');
  win(m, 1); eq(m.scoreCall(names), 'Fifteen all', 'call 15-15'); eq(m.court, 'deuce', 'third point deuce court');
  win(m, 1); eq(m.scoreCall(names), 'Fifteen Thirty', 'server score first: 15-30');
  win(m, 0); win(m, 0); eq(m.pointLabels(), ['40', '30'], '40-30');
  win(m, 1); eq(m.pointLabels(), ['40', '40'], 'deuce labels'); eq(m.scoreCall(names), 'Deuce', 'deuce call');
  win(m, 1); eq(m.pointLabels(), ['', 'AD'], 'receiver advantage'); eq(m.scoreCall(names), 'Advantage, Bea', 'advantage receiver');
  win(m, 0); eq(m.scoreCall(names), 'Deuce', 'back to deuce');
  let ev = win(m, 0); eq(m.scoreCall(names), 'Advantage, Ann', 'advantage server'); ok(!ev.game, 'advantage is not a game');
  ev = win(m, 0); ok(ev.game && !ev.match, 'game from advantage');
  eq(m.games, [1, 0], 'games 1-0'); eq(m.pts, [0, 0], 'points reset'); eq(m.server, 1, 'serve passes to the other player');
  eq(m.court, 'deuce', 'new game starts in the deuce court');
  eq(m.gamesCall(names), 'Ann leads, one game to zero', 'games call');
  // many deuces
  const d = new Match('full', 1);
  win(d, 0, 3); win(d, 1, 3);
  for (let i = 0; i < 20; i++) { ok(!win(d, i % 2).game, `deuce cycle ${i} no game`); }
  eq(d.scoreCall(names), 'Deuce', 'still deuce after 20 swings');
  ok(!win(d, 1).game && win(d, 1).game, 'two in a row wins a long deuce game');
  eq(d.games, [0, 1], 'receiver... server 1 won');
}

section('serveNo resets every point (a fault is only on the current point)');
{
  const m = new Match('short', 0);
  m.serveNo = 2; win(m, 1); eq(m.serveNo, 1, 'after a point');
  m.serveNo = 2; win(m, 1, 3); eq(m.serveNo, 1, 'after a game');
}

section('sets: short (first to 4) and full (first to 6), win by two, tiebreak at G-G');
for (const [key, G] of [['short', 4], ['full', 6]]) {
  // to love
  let m = new Match(key, 0), ev;
  for (let g = 0; g < G; g++) ev = game(m, 0);
  ok(ev.match && m.over && m.winner === 0, `${key}: ${G}-0 wins the set`);
  eq(m.games, [G, 0], `${key}: final games`);
  // G-(G-2) wins; G-(G-1) does not
  m = new Match(key, 0);
  for (let g = 0; g < G - 1; g++) { game(m, 0); game(m, 1); }
  ev = game(m, 0); ok(!ev.match && !m.over, `${key}: ${G}-${G - 1} is not over`);
  ev = game(m, 0); ok(ev.match && m.winner === 0, `${key}: ${G + 1}-${G - 1} wins`);
  // G-G: tiebreak
  m = new Match(key, 1);
  for (let g = 0; g < G; g++) { game(m, 0); game(m, 1); }
  ok(m.tb && !m.over, `${key}: tiebreak at ${G}-${G}`);
  eq(m.games, [G, G], `${key}: games at the tiebreak`);
  // Servers alternate every game: 2G games played, so the first server serves again.
  eq(m.server, 1, `${key}: the player due to serve starts the tiebreak`);
  eq(m.tbFirst, 1, `${key}: tbFirst`);
  eq(m.currentServer, 1, `${key}: tiebreak first point served by tbFirst`);
  // G-1 all then the tiebreak starts on G-G reached by either order
  const m2 = new Match(key, 0);
  for (let g = 0; g < G - 1; g++) { game(m2, 0); game(m2, 1); }
  game(m2, 1); ev = game(m2, 0); ok(ev.tbStart && m2.tb, `${key}: tbStart event`);
  eq(m2.gamesCall(names), `${['zero', 'one', 'two', 'three', 'four', 'five', 'six'][G]} games all`, `${key}: games all call`);
}

section('tiebreak: serve rotation (1, then 2 each), courts, first to 7 by two');
{
  const m = new Match('full', 0);
  for (let g = 0; g < 6; g++) { game(m, 0); game(m, 1); }
  ok(m.tb, 'in tiebreak');
  const first = m.tbFirst, seq = [], courts = [];
  // Play to 6-6 in the tiebreak alternating winners, then 8-6.
  const order = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1];
  let ev;
  for (const p of order) { seq.push(m.currentServer); courts.push(m.court); ev = m.pointTo(p); if (m.over) break; }
  const o = 1 - first;
  eq(seq, [first, o, o, first, first, o, o, first, first, o, o, first, first, o], 'server order A B B A A B B ...');
  eq(courts, ['deuce', 'ad', 'deuce', 'ad', 'deuce', 'ad', 'deuce', 'ad', 'deuce', 'ad', 'deuce', 'ad', 'deuce', 'ad'], 'courts alternate from deuce');
  ok(ev.match && m.over && m.winner === 1, 'tiebreak 8-6 wins the set');
  eq(m.games, [6, 7], 'set 7-6'); eq(m.pts, [6, 8], 'tiebreak points kept for the score line');
  // 7-5 wins, 7-6 does not
  const n = new Match('short', 1);
  for (let g = 0; g < 4; g++) { game(n, 0); game(n, 1); }
  win(n, 0, 6); win(n, 1, 5); ok(!n.over, '6-5 not over'); eq(n.pointLabels(), ['6', '5'], 'tiebreak labels are numbers');
  win(n, 1); ok(!n.over, '6-6 not over'); win(n, 0); ok(!n.over, '7-6 not over'); win(n, 0); ok(n.over && n.winner === 0, '8-6 over');
  const k = new Match('short', 0);
  for (let g = 0; g < 4; g++) { game(k, 0); game(k, 1); }
  win(k, 1, 5); win(k, 0, 6); ev = win(k, 0); ok(ev.match && k.winner === 0 && k.games[0] === 5, '7-5 wins, games 5-4');
}

section('tiebreak calls');
{
  const m = new Match('tiebreak', 0);
  eq(m.scoreCall(names), 'zero all', 'zero all');
  win(m, 0); eq(m.scoreCall(names), 'one, zero, Ann', 'one zero leader named');
  win(m, 1); eq(m.scoreCall(names), 'one all', 'one all');
  win(m, 1, 3); eq(m.scoreCall(names), 'four, one, Bea', 'four one Bea');
  win(m, 0, 20); ok(m.over, 'tiebreak over');
  const big = new Match('tiebreak', 0);
  for (let i = 0; i < 16; i++) win(big, i % 2);
  eq(big.scoreCall(names), 'eight all', 'eight all');
  win(big, 0, 9); win(big, 1, 9);
  eq(big.scoreCall(names), '17 all', 'numbers past the word list');
}

section('tiebreak-only format');
{
  const m = new Match('tiebreak', 1);
  ok(m.tb && m.tbOnly, 'starts in tiebreak');
  eq(m.currentServer, 1, 'first server');
  const ev = win(m, 1, 7);
  ok(ev.match && m.over && m.winner === 1, '7-0 wins');
  eq(m.games, [0, 1], 'one game to the winner');
}

section('toJSON / load round trip mid-match');
{
  const r = rng(7), a = new Match('full', 0);
  for (let i = 0; i < 37; i++) a.pointTo(r() < 0.5 ? 0 : 1);
  a.serveNo = 2;
  const b = new Match('full', 0);
  b.load(JSON.parse(JSON.stringify(a.toJSON())));
  eq(b.toJSON(), a.toJSON(), 'same state');
  for (let i = 0; i < 200 && !a.over; i++) { const p = r() < 0.5 ? 0 : 1; eq(b.pointTo(p), a.pointTo(p), `event ${i}`); eq(b.currentServer, a.currentServer, `server ${i}`); }
  eq(b.toJSON(), a.toJSON(), 'same after continuing');
  // load must copy, not alias (the message object is reused by the caller)
  const src = a.toJSON(), c = new Match('full', 0); c.load(src); c.pointTo(0);
  ok(src.pts !== c.pts, 'load copies arrays');
  // only score fields are taken from the other machine
  const d = new Match('short', 0);
  d.load({ ...a.toJSON(), G: 99, fmtKey: 'x', tbOnly: true, pointTo: 'nope' });
  ok(d.G === 4 && d.fmtKey === 'short' && !d.tbOnly && typeof d.pointTo === 'function', 'load ignores non-score fields');
  eq(d.pts, a.pts, 'load takes the points');
}

// ---- random matches against an independent scorer ----
function reference(fmtKey, first, winners) {
  const f = FORMATS[fmtKey], G = f.games;
  let pts = [0, 0], games = [0, 0], tb = !!f.tbOnly, server = first, tbFirst = first, over = false, winner = -1;
  const servers = [], courts = [];
  for (const p of winners) {
    if (over) break;
    const n = pts[0] + pts[1];
    let s;
    if (tb) s = n === 0 ? tbFirst : [1 - tbFirst, 1 - tbFirst, tbFirst, tbFirst][(n - 1) % 4];
    else s = server;
    servers.push(s); courts.push(n % 2 ? 'ad' : 'deuce');
    pts[p]++;
    const o = 1 - p;
    if (tb) { if (pts[p] >= 7 && pts[p] >= pts[o] + 2) { games[p]++; over = true; winner = p; } }
    else if (pts[p] >= 4 && pts[p] >= pts[o] + 2) {
      games[p]++; pts = [0, 0]; server = 1 - server;
      if (games[p] >= G && games[p] >= games[o] + 2) { over = true; winner = p; }
      else if (games[p] === G && games[o] === G) { tb = true; tbFirst = server; }
    }
  }
  return { pts, games, tb, over, winner, servers, courts };
}
section('random matches vs an independent scorer (every format)');
{
  const r = rng(12345);
  let n = 0, tbs = 0;
  for (const fmt of Object.keys(FORMATS)) {
    for (let t = 0; t < 1500; t++) {
      const bias = 0.3 + 0.4 * r(), first = r() < 0.5 ? 0 : 1, m = new Match(fmt, first), won = [];
      const servers = [], courts = [];
      let guard = 0, lastGames = [0, 0], evs = 0;
      while (!m.over && guard++ < 5000) {
        servers.push(m.currentServer); courts.push(m.court);
        // the server wins a little more often, like real tennis, so games go with serve and tiebreaks happen
        const p = r() < (m.currentServer === 0 ? bias + 0.15 : bias - 0.15) ? 0 : 1;
        won.push(p);
        const ev = m.pointTo(p);
        const labels = m.pointLabels();
        if (!ok(labels.every((s) => typeof s === 'string'), `${fmt}#${t} labels`)) break;
        if (ev.game && !m.tb) { evs++; ok(m.games[0] + m.games[1] === lastGames[0] + lastGames[1] + 1, `${fmt}#${t} one game at a time`); }
        lastGames = m.games.slice();
        ok(m.scoreCall(names) !== undefined && m.gamesCall(names), `${fmt}#${t} calls`);
      }
      ok(m.over, `${fmt}#${t} finished (guard ${guard})`);
      const ref = reference(fmt, first, won);
      if (!eq({ pts: m.pts, games: m.games, tb: m.tb, over: m.over, winner: m.winner }, { pts: ref.pts, games: ref.games, tb: ref.tb, over: ref.over, winner: ref.winner }, `${fmt}#${t} final state`)) break;
      if (!eq(servers, ref.servers, `${fmt}#${t} server sequence`)) break;
      if (!eq(courts, ref.courts, `${fmt}#${t} court sequence`)) break;
      eq(m.stats.points[0] + m.stats.points[1], won.length, `${fmt}#${t} points counted`);
      // a finished set is a legal score
      const [a, b] = m.games, w = m.winner, l = 1 - w, G = FORMATS[fmt].games;
      if (FORMATS[fmt].tbOnly) ok(m.pts[w] >= 7 && m.pts[w] - m.pts[l] >= 2, `${fmt}#${t} tiebreak-only final ${m.pts}`);
      else if (m.tb) { tbs++; ok(m.games[w] === G + 1 && m.games[l] === G && m.pts[w] >= 7 && m.pts[w] - m.pts[l] >= 2, `${fmt}#${t} tiebreak set ${a}-${b} (${m.pts})`); }
      else ok(m.games[w] >= G && m.games[w] - m.games[l] >= 2 && m.games[w] <= G + 1, `${fmt}#${t} set score ${a}-${b}`);
      n++;
    }
  }
  ok(tbs > 50, `random sets reached tiebreaks (${tbs})`);
  console.log(`  ${n} random matches`);
}

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(failures ? 1 : 0);
