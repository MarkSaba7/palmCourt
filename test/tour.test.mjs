// World Tour checks (no browser): calendar, field + draws, seeding, CPU strength, ranking maths, the career flow
// (enter, win, lose, retire, prizes, trophies, rolling points, seasons), editions, save/restore.
// Run: node test/tour.test.mjs
import assert from 'node:assert/strict';
import * as T from '../src/tour.js';
import { Bus } from '../src/events.js';
import { LEVELS } from '../src/core.js';
import { normalize } from '../src/profile.js';
import { recordMatch, newStats, checkAchievements } from '../src/economy.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const search = (s) => { globalThis.location = { search: s }; };
// A stand-in Profile: data + the calls the tour makes.
function fakeProfile(level = 1) {
  return { data: { id: 'test-player', xp: 0, fuzz: 0 }, level, fuzz: 0, xp: 0, saves: 0,
    addFuzz(v) { this.fuzz += v; this.data.fuzz += v; return v; }, addXP(v) { this.xp += v; this.data.xp += v; return v; }, changed() { this.saves++; } };
}
const fresh = (level) => { const p = fakeProfile(level); T.Tour.use(p); return p; };
const winRun = () => { let r = null; while (!r) r = T.Tour.record(true, '4–1'); return r; };
const REAL = /djokovic|nadal|federer|sinner|alcaraz|medvedev|zverev|murray|rublev|tsitsipas|ruud|fritz|wawrinka|thiem|hurkacz|rune|draper|shelton|kyrgios|monfils/i;

await test('calendar: 10 weeks, unique events, every tier, valid venues, the first week open to all', () => {
  assert.equal(T.WEEKS, 10);
  const ids = T.EVENTS.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const k of Object.keys(T.TIERS)) assert.ok(T.EVENTS.some((e) => e.tier === k), k);
  for (const e of T.EVENTS) {
    assert.ok(['hard', 'clay', 'grass'].includes(e.surface) && ['day', 'golden', 'night'].includes(e.tod), e.id);
    const t = T.TIERS[e.tier];
    assert.ok(t.draw === 8 || t.draw === 16);
    assert.equal(t.pts.length, T.rounds(t.draw) + 1);
    for (const a of [t.pts, t.fuzz, t.xp]) for (let i = 1; i < a.length; i++) assert.ok(a[i] > a[i - 1], `${e.id} prizes grow by round`);
  }
  assert.ok(T.EVENTS.some((e) => e.name === 'Palm Court Open' && e.surface === 'hard'));
  assert.ok(T.EVENTS.some((e) => e.name === 'Lawn Club Championship' && e.surface === 'grass'));
  assert.ok(T.EVENTS.some((e) => e.name === 'Neon Nights Finals' && e.tod === 'night' && e.tier === 'finals'));
  assert.equal(T.CALENDAR[0][0].tier, 'challenger');
  assert.deepEqual(T.reqOf(T.CALENDAR[0][0]), {});
  assert.equal(T.CALENDAR[T.WEEKS - 1][0].tier, 'finals');
  assert.equal(T.EVENTS.filter((e) => e.tier === 'challenger').length, 7);
  assert.equal(T.roundName(4, 0), 'Round of 16'); assert.equal(T.roundName(3, 0), 'Quarter-final'); assert.equal(T.roundName(3, 2), 'Final');
  assert.equal(T.reachedName(3, 3), 'Champion'); assert.equal(T.reachedName(3, 2), 'Runner-up');
});

await test('ranking: field curve, #500 at 0 points, #1 at the top, monotonic', () => {
  for (let k = 2; k <= T.FIELD_SIZE; k++) assert.ok(T.FIELD[k] <= T.FIELD[k - 1], `slot ${k}`);
  assert.equal(T.FIELD[1], 9000); assert.equal(T.FIELD[100], 700);
  assert.equal(T.rankFor(0), 500); assert.equal(T.rankFor(30), 500);
  assert.equal(T.rankFor(9001), 1); assert.equal(T.rankFor(9000), 2);
  let prev = 501;
  for (let p = 0; p < 12000; p += 37) { const r = T.rankFor(p); assert.ok(r <= prev); prev = r; }
  const one = T.rankFor(100);
  assert.ok(one > 350 && one < 430, `a Challenger title moves you a little (${one})`);
  const web = T.rankFor(700);
  assert.ok(web > 80 && web < 130, `all seven Challengers get you near the top 100 (${web})`);
  assert.equal(T.slotRank(10, 50), 10); assert.equal(T.slotRank(50, 50), 51);
});

await test('field: fictional names, pros hold 1-5, skill falls with rank', () => {
  const names = new Set();
  for (let k = 6; k <= T.FIELD_SIZE; k++) { const f = T.fieldPlayer(k); assert.ok(!REAL.test(f.name), f.name); names.add(f.name); assert.ok(STYLE(f.style)); }
  assert.equal(names.size, T.FIELD_SIZE - 5, 'every slot has its own name');
  assert.deepEqual([1, 2, 3, 4, 5].map((k) => T.fieldPlayer(k).pro), T.PRO_ORDER);
  assert.deepEqual(T.fieldPlayer(77), T.fieldPlayer(77), 'deterministic');
  assert.equal(T.skillFor(500), 0); assert.equal(T.skillFor(1), 1);
  assert.ok(T.skillFor(10) > T.skillFor(100));
});
function STYLE(k) { return !!T.STYLES[k]; }

await test('CPU strength: rookie → club → pro → elite, Challenger soft, Finals hard', () => {
  const eq = (a, b) => { for (const k of ['speed', 'acc', 'react', 'err', 'iq', 'pos', 'judge', 'sErr', 'risk']) assert.ok(Math.abs(a[k] - b[k]) < 1e-3, k); assert.deepEqual(a.power, b.power); };
  eq(T.cpuLevel(0), LEVELS.rookie); eq(T.cpuLevel(0.3), LEVELS.club); eq(T.cpuLevel(0.72), LEVELS.pro);
  let prev = T.cpuLevel(0);
  for (let s = 0.05; s <= 1.001; s += 0.05) { const L = T.cpuLevel(s); assert.ok(L.err <= prev.err + 1e-9 && L.speed >= prev.speed - 1e-9 && L.iq >= prev.iq - 1e-9); prev = L; }
  const ch = T.makeField(T.eventById('palm-court'), 1, { rank: 500 }), fin = T.makeField(T.eventById('neon-nights'), 1, { rank: 5 });
  assert.ok(ch.every((e) => e.you || e.skill < 0.3), 'Challenger players are below Club');
  assert.ok(Math.min(...ch.filter((e) => !e.you).map((e) => e.rank)) >= 150);
  assert.ok(fin.filter((e) => !e.you).every((e) => e.skill >= 0.65), 'Finals players are Pro or better');
  assert.equal(T.levelKey(0.05), 'rookie'); assert.equal(T.levelKey(0.4), 'club'); assert.equal(T.levelKey(0.9), 'pro');
});

await test('draws: size, you in it, pros per tier, your own pro left out, seeds placed', () => {
  for (const ev of T.EVENTS) {
    const f = T.makeField(ev, 1, { rank: 30, pro: 'rivas', name: 'Me' }, 'k'), N = T.TIERS[ev.tier].draw;
    assert.equal(f.length, N, ev.id);
    assert.equal(f.filter((e) => e.you).length, 1);
    assert.equal(new Set(f.map((e) => e.id)).size, N, 'no one twice');
    assert.equal(new Set(f.map((e) => e.rank)).size, N, 'unique ranks');
    assert.ok(!f.some((e) => e.pro === 'rivas' && !e.you), 'your pro is not also your opponent');
    const pros = f.filter((e) => e.pro && !e.you).length;
    if (ev.tier === 'challenger') assert.equal(pros, 0);
    if (ev.tier === 'major' || ev.tier === 'finals') assert.equal(pros, 4);
    if (ev.tier === 'masters') assert.equal(pros, 2);
  }
  assert.deepEqual(T.seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  const R = T.rng('s'), d16 = T.makeDraw(T.makeField(T.eventById('grand-rouge'), 1, { rank: 300 }), R);
  const at = (s) => d16.findIndex((e) => e.seed === s);
  assert.equal(at(1), 0); assert.equal(Math.floor(at(2) / 8), 1, 'seed 2 in the other half');
  assert.equal(new Set([1, 2, 3, 4].map((s) => Math.floor(at(s) / 4))).size, 4, 'seeds 1-4 in four quarters');
  assert.equal(d16[at(1)].rank, Math.min(...d16.map((e) => e.rank)), 'seed 1 is the best ranked');
  const a = T.makeDraw(T.makeField(T.eventById('marina'), 2, { rank: 400 }, 'x'), T.rng('same')).map((e) => e.id);
  const b = T.makeDraw(T.makeField(T.eventById('marina'), 2, { rank: 400 }, 'x'), T.rng('same')).map((e) => e.id);
  assert.deepEqual(a, b, 'deterministic');
});

await test('career: win the Palm Court Open → title, trophy, points, prizes, next week', () => {
  search('');
  const p = fresh(1), Tour = T.Tour;
  assert.equal(Tour.rank, 500);
  assert.equal(Tour.eligibility('seaside').ok, false, 'not this week');
  const run = Tour.enter('palm-court', { name: 'Tester', short: 'Tester' });
  assert.ok(run && run.n === 8 && run.R === 3 && run.draw[run.me].you);
  assert.equal(Tour.enter('palm-court'), null, 'one run at a time');
  const seen = [];
  const res = (() => { let r = null; while (!r) { const nx = Tour.next(); seen.push(nx.opp.id); assert.ok(!nx.opp.you); const o = Tour.matchOpts({}); assert.equal(o.tour.round, nx.round); assert.equal(o.surface, 'hard'); r = Tour.record(true, '4–2'); } return r; })();
  assert.equal(seen.length, 3); assert.equal(new Set(seen).size, 3);
  assert.ok(res.title && res.reached === 3 && res.pts === 100 && res.label === 'Champion');
  assert.equal(res.champion.you, true);
  assert.equal(p.fuzz, 400); assert.equal(p.xp, 350);
  const t = Tour.t;
  assert.equal(t.trophies.length, 1); assert.equal(t.trophies[0].ev, 'palm-court');
  assert.equal(t.stats.titles, 1); assert.equal(t.stats.won, 3);
  assert.equal(Tour.points, 100); assert.equal(Tour.rank, T.rankFor(100));
  assert.equal(t.week, 1); assert.equal(t.run, null);
  assert.ok(t.last && t.last.wins[2][0] === t.last.me);
  for (let r = 0; r < 3; r++) assert.equal(t.last.wins[r].filter((x) => x != null).length, 8 / 2 ** (r + 1), 'every match of the draw has a winner');
});

await test('career: losing ends the run with the round reached; quitting is a retirement', () => {
  const p = fresh(1), Tour = T.Tour;
  Tour.enter('palm-court', {});
  Tour.record(true, '4–3'); const r = Tour.record(false, '4–1');
  assert.equal(r.reached, 1); assert.equal(r.pts, 25); assert.equal(r.label, 'Semi-finalist'); assert.equal(p.fuzz, 120);
  assert.ok(r.champion && !r.champion.you);
  assert.equal(Tour.t.trophies.length, 0);
  Tour.enter('coral-bay', {});
  const q = Tour.retire();
  assert.equal(q.reached, 0); assert.ok(q.retired); assert.equal(Tour.t.stats.retired, 1);
  assert.ok(/ret\./.test(Tour.t.last.scores[0][T.myMatch(Tour.t.last, 0)]));
  assert.equal(Tour.t.week, 2);
});

await test('career: tour matches on the Bus (match:end, match:quit, stale matches ignored)', () => {
  fresh(1);
  const Tour = T.Tour, got = [], off = Bus.on('tour:match', (m) => got.push(m));
  Tour.enter('palm-court', {});
  const end = (won, cfg) => Bus.emit('match:end', { winner: won ? 0 : 1, localIdx: 0, mode: 'cpu', cfg, stats: {}, match: { games: won ? [4, 2] : [1, 4], pts: [0, 0], tb: false, tbOnly: false } });
  const cfg1 = Tour.matchOpts({});
  Bus.emit('match:start', { cfg: { mode: 'cpu', ...cfg1 } });
  assert.equal(Tour.run.live, true);
  end(true, cfg1);
  assert.equal(Tour.run.round, 1); assert.equal(Tour.run.live, false);
  assert.equal(Tour.run.scores[0][T.myMatch(Tour.run, 0)], '4–2');
  end(true, cfg1);   // the same match again (a stale cfg) changes nothing
  assert.equal(Tour.run.round, 1);
  const cfg2 = Tour.matchOpts({});
  Bus.emit('match:quit', { mode: 'cpu', cfg: cfg2 });
  assert.equal(Tour.run, null);
  assert.equal(got.length, 2); assert.ok(got[1].retired && got[1].ended.reached === 1);
  off();
});

await test('rankings: rolling points drop a season later; seasons roll over; entry by rank or level', () => {
  search('edition=steam');   // entry rules apply to the full tour; the web edition stops at the Challenger tier
  fresh(1);
  const Tour = T.Tour;
  Tour.enter('palm-court', {}); winRun();
  assert.equal(Tour.points, 100);
  for (let i = 0; i < T.WEEKS - 1; i++) assert.ok(Tour.skipWeek());
  assert.equal(Tour.t.season, 2); assert.equal(Tour.t.week, 0);
  assert.equal(Tour.points, 100, 'defending in the same week next season');
  assert.equal(T.defending(Tour.t), 100);
  Tour.enter('palm-court', {}); Tour.record(false, '4–0');
  assert.equal(Tour.points, 8, 'the new result replaces last season\'s');
  assert.equal(Tour.t.best, T.rankFor(100), 'best ranking kept');
  // entry: rank OR level
  const t = Tour.t, sea = T.eventById('seaside');
  t.week = 1;
  assert.equal(T.eligibility(t, sea, 1).ok, false);
  assert.match(T.eligibility(t, sea, 1).why, /rank #250 or Level 8/);
  assert.equal(T.eligibility(t, sea, 8).ok, true, 'by level');
  t.entries.push({ i: T.absWeek(t) - 1, ev: 'x', pts: 400 });
  assert.ok(Tour.rank <= 250); assert.equal(T.eligibility(t, sea, 1).ok, true, 'by rank');
  t.week = 9;
  assert.equal(T.eligibility(t, T.eventById('neon-nights'), 1).ok, false, 'Finals: top 8 only');
});

await test('editions: web plays Challengers; ?edition=steam and ?unlockAll=1 open everything', async () => {
  fresh(50);
  const t = T.Tour.t; t.week = 1;
  search('?edition=web');
  assert.equal(T.fullTour(), false);
  const sea = T.eligibility(t, T.eventById('seaside'), 50);
  assert.ok(!sea.ok && sea.steam && /Steam/.test(sea.why));
  assert.equal(T.eligibility(t, T.eventById('coral-bay'), 50).ok, true);
  search('?edition=steam'); assert.equal(T.fullTour(), true); assert.equal(T.eligibility(t, T.eventById('seaside'), 50).ok, true);
  search('?edition=web&unlockAll=1'); assert.equal(T.eligibility(t, T.eventById('neon-nights'), 1).ok, true);
  const { CONFIG } = await import('../src/config.js');
  search(''); assert.equal(T.edition(), CONFIG.edition || 'full', 'no URL override → the configured edition');
});

await test('save/restore: a run survives a reload (JSON + Profile normalize), a live match is replayed', () => {
  search('');
  const p = fresh(3), Tour = T.Tour;
  Tour.enter('palm-court', { name: 'Tester' });
  Tour.record(true, '4–2');
  Tour.matchStarted(Tour.matchOpts({}).tour);
  const before = Tour.next().opp.id;
  const saved = JSON.stringify(p.data);
  const q = fakeProfile(3); q.data = normalize({ ...JSON.parse(saved), v: 2, xp: 0, fuzz: 0 });
  T.Tour.use(q);
  assert.ok(Tour.run && Tour.run.live && Tour.run.round === 1);
  assert.equal(Tour.recover(), true); assert.equal(Tour.run.live, false);
  assert.equal(Tour.next().opp.id, before, 'same opponent after the reload');
  assert.ok(winRun().title);
  // old / broken tour saves
  assert.equal(T.migrateTour(null).v, T.TOUR_V);
  const m = T.migrateTour({ season: 3, week: 42, entries: 'x', run: { ev: 'nope', draw: [] } });
  assert.equal(m.season, 3); assert.equal(m.week, 9); assert.deepEqual(m.entries, []); assert.equal(m.run, null);
  const r = fakeProfile(); r.data.tour = { v: 0, season: 2 }; T.Tour.use(r);
  assert.equal(T.Tour.t.v, T.TOUR_V); assert.equal(T.Tour.t.season, 2);
});

await test('economy: winning a tour final counts a title (Silverware achievement)', () => {
  const st = newStats();
  recordMatch(st, { mode: 'cpu', won: true, level: 'club', surface: 'hard', tod: 'day', format: 'short', games: [4, 2], tour: { ev: 'palm-court', final: false } });
  assert.equal(st.tourTitles, 0);
  recordMatch(st, { mode: 'cpu', won: true, level: 'club', surface: 'hard', tod: 'day', format: 'short', games: [4, 2], tour: { ev: 'palm-court', final: true } });
  assert.equal(st.tourTitles, 1);
  assert.ok(checkAchievements(st, {}, {}, 1).some((a) => a.id === 'tour_title'));
});

await test('opponent strength by tier: a full season simulated, the tiers get harder', () => {
  const avg = (ev) => { const f = T.makeField(T.eventById(ev), 1, { rank: 60 }).filter((e) => !e.you); return f.reduce((a, e) => a + e.skill, 0) / f.length; };
  const c = avg('palm-court'), f5 = avg('seaside'), m = avg('red-dune'), mj = avg('lawn-club'), fin = avg('neon-nights');
  assert.ok(c < f5 && f5 < m && m < mj && mj < fin, [c, f5, m, mj, fin].map((x) => x.toFixed(2)).join(' < '));
});

console.log(`\n${n} tour tests passed`);
process.exit(0);
