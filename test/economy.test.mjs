// Economy checks (no browser): XP curve, match rewards, catalog + unlocks, daily challenges, achievements, balance.
// Run: node test/economy.test.mjs
import assert from 'node:assert/strict';
import * as E from '../src/economy.js';
import { PROS } from '../src/pros.js';
import { simulate } from './balance.mjs';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };
// A stand-in profile for the unlock lookups.
const fake = (level = 1, fuzz = 0, owned = {}) => ({ level, fuzz, stats: {}, owns: (id) => !!owned[id], spend(n) { if (this.fuzz < n) return false; this.fuzz -= n; return true; }, grant: (id) => { owned[id] = 1; }, save() {} });
const S = (o = {}) => ({ mode: 'cpu', won: true, format: 'short', level: 'club', points: 24, pointsLost: 18, aces: 2, doubleFaults: 1, winners: 5, errors: 6, longestRally: 11, cleanHits: 0, onTime: 10, fastestServe: 170, surface: 'hard', tod: 'day', ...o });

await test('curve: levels 1-50, increasing spans, levelFor inverts xpToReach', () => {
  assert.equal(E.MAX_LEVEL, 50);
  assert.equal(E.xpToReach(1), 0);
  assert.equal(E.xpForLevel(50), 0);
  for (let l = 1; l < 50; l++) {
    assert.ok(E.xpForLevel(l) > 0 && E.xpForLevel(l) % 10 === 0);
    if (l > 1) assert.ok(E.xpForLevel(l) >= E.xpForLevel(l - 1), `span ${l}`);
    assert.equal(E.xpToReach(l + 1) - E.xpToReach(l), E.xpForLevel(l));
    assert.equal(E.levelFor(E.xpToReach(l)), l);
    assert.equal(E.levelFor(E.xpToReach(l + 1) - 1), l);
  }
  assert.equal(E.levelFor(0), 1);
  assert.equal(E.levelFor(1e9), 50);
});
await test('curve: about two matches to level 2', () => {
  const win = E.rewardsFor(S({ level: 'rookie' }), { firstWinToday: true }).xp, loss = E.rewardsFor(S({ won: false, level: 'rookie', points: 16 })).xp;
  assert.ok(win < E.xpForLevel(1), 'one win (even the first of the day) is not enough');
  assert.ok(win + loss >= E.xpForLevel(1) * 0.9, 'a win and a loss about get there (first-match achievements do the rest)');
});
await test('rewards: itemised lines add up; win > loss; multipliers and caps', () => {
  const r = E.rewardsFor(S(), { firstWinToday: true });
  assert.equal(r.xp, r.lines.reduce((a, l) => a + l.xp, 0));
  assert.equal(r.fuzz, r.lines.reduce((a, l) => a + l.fuzz, 0));
  const labels = r.lines.map((l) => l.label).join('|');
  for (const k of ['Victory', 'Points won ×24', 'Aces ×2', 'Winners ×5', 'Longest rally: 11 shots', 'Club CPU ×1.25', 'First win of the day']) assert.ok(labels.includes(k), k);
  assert.ok(!labels.includes('Clean timing'), 'no clean hits, no line');
  assert.ok(E.rewardsFor(S()).xp > E.rewardsFor(S({ won: false })).xp);
  assert.ok(E.rewardsFor(S({ level: 'pro' })).xp > E.rewardsFor(S({ level: 'club' })).xp && E.rewardsFor(S({ level: 'club' })).xp > E.rewardsFor(S({ level: 'rookie' })).xp);
  assert.equal(E.rewardsFor(S({ won: false }), { firstWinToday: true }).lines.some((l) => /First win/.test(l.label)), false, 'first-win bonus needs a win');
  assert.ok(E.rewardsFor(S({ format: 'tiebreak' })).xp < E.rewardsFor(S()).xp && E.rewardsFor(S({ format: 'full' })).xp > E.rewardsFor(S()).xp);
  const clean = E.rewardsFor(S({ cleanHits: 12 }));
  assert.ok(clean.lines.some((l) => l.label === 'Clean timing ×12' && l.xp === 12 && l.fuzz === 12));
  const big = E.rewardsFor(S({ points: 1e6, aces: 1e6, winners: 1e6, cleanHits: 1e6, longestRally: 1e6 })), capped = E.rewardsFor(S({ points: 150, aces: 40, winners: 80, cleanHits: 40, longestRally: 25 }));
  assert.deepEqual([big.xp, big.fuzz], [capped.xp, capped.fuzz], 'caps');
  const junk = E.rewardsFor({ won: false, points: NaN, aces: -3, winners: 'x' });
  assert.ok(junk.xp > 0 && Number.isInteger(junk.xp) && Number.isInteger(junk.fuzz), 'junk input still pays the base');
  assert.ok(/Online match/.test(E.rewardsFor(S({ mode: 'online', level: null })).lines.map((l) => l.label).join()));
  assert.equal(E.fmtFuzz(1250), '1,250 Fuzz');
});
await test('catalog: unique ids, contract fields, 40+ cosmetics, pros/surfaces/times per the design', () => {
  const ids = E.CATALOG.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const i of E.CATALOG) {
    for (const k of ['id', 'kind', 'name', 'price', 'level', 'preview']) assert.ok(i[k] !== undefined, `${i.id}.${k}`);
    assert.ok(['free', 'level', 'buy', 'level-or-buy', 'earn'].includes(i.how), i.id);
    if (i.how === 'buy' || i.how === 'level-or-buy') assert.ok(i.price > 0, `${i.id} price`);
  }
  const cos = E.CATALOG.filter((i) => ['outfit', 'racket', 'headwear', 'band', 'celebration'].includes(i.kind));
  assert.ok(cos.length >= 40, `${cos.length} cosmetics`);
  for (const slot of E.SLOTS) assert.ok(E.CATALOG.some((i) => i.kind === slot), slot);
  for (const i of E.CATALOG.filter((x) => x.kind === 'outfit')) for (const k of ['shirt', 'pants', 'shoe', 'accent', 'design']) assert.ok(Number.isFinite(i.preview.kit[k]), `${i.id}.${k}`);
  for (const i of E.CATALOG.filter((x) => x.kind === 'headwear')) assert.ok(['none', 'headband', 'bandana', 'cap'].includes(i.preview.look.headwear));
  for (const i of E.CATALOG.filter((x) => x.kind === 'celebration')) assert.ok(['fist', 'vamos', 'heart', 'arms', 'calm'].includes(i.preview.style.celebrate));
  assert.deepEqual(E.CATALOG.filter((i) => i.kind === 'pro').map((i) => i.key).sort(), PROS.map((p) => p.id).sort(), 'every roster id');
  const p1 = fake(1);
  assert.deepEqual(PROS.map((p) => p.id).filter((id) => E.isUnlocked(`pro:${id}`, p1)).length, 2, 'custom + 1 pro free');
  assert.ok(E.isUnlocked('hard', p1) && !E.isUnlocked('clay', p1) && E.isUnlocked('clay', fake(3)) && !E.isUnlocked('grass', fake(5)) && E.isUnlocked('grass', fake(6)));
  assert.ok(E.isUnlocked('tod:day', p1) && !E.isUnlocked('tod:golden', fake(3)) && E.isUnlocked('tod:golden', fake(4)) && !E.isUnlocked('night', fake(7)) && E.isUnlocked('night', fake(8)));
  assert.ok(E.isUnlocked('random', p1), 'ungated ids are open');
  for (const a of E.ACHIEVEMENTS.filter((x) => x.title)) assert.equal(E.itemById(a.title)?.kind, 'title', a.title);
});
await test('shop: canBuy / buy / level-or-buy pros / lookFor', () => {
  const p = fake(1, 5000);
  assert.equal(E.canBuy('outfit:crimson', p).reason, 'level');
  assert.equal(E.canBuy('outfit:classic', p).reason, 'owned');
  assert.equal(E.canBuy('surface:clay', p).reason, 'not-for-sale');
  assert.ok(E.canBuy('pro:rivas', p).ok, 'a pro can be bought before its level');
  assert.ok(E.buy('pro:rivas', p) && p.fuzz === 4000 && E.isUnlocked('pro:rivas', p));
  assert.equal(E.buy('pro:rivas', p), false, 'not twice');
  const q = fake(30, 100);
  assert.equal(E.canBuy('outfit:gold', q).reason, 'fuzz');
  assert.ok(E.isUnlocked('pro:aranda', fake(20)) && !E.isUnlocked('pro:aranda', fake(19)));
  assert.equal(E.unlockHint('grass'), 'Level 6');
  assert.equal(E.unlockHint('pro:adler'), 'Level 10 or 2,000 Fuzz');
  const L = E.lookFor({ outfit: 'outfit:navy', racket: 'racket:jade', headwear: 'headwear:cap-white', band: 'band:red', celebration: 'celebration:vamos', title: 'title:rookie' });
  assert.equal(L.kit.shirt, 0x1d2b44); assert.equal(L.look.headwear, 'cap'); assert.equal(L.kit.band, 0xf2f5ee, 'headwear colour wins');
  assert.equal(L.look.wristband, true); assert.equal(L.style.celebrate, 'vamos'); assert.equal(L.racket.frame, 0x2e8a6a);
  assert.deepEqual(E.lookFor({ outfit: 'racket:jade' }).kit, {}, 'wrong slot ignored');
  assert.ok(E.unlocksAtLevel(6).some((i) => i.id === 'surface:grass'));
});
await test('daily challenges: 3 distinct, seeded by date, level-filtered, one seeded reroll', () => {
  const a = E.dailyChallenges('2026-09-26'), b = E.dailyChallenges('2026-09-26');
  assert.equal(a.length, 3); assert.equal(new Set(a.map((c) => c.id)).size, 3);
  assert.deepEqual(a.map((c) => c.id), b.map((c) => c.id), 'same day, same challenges');
  const days = new Set(Array.from({ length: 20 }, (_, i) => E.dailyChallenges(`2026-10-${String(i + 1).padStart(2, '0')}`).map((c) => c.id).join()));
  assert.ok(days.size >= 15, 'different days differ');
  for (let i = 0; i < 40; i++) for (const c of E.dailyChallenges(`2027-01-${i}`, 1)) assert.ok((c.minLevel || 1) <= 1, `${c.id} is too advanced for level 1`);
  const ids = a.map((c) => c.id), r = E.rerollChallenge('2026-09-26', 1, ids);
  assert.ok(r && !ids.includes(r.id)); assert.equal(E.rerollChallenge('2026-09-26', 1, ids).id, r.id);
  const pts = E.challengeById('points40'), rally = E.challengeById('rally10');
  assert.equal(E.challengeStep(pts, 30, { points: 25 }), 40, 'counters add up and stop at the goal');
  assert.equal(E.challengeStep(rally, 7, { longestRally: 5 }), 7, 'max challenges keep the best match');
  for (const c of E.CHALLENGES) assert.ok(c.goal > 0 && c.xp > 0 && c.fuzz > 0 && typeof c.count === 'function' && c.text, c.id);
  assert.match(E.utcDay(Date.UTC(2026, 8, 26, 23, 59)), /^2026-09-26$/);
});
await test('achievements: ~30+, unique, counters and one-match tests', () => {
  assert.ok(E.ACHIEVEMENTS.length >= 30, `${E.ACHIEVEMENTS.length}`);
  assert.equal(new Set(E.ACHIEVEMENTS.map((a) => a.id)).size, E.ACHIEVEMENTS.length);
  const st = E.newStats();
  assert.deepEqual(E.checkAchievements(st, null, {}, 1).map((a) => a.id), []);
  E.recordMatch(st, S({ aces: 6, opponent: 'varga', surface: 'clay' }));
  const got = E.checkAchievements(st, S({ aces: 6 }), {}, 1).map((a) => a.id);
  for (const id of ['first_match', 'first_win', 'ace_1', 'aces_match_5', 'win_club', 'win_clay']) assert.ok(got.includes(id), id);
  assert.ok(!got.includes('win_pro') && !got.includes('beat_all'));
  assert.ok(!E.checkAchievements(st, S(), { first_match: 1 }, 1).some((a) => a.id === 'first_match'), 'earned ones stay earned');
  assert.ok(E.checkAchievements(st, null, {}, 10).some((a) => a.id === 'level_10'));
  for (const id of ['varga', 'rivas', 'adler', 'ferro', 'aranda']) E.recordMatch(st, S({ opponent: id }));
  assert.ok(E.checkAchievements(st, null, {}, 1).some((a) => a.id === 'beat_all'));
  assert.equal(st.bestStreak, 6); E.recordMatch(st, S({ won: false })); assert.equal(st.streak, 0); assert.equal(st.bestStreak, 6);
  E.recordMatch(st, S({ games: [4, 0] }));
  assert.equal(st.bagels, 1);
  assert.deepEqual(E.achievementProgress(E.ACHIEVEMENTS.find((a) => a.id === 'wins_10'), st), { value: 7, goal: 10 });
});
await test('balance: level 30 after ~6-8 h of play; pros reachable by level or Fuzz', async () => {
  const r = await simulate({ hours: 12, perDay: 1.5 });
  assert.ok(r.hoursTo.L2 <= 0.35, `L2 at ${r.hoursTo.L2} h`);
  assert.ok(r.hoursTo.L30 >= 5 && r.hoursTo.L30 <= 8.5, `L30 at ${r.hoursTo.L30} h`);
  assert.ok(r.hoursTo.aranda <= 6, `last pro at ${r.hoursTo.aranda} h`);
});
console.log(`${n} tests passed`);
process.exit(0);
