// Profile store checks (no browser): persistence through fake IndexedDB/localStorage, debounced saves, migrations,
// corrupt saves, export/import/reset, and the match-reward wiring (progress.js). Run: node test/profile.test.mjs
import assert from 'node:assert/strict';

// ---- fake storage ----
class FakeLS {
  constructor() { this.m = new Map(); this.writes = 0; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.writes++; this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
function fakeIDB(store = new Map()) {
  const later = (fn) => setTimeout(fn, 1);
  const db = {
    createObjectStore() {},
    transaction() {
      const tx = {}, done = () => later(() => tx.oncomplete && tx.oncomplete());
      tx.objectStore = () => ({ get(k) { const r = {}; later(() => { r.result = store.get(k); done(); }); return r; }, put(v, k) { const r = {}; later(() => { store.set(k, v); done(); }); return r; } });
      return tx;
    },
  };
  return { store, open() { const req = {}; later(() => { req.result = db; req.onupgradeneeded && req.onupgradeneeded(); req.onsuccess(); }); return req; } };
}
let LS = new FakeLS(), IDB = fakeIDB();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { if (!LS) throw new Error('SecurityError'); return LS; } });
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get: () => IDB });

const { Profile, normalize, freshData, SCHEMA } = await import('../src/profile.js');
const { Progress, buildSummary } = await import('../src/progress.js');
const E = await import('../src/economy.js');
const KEY = 'palmcourt.profile', BAK = 'palmcourt.profile.bak', BAD = 'palmcourt.profile.corrupt';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const reload = async ({ ls = LS, idb = IDB } = {}) => { clearTimeout(Profile.timer); LS = ls; IDB = idb; await Profile.load(); return Profile; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await test('fresh profile on first run, IndexedDB + localStorage', async () => {
  await Profile.ready;
  assert.equal(Profile.storage, 'indexeddb');
  assert.equal(Profile.level, 1); assert.equal(Profile.xp, 0); assert.equal(Profile.fuzz, 0); assert.equal(Profile.xpInLevel, 0);
  assert.equal(Profile.xpForLevel(1), E.xpForLevel(1));
  assert.equal(Profile.data.v, SCHEMA);
  assert.ok(IDB.store.get(KEY) && LS.getItem(KEY), 'a first save is written to both');
  assert.deepEqual(Object.keys(Profile.equipped).sort(), ['band', 'celebration', 'headwear', 'outfit', 'racket', 'title']);
});
await test('xp / fuzz / spend / grant / equip, with events', async () => {
  const ev = [];
  const offs = ['change', 'levelup', 'unlock'].map((e) => Profile.on(e, (d) => ev.push([e, d && d.id, d && d.to])));
  Profile.addXP(E.xpToReach(3) + 5, 'test');
  assert.equal(Profile.level, 3); assert.equal(Profile.xpInLevel, 5);
  assert.ok(ev.some(([e, , to]) => e === 'levelup' && to === 3));
  assert.ok(ev.some(([e, id]) => e === 'unlock' && id === 'surface:clay'), 'level unlocks are announced');
  Profile.addFuzz(500, 'test');
  assert.equal(Profile.spend(200, 'x'), true); assert.equal(Profile.fuzz, 300);
  assert.equal(Profile.spend(1e6, 'x'), false); assert.equal(Profile.spend(-5, 'x'), false); assert.equal(Profile.fuzz, 300);
  assert.equal(Profile.addXP(-50), 0);
  assert.equal(Profile.equip('outfit', 'outfit:crimson'), false, 'not owned');
  assert.equal(Profile.grant('outfit:crimson'), true); assert.equal(Profile.grant('outfit:crimson'), false);
  assert.ok(ev.some(([e, id]) => e === 'unlock' && id === 'outfit:crimson'));
  assert.equal(Profile.equip('outfit', 'outfit:crimson'), true);
  assert.equal(Profile.equip('outfit', 'racket:jade'), false, 'wrong slot');
  assert.equal(Profile.equip('hat', 'outfit:crimson'), false, 'no such slot');
  assert.equal(Profile.equip('racket', 'racket:stock'), true, 'free items need no grant');
  assert.equal(Profile.equip('title', null), true);
  assert.ok(Profile.data.ledger.length >= 3);
  offs.forEach((f) => f());
});
await test('debounced save, then a reload keeps everything', async () => {
  const w0 = LS.writes;
  for (let i = 0; i < 10; i++) Profile.addFuzz(1, 'tick');
  assert.equal(LS.writes, w0, 'nothing written yet');
  await wait(500);
  assert.equal(LS.writes - w0, 2, 'one save (backup + main)');
  await Profile.pending;
  const snap = JSON.stringify(Profile.data);
  Profile.data = freshData();   // "close the tab"
  await reload();
  assert.equal(JSON.stringify(Profile.data), snap);
  assert.equal(Profile.equipped.outfit, 'outfit:crimson');
  assert.equal(Profile.fuzz, 310);
});
await test('localStorage only (no IndexedDB), and the newest save wins across backends', async () => {
  const keep = IDB;
  await reload({ idb: null });
  assert.equal(Profile.storage, 'localstorage'); assert.equal(Profile.fuzz, 310);
  const older = { ...JSON.parse(LS.getItem(KEY)), fuzz: 1, updated: 1 };
  LS.setItem(KEY, JSON.stringify(older));
  await reload({ idb: keep });
  assert.equal(Profile.fuzz, 310, 'IndexedDB copy is newer');
});
await test('memory fallback when storage is blocked', async () => {
  const [ls, idb] = [LS, IDB];
  await reload({ ls: null, idb: null });
  assert.equal(Profile.storage, 'memory'); assert.equal(Profile.level, 1);
  Profile.addFuzz(5); await Profile.save(true);   // must not throw
  await reload({ ls, idb });
  assert.equal(Profile.fuzz, 310);
});
await test('corrupt main save: backup copy restores it; both corrupt: fresh profile, bad copy kept', async () => {
  Profile.addFuzz(90); await Profile.save(true);    // main 400, backup 310
  IDB.store.set(KEY, '{"xp": 12, "fuzz": '); LS.setItem(KEY, 'garbage');
  await reload();
  assert.equal(Profile.recovered, 'backup'); assert.equal(Profile.fuzz, 310);
  assert.equal(IDB.store.get(BAD), '{"xp": 12, "fuzz": ');
  assert.ok(normalize(JSON.parse(IDB.store.get(KEY))), 'recovered profile saved back as main');
  for (const s of [IDB.store, LS.m]) { s.set(KEY, '[1,2]'); s.set(BAK, '{"xp":"lots"}'); }
  await reload();
  assert.equal(Profile.recovered, 'reset'); assert.equal(Profile.fuzz, 0); assert.equal(Profile.level, 1);
});
await test('migrations and normalize', () => {
  const v0 = normalize({ xp: 800, fuzz: 5, owned: ['outfit:navy'], stats: { wins: 3 } });
  assert.equal(v0.v, SCHEMA); assert.deepEqual(Object.keys(v0.owned), ['outfit:navy']); assert.equal(v0.seen.level, E.levelFor(800));
  assert.equal(v0.stats.wins, 3); assert.equal(v0.stats.matches, 0, 'missing stats filled in');
  assert.equal(normalize({ v: 1, xp: 0, fuzz: 0 }).v, SCHEMA);
  assert.equal(normalize(null), null); assert.equal(normalize([]), null); assert.equal(normalize({ xp: 'x', fuzz: 0 }), null); assert.equal(normalize({ v: -1, xp: 0, fuzz: 0 }), null);
  const future = normalize({ v: 99, xp: 10, fuzz: 2, newThing: 1 });
  assert.equal(future.v, 99); assert.equal(future.newThing, 1, 'newer saves keep their fields');
  assert.equal(normalize({ xp: -40.7, fuzz: 3.9 }).xp, 0);
  assert.equal(normalize({ xp: 1, fuzz: 1, history: new Array(80).fill({}) }).history.length, 50);
});
await test('export / import / reset', async () => {
  Profile.addXP(2000); Profile.addFuzz(777); Profile.grant('racket:jade');
  const out = Profile.exportJSON(), lvl = Profile.level;
  assert.equal(JSON.parse(out).format, 'palmcourt-profile');
  await Profile.reset();
  assert.equal(Profile.level, 1); assert.equal(Profile.fuzz, 0);
  assert.equal(JSON.parse(LS.getItem(BAK)).fuzz, 777, 'the reset profile is the backup');
  const ups = []; const off = Profile.on('levelup', (d) => ups.push(d));
  assert.equal(await Profile.importJSON(out), true);
  off();
  assert.equal(Profile.level, lvl); assert.equal(Profile.fuzz, 777); assert.ok(Profile.owns('racket:jade')); assert.equal(ups.length, 1);
  assert.throws(() => Profile.importJSON('not json'), /not a Palm Court save/);
  assert.throws(() => Profile.importJSON('{"hello":1}'), /not a Palm Court save/);
  assert.equal(Profile.fuzz, 777, 'a failed import changes nothing');
  await reload();
  assert.equal(Profile.fuzz, 777);
});
await test('match rewards: summary from the Bus payload, rewards, challenges, achievements, history', async () => {
  await Profile.reset();
  const match = { tbOnly: false, tb: false, fmtKey: 'short', games: [4, 1], pts: [0, 0], stats: { aces: [3, 0], df: [0, 2], winners: [6, 2], errors: [5, 9], points: [26, 14], longest: 13, fastest: [181, 150] } };
  const s = buildSummary({ winner: 0, localIdx: 0, mode: 'cpu', cfg: { level: 'club', surface: 'hard', format: 'short', pros: ['custom', 'rivas'], names: ['Me', 'Rivas'] }, stats: match.stats, match }, { t0: null, hits: 50, onTime: 20, clean: 20, control: 'hand', tod: 'day' });
  assert.deepEqual([s.won, s.score, s.points, s.pointsLost, s.aces, s.doubleFaults, s.winners, s.errors, s.longestRally, s.cleanHits, s.fastestServe, s.opponent], [true, '4–1', 26, 14, 3, 0, 6, 5, 13, 20, 181, 'rivas']);
  const got = []; const off = Profile.on('reward', (r) => got.push(r));
  const r1 = Progress.applyMatch(s);
  off();
  assert.equal(got.length, 1); assert.equal(Progress.last, r1);
  assert.ok(r1.lines.some((l) => l.label === 'First win of the day'));
  assert.ok(r1.achievements.some((a) => a.id === 'first_win') && r1.achievements.some((a) => a.id === 'ace_1'));
  assert.equal(Profile.xp, r1.totalXP); assert.equal(Profile.fuzz, r1.totalFuzz);
  assert.equal(Profile.stats.wins, 1); assert.equal(Profile.stats.beat.rivas, 1); assert.equal(Profile.history.length, 1);
  assert.ok(Profile.level >= 2, 'a big first win gets level 2');
  const r2 = Progress.applyMatch({ ...s, won: false });
  assert.ok(!r2.lines.some((l) => /First win/.test(l.label)) && !r2.achievements.some((a) => a.id === 'first_win'));
  const r3 = Progress.applyMatch(s);
  assert.ok(!r3.lines.some((l) => /First win/.test(l.label)), 'first win of the day only once');
  const daily = Progress.daily();
  assert.equal(daily.length, 3); assert.ok(daily.every((c) => c.text && c.goal > 0 && c.progress >= 0));
  const open = daily.findIndex((c) => !c.done);
  if (open >= 0) { assert.equal(Progress.reroll(open), true); assert.equal(Progress.reroll(open), false, 'one reroll a day'); }
  assert.equal(Progress.daily().length, 3);
  assert.ok(E.buy('outfit:crimson') || Profile.fuzz < 400 || Profile.level < 2);
});
await test('Bus wiring: a finished practice match pays out; quit and attract do not', async () => {
  const { Bus } = await import('../src/events.js');
  await Profile.reset();
  const match = { tbOnly: true, tb: true, fmtKey: 'tiebreak', games: [1, 0], pts: [7, 3], stats: { aces: [1, 0], df: [0, 0], winners: [2, 0], errors: [1, 2], points: [7, 3], longest: 5, fastest: [160, 0] } };
  const cfg = { mode: 'cpu', localIdx: 0, level: 'rookie', surface: 'hard', format: 'tiebreak', pros: ['custom', 'varga'], names: ['Me', 'Varga'] };
  Bus.emit('match:start', { cfg });
  Bus.emit('hit', { idx: 0, human: true, local: true, serve: false, tau: 0.1, kmh: 90 });
  Bus.emit('hit', { idx: 1, human: false, local: false, serve: false, tau: 0 });
  Bus.emit('match:end', { winner: 0, localIdx: 0, mode: 'cpu', cfg, stats: match.stats, match });
  assert.equal(Profile.stats.matches, 1); assert.equal(Progress.last.summary.score, '7–3'); assert.equal(Progress.last.summary.hits, 1);
  Bus.emit('match:start', { cfg }); Bus.emit('match:quit', {}); Bus.emit('match:end', { winner: 0, localIdx: 0, mode: 'cpu', cfg, stats: match.stats, match });
  Bus.emit('match:start', { cfg: { ...cfg, mode: 'attract', localIdx: -1 } }); Bus.emit('match:end', { winner: 0, localIdx: -1, mode: 'attract', cfg, stats: match.stats, match });
  assert.equal(Profile.stats.matches, 1);
});
clearTimeout(Profile.timer);
console.log(`${n} tests passed`);
process.exit(0);
