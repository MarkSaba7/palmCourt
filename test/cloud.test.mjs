// Cloud save + leaderboard checks (no browser, no real Supabase): the merge rules, config switches, disabled mode,
// network failure, and a full round trip against the local mock server (test/cloud-mock.mjs). Run: node test/cloud.test.mjs
import assert from 'node:assert/strict';
import { mergeSaves, stable, scoresFrom, cloudConfig, checkName, createCloud } from '../src/cloud.js';
import { normalize, freshData } from '../src/profile.js';
import { levelFor, xpToReach } from '../src/economy.js';
import { startMock, MOCK_KEY } from './cloud-mock.mjs';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok ', name); };
const save = (over = {}) => normalize({ ...freshData(), ...over });
const T0 = Date.UTC(2026, 8, 1);

// ---- merge ----
await test('merge keeps the higher XP, unions items and achievements, maxes stats', () => {
  const a = save({ created: T0, updated: T0 + 5000, xp: 900, owned: { 'out-a': T0 + 10, both: T0 + 50 }, achievements: { first_win: T0 + 20 }, stats: { ...freshData().stats, matches: 4, wins: 3, streak: 0, bestStreak: 3, fastestServe: 170, winsOn: { hard: 3 } } });
  const b = save({ created: T0 + 100, updated: T0 + 9000, xp: 400, owned: { 'rk-b': T0 + 30, both: T0 + 40 }, achievements: { serve_180: T0 + 60 }, stats: { ...freshData().stats, matches: 6, wins: 2, streak: 2, bestStreak: 2, fastestServe: 185, winsOn: { hard: 1, clay: 1 } } });
  const m = mergeSaves(a, b);
  assert.equal(m.xp, 900);
  assert.deepEqual(Object.keys(m.owned).sort(), ['both', 'out-a', 'rk-b']);
  assert.equal(m.owned.both, T0 + 40, 'earliest grant time');
  assert.deepEqual(Object.keys(m.achievements).sort(), ['first_win', 'serve_180']);
  assert.equal(m.stats.matches, 6); assert.equal(m.stats.wins, 3); assert.equal(m.stats.bestStreak, 3); assert.equal(m.stats.fastestServe, 185);
  assert.deepEqual(m.stats.winsOn, { hard: 3, clay: 1 });
  assert.equal(m.stats.streak, 2, 'current streak comes from the newer save');
  assert.equal(m.id, a.id, 'the older profile id is kept');
  assert.equal(m.updated, T0 + 9000);
});

await test('merge: Fuzz = most earned minus most spent (never loses earnings, never refunds purchases)', () => {
  const a = save({ updated: T0 + 2, fuzz: 600, stats: { ...freshData().stats, fuzzEarned: 1000 } });   // spent 400 here
  const b = save({ updated: T0 + 1, fuzz: 1500, stats: { ...freshData().stats, fuzzEarned: 1500 } });  // earned more there
  assert.equal(mergeSaves(a, b).fuzz, 1100);
  assert.equal(mergeSaves(b, a).fuzz, 1100);
  assert.equal(mergeSaves(a, b).stats.fuzzEarned, 1500);
  const old = save({ fuzz: 300, stats: { ...freshData().stats, fuzzEarned: 0 } });   // an old save without the counter
  assert.equal(mergeSaves(old, save()).fuzz, 300);
});

await test('merge: a fresh device never overrides a played profile', () => {
  const played = save({ created: T0, updated: T0 + 10, xp: 5000, equipped: { ...freshData().equipped, outfit: 'out-sunset' }, history: [{ t: T0 + 5, score: '6–3', opponent: 'varga' }], stats: { ...freshData().stats, matches: 1 } });
  const blank = save({ created: T0 + 99999, updated: T0 + 99999 });
  const m = mergeSaves(blank, played);
  assert.equal(m.xp, 5000); assert.equal(m.equipped.outfit, 'out-sunset'); assert.equal(m.id, played.id); assert.equal(m.history.length, 1);
});

await test('merge: history and ledger are unions (deduplicated, capped), daily and tour merge sensibly', () => {
  const h = (i) => ({ t: T0 + i * 1000, score: `${i}`, opponent: 'x' });
  const a = save({ updated: T0 + 1, history: Array.from({ length: 40 }, (_, i) => h(i)), ledger: [{ t: 1, kind: 'xp', n: 5, why: 'a' }],
    daily: { date: '2026-09-27', ids: ['a', 'b', 'c'], progress: { a: 2 }, done: { a: 5 }, rerolled: false, lastWin: '2026-09-27' },
    tour: { v: 1, season: 1, week: 3, entries: [], trophies: [{ ev: 'palm-court', season: 1, t: 10 }], best: 420, history: [], played: {}, stats: { runs: 3 } } });
  const b = save({ updated: T0 + 2, history: Array.from({ length: 40 }, (_, i) => h(i + 20)), ledger: [{ t: 1, kind: 'xp', n: 5, why: 'a' }, { t: 2, kind: 'fuzz', n: 9, why: 'b' }],
    daily: { date: '2026-09-27', ids: ['a', 'b', 'd'], progress: { a: 1, d: 3 }, done: { d: 9 }, rerolled: true, lastWin: '' },
    tour: { v: 1, season: 1, week: 1, entries: [], trophies: [{ ev: 'coral-bay', season: 1, t: 20 }], best: 480, history: [], played: {}, stats: { runs: 1 } } });
  const m = mergeSaves(a, b);
  assert.equal(m.history.length, 50); assert.equal(m.history.at(-1).t, T0 + 59000); assert.equal(m.history[0].t, T0 + 10000);
  assert.equal(m.ledger.length, 2);
  assert.deepEqual(m.daily.ids, ['a', 'b', 'd']); assert.deepEqual(m.daily.done, { a: 5, d: 9 }); assert.equal(m.daily.progress.a, 2); assert.equal(m.daily.rerolled, true); assert.equal(m.daily.lastWin, '2026-09-27');
  assert.equal(m.tour.week, 3, 'the career further along wins'); assert.equal(m.tour.best, 420); assert.equal(m.tour.trophies.length, 2);
  const newer = mergeSaves(save({ daily: { date: '2026-09-28', ids: ['z'] } }), save({ daily: { date: '2026-09-27', ids: ['a'], done: { a: 1 } } }));
  assert.deepEqual(newer.daily.ids, ['z']);
});

await test('merge is idempotent and order-independent for progress', () => {
  const a = save({ created: T0, updated: T0 + 7, xp: 1234, fuzz: 50, owned: { x: 1 }, stats: { ...freshData().stats, fuzzEarned: 400, matches: 2 } });
  const b = save({ created: T0 + 1, updated: T0 + 9, xp: 99, fuzz: 10, owned: { y: 2 }, stats: { ...freshData().stats, fuzzEarned: 20, matches: 5 } });
  const ab = normalize(mergeSaves(a, b)), ba = normalize(mergeSaves(b, a));
  assert.equal(stable(normalize(mergeSaves(a, a))), stable(a));
  assert.equal(stable(normalize(mergeSaves(ab, b))), stable(ab));
  for (const k of ['xp', 'fuzz', 'id', 'owned', 'stats', 'created', 'updated']) assert.equal(stable(ab[k]), stable(ba[k]), k);
  assert.equal(stable({ b: 1, a: [1, { d: 2, c: 3 }] }), stable({ a: [1, { c: 3, d: 2 }], b: 1 }));
});

await test('scores come from the save', () => {
  const d = save({ xp: xpToReach(7) + 5, stats: { ...freshData().stats, bestStreak: 4, fastestServe: 187.6 }, tour: { v: 1, season: 1, week: 2, entries: [{ i: 1, pts: 25 }, { i: 0, pts: 8 }] } });
  assert.deepEqual(scoresFrom(d), { rating: 33, level: 7, streak: 4, serve: 187 });
  assert.equal(levelFor(0), 1);
  assert.deepEqual(scoresFrom(save()), { rating: 0, level: 1, streak: 0, serve: 0 });
});

// ---- config + names ----
await test('config: a player who turned online backup off in Settings stays off (unless ?cloud=1)', () => {
  const base = { url: 'https://abc.supabase.co', anonKey: 'sb_publishable_x', enabled: true };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => JSON.stringify({ cloudSync: false }) } });
  try {
    assert.equal(cloudConfig(base, '').enabled, false);
    assert.equal(cloudConfig(base, '?cloud=1').enabled, true);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => JSON.stringify({ cloudSync: true }) } });
    assert.equal(cloudConfig(base, '').enabled, true);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => 'not json' } });
    assert.equal(cloudConfig(base, '').enabled, true);
  } finally { if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage; }
});
await test('config: off by default, ?cloud=1 turns it on, only localhost mocks may replace the URL, secret keys refused', () => {
  const base = { url: 'https://abc.supabase.co', anonKey: 'sb_publishable_x', enabled: false };
  assert.equal(cloudConfig(base, '').enabled, false);
  assert.equal(cloudConfig({ ...base, enabled: true }, '?cloud=0').enabled, false);
  const on = cloudConfig(base, '?cloud=1&cloudUrl=http://127.0.0.1:8907');
  assert.equal(on.enabled, true); assert.equal(on.url, 'http://127.0.0.1:8907');
  assert.equal(cloudConfig(base, '?cloud=1&cloudUrl=https://evil.example').url, 'https://abc.supabase.co');
  assert.equal(cloudConfig(base, '?cloud=1&cloudUrl=http://localhost.evil.example').url, 'https://abc.supabase.co');
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(cloudConfig({ ...base, anonKey: 'sb_secret_abc', enabled: true }, '').enabled, false); } finally { console.warn = warn; }
  assert.equal(cloudConfig({ ...base, url: '' }, '?cloud=1').enabled, false);
});
await test('display names: trimmed, 3-16 characters, no emails or links', () => {
  assert.deepEqual(checkName('  Ace   Ventura '), { ok: true, name: 'Ace Ventura' });
  assert.equal(checkName('ab').ok, false); assert.equal(checkName('x'.repeat(17)).ok, false);
  assert.equal(checkName('me@mail.com').ok, false); assert.equal(checkName('site.com').ok, false); assert.equal(checkName('0123456789').ok, false);
  assert.equal(checkName('Zoë_Ångström').ok, true);
});

// ---- a fake Profile (the real one is a singleton) ----
function fakeProfile(data = save()) {
  const ls = new Map();
  return { data, ready: Promise.resolve(), saves: 0, events: [], get level() { return levelFor(this.data.xp); }, on(e, fn) { if (!ls.has(e)) ls.set(e, []); ls.get(e).push(fn); }, emit(e, d) { this.events.push(e); for (const fn of ls.get(e) || []) fn(d); }, save() { this.saves++; return Promise.resolve(); } };
}
const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

await test('disabled: every call is a quiet no-op and the network is never touched', async () => {
  let calls = 0;
  const P = fakeProfile(), c = createCloud({ config: { url: 'https://abc.supabase.co', anonKey: 'k', enabled: false }, profile: P, fetch: () => { calls++; throw new Error('no'); }, storage: memStore() });
  assert.equal(c.enabled, false); assert.equal(c.status, 'off');
  assert.deepEqual(await c.sync(), { ok: false, reason: 'disabled' });
  assert.equal(await c.signIn(), null); assert.equal(await c.leaderboard('level'), null); assert.equal(await c.submit('level', 5), null);
  assert.equal((await c.setDisplayName('Someone')).ok, false);
  assert.equal(await c.start(), false);
  P.emit('change'); P.emit('reward', {});
  assert.equal(c.timer, 0); assert.equal(calls, 0);
});

await test('network failure: sync resolves with ok:false fast, the local save is untouched', async () => {
  const P = fakeProfile(save({ xp: 500 })), before = stable(P.data), warn = console.warn;
  const c = createCloud({ config: { url: 'https://abc.supabase.co', anonKey: 'k', enabled: true }, profile: P, fetch: async () => { throw new TypeError('Failed to fetch'); }, storage: memStore() });
  console.warn = () => {};
  try {
    const t = Date.now(), r = await c.sync();
    assert.equal(r.ok, false); assert.ok(Date.now() - t < 1000);
    assert.equal(await c.leaderboard('level'), null); assert.equal(await c.submit('level', 3), null);
    assert.equal((await c.setDisplayName('Valid Name')).ok, false);
  } finally { console.warn = warn; }
  assert.equal(stable(P.data), before); assert.equal(P.saves, 0);
});

// ---- round trip against the mock server ----
const mock = await startMock();
try {
  const cfg = { url: mock.url, anonKey: MOCK_KEY, enabled: true };
  const A = fakeProfile(save({ created: T0, updated: T0 + 1000, xp: xpToReach(6) + 10, fuzz: 700, owned: { 'out-a': 5 }, stats: { ...freshData().stats, fuzzEarned: 900, matches: 5, wins: 4, bestStreak: 3, fastestServe: 181 } }));
  const storeA = memStore(), cA = createCloud({ config: cfg, profile: A, storage: storeA });
  let sid;
  await test('mock: anonymous sign-in, first sync pushes the save and submits scores', async () => {
    const r = await cA.sync();
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.pushed, true); assert.equal(r.pulled, false);
    sid = cA.userId; assert.ok(sid);
    assert.equal(mock.state.saves.get(sid).save.xp, A.data.xp);
    assert.deepEqual(Object.keys(r.submitted).sort(), ['level', 'serve', 'streak']);
    assert.ok(JSON.parse(storeA.getItem([...storeA.m.keys()].find((k) => k.includes('session')))).refresh_token, 'session stored');
    const again = await cA.sync();
    assert.equal(again.pushed, false); assert.deepEqual(again.submitted, {}, 'nothing new to send');
  });
  await test('mock: a second device with the same session pulls and merges without losing either side', async () => {
    const B = fakeProfile(save({ created: T0 + 50, updated: T0 + 99999, xp: 100, fuzz: 40, owned: { 'rk-b': 7 }, stats: { ...freshData().stats, fuzzEarned: 40, matches: 1, bestStreak: 1 } }));
    const storeB = memStore();
    for (const [k, v] of storeA.m) storeB.setItem(k, v);   // same account (as if the save was linked)
    const cB = createCloud({ config: cfg, profile: B, storage: storeB });
    const r = await cB.sync();
    assert.equal(r.ok, true); assert.equal(r.pulled, true); assert.equal(r.pushed, true);
    assert.equal(B.data.xp, A.data.xp); assert.ok(B.data.owned['out-a'] && B.data.owned['rk-b']); assert.equal(B.data.stats.matches, 5);
    assert.equal(B.data.fuzz, 700, 'most earned (900) minus most spent (200)');
    assert.ok(B.events.includes('change')); assert.ok(B.saves > 0);
    const rA = await cA.sync();
    assert.equal(rA.pulled, true); assert.ok(A.data.owned['rk-b']);
  });
  await test('mock: leaderboards, your row, display names', async () => {
    const other = createCloud({ config: cfg, profile: fakeProfile(save({ xp: xpToReach(9), stats: { ...freshData().stats, bestStreak: 8 } })), storage: memStore() });
    await other.sync();
    const lb = await cA.leaderboard('level');
    assert.equal(lb.rows.length, 2); assert.equal(lb.rows[0].value, 9); assert.equal(lb.me.place, 2); assert.equal(lb.me.value, 6);
    assert.equal((await cA.setDisplayName('  Court   Queen ')).name, 'Court Queen');
    assert.equal((await cA.setDisplayName('fuckface')).ok, false);
    assert.equal((await cA.leaderboard('level', { period: 'season' })).me.name, 'Court Queen');
    const anon = createCloud({ config: { ...cfg }, profile: fakeProfile(), storage: memStore() });
    mock.state.anonDisabled = true;
    const warn = console.warn; console.warn = () => {};
    try { const pub = await anon.leaderboard('streak'); assert.equal(pub.rows[0].value, 8); assert.equal(pub.me, null, 'signed-out visitors can read boards'); }
    finally { console.warn = warn; mock.state.anonDisabled = false; }
    console.warn = () => {};
    try { assert.equal(await cA.submit('level', 99), null, 'impossible values are rejected'); assert.equal(await cA.submit('rating', 99999), null); } finally { console.warn = warn; }
    const clamp = await cA.submit('serve', 290);
    assert.equal(clamp.accepted, 250); assert.equal(clamp.clamped, true);
  });
  await test('mock: expired tokens refresh, a lost refresh token signs in again', async () => {
    const old = cA.session.access_token;
    cA.session.expires_at = 0;
    assert.equal((await cA.sync()).ok, true); assert.notEqual(cA.session.access_token, old); assert.equal(cA.userId, sid);
    mock.state.tokens.clear();   // server forgot the access token: 401 -> refresh -> retry
    cA.session.expires_at = Math.floor(Date.now() / 1000) + 3600;
    assert.equal((await cA.sync()).ok, true); assert.equal(cA.userId, sid);
    mock.state.tokens.clear(); mock.state.refresh.clear(); cA.session.expires_at = 0;
    const r = await cA.sync();
    assert.equal(r.ok, true); assert.notEqual(cA.userId, sid, 'a new anonymous player'); assert.equal(mock.state.saves.get(cA.userId).save.xp, A.data.xp, 'local progress pushed to it');
  });
  await test('mock: server down -> ok:false, then recovers', async () => {
    mock.state.fail = true;
    const r = await cA.sync();
    assert.equal(r.ok, false); assert.equal(cA.status, 'error');
    mock.state.fail = false;
    assert.equal((await cA.sync()).ok, true); assert.equal(cA.status, 'ok');
  });
  await test('mock: auto-sync after a match reward (debounced)', async () => {
    cA.start({ delay: 0 }); await cA.ready; cA.lastSync = 0;
    const before = mock.state.calls.length;
    A.data.xp += 50; A.emit('change'); A.emit('change'); A.emit('reward', {});
    assert.ok(cA.timer, 'scheduled');
    await new Promise((r) => setTimeout(r, Math.max(2600, cA.lastSync + 10000 - Date.now() + 100)));
    await (cA.syncing || Promise.resolve());
    assert.equal(mock.state.saves.get(cA.userId).save.xp, A.data.xp);
    assert.ok(mock.state.calls.length - before <= 4, `one sync, not one per event (${mock.state.calls.length - before} calls)`);
    clearTimeout(cA.timer);
  });
} finally { await mock.close(); }
console.log(`${n} tests passed`);
