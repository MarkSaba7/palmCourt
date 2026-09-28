// Gear economy checks (no browser): the gear catalog, buying + equipping + upgrading through the Profile, the save
// migration to schema 3 (starter gear, nothing lost), and the grind curve (hours of play to each gear tier, with the
// real reward pipeline). Run: node test/gear.test.mjs
import assert from 'node:assert/strict';
import * as E from '../src/economy.js';
import { Profile, normalize, freshData, SCHEMA, MIGRATIONS } from '../src/profile.js';
import { simulateGear, gearTotals } from './grind.mjs';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const gear = E.CATALOG.filter(E.isGear);

await test('catalog: 5 gear slots, a starter item each (free), every tier, prices and levels rise with the tier', () => {
  assert.deepEqual(E.GEAR_SLOTS, ['frame', 'strings', 'shoes', 'grip', 'dampener']);
  assert.deepEqual(E.GEAR_TIERS.map((t) => t.key), ['starter', 'club', 'pro', 'elite', 'legend']);
  for (const s of E.GEAR_SLOTS) {
    const items = gear.filter((i) => i.kind === s);
    for (const t of E.GEAR_TIERS) assert.ok(items.some((i) => i.tier === t.key), `${s} has a ${t.key} item`);
    assert.equal(items.filter((i) => i.tier === 'starter').length, 1);
    assert.equal(E.STARTER_GEAR[s], items.find((i) => i.tier === 'starter').id);
  }
  for (const i of gear) {
    assert.ok(i.tier === 'starter' ? i.how === 'free' && i.price === 0 && !Object.keys(i.stats).length : i.how === 'buy' && i.price > 0, i.id);
    assert.ok(i.blurb && i.name, i.id);
    for (const k of Object.keys(i.stats)) assert.ok(['pow', 'ctl', 'spin', 'serve', 'volley', 'touch', 'speed', 'react', 'reach'].includes(k), `${i.id}.${k}`);
    assert.ok(!E.SLOTS.includes(i.kind), 'gear slots are not cosmetic slots');
  }
  const band = (t) => gear.filter((i) => i.tier === t);
  for (let k = 1; k < E.GEAR_TIERS.length - 1; k++) {
    const a = band(E.GEAR_TIERS[k].key), b = band(E.GEAR_TIERS[k + 1].key);
    assert.ok(Math.max(...a.map((i) => i.price)) < Math.min(...b.map((i) => i.price)), 'prices rise by tier');
    assert.ok(Math.max(...a.map((i) => i.level)) < Math.min(...b.map((i) => i.level)), 'levels rise by tier');
  }
  assert.ok(band('club').every((i) => i.level <= 5), 'Club gear from level 3-5');
  assert.ok(band('legend').every((i) => i.level >= 40), 'Legend gear is late');
  assert.equal(E.CATALOG.filter((i) => i.kind === 'racket').length, 9, 'racket paints stay cosmetics');
});
await test('buy, equip, upgrade: level and Fuzz gates, +1..+5, costs rising, the Profile keeps it', async () => {
  await Profile.ready;
  Profile.data = freshData();
  assert.deepEqual(Object.fromEntries(E.GEAR_SLOTS.map((s) => [s, Profile.equipped[s]])), E.STARTER_GEAR);
  assert.equal(E.canBuy('frame:driver').reason, 'level');
  assert.equal(Profile.equip('frame', 'frame:driver'), false, 'not owned');
  Profile.addXP(E.xpToReach(3));
  assert.equal(E.canBuy('frame:driver').reason, 'fuzz');
  Profile.addFuzz(5000);
  assert.ok(E.buy('frame:driver'));
  assert.equal(Profile.fuzz, 4500);
  assert.ok(Profile.equip('frame', 'frame:driver'));
  assert.equal(Profile.equipped.frame, 'frame:driver');
  assert.equal(E.canUpgrade('frame:rally').reason, 'starter');
  assert.equal(E.canUpgrade('frame:scalpel').reason, 'locked');
  const costs = [1, 2, 3, 4, 5].map((k) => E.upgradeCost('frame:driver', k));
  assert.ok(costs.every((c, k) => c > 0 && (!k || c > costs[k - 1])), `rising ${costs}`);
  const total = costs.reduce((a, c) => a + c, 0);
  assert.ok(Math.abs(total - 1.25 * 500) <= 25, `+1..+5 about 1.25x the price (${total})`);
  for (let k = 1; k <= 5; k++) { assert.ok(E.upgrade('frame:driver'), `+${k}`); assert.equal(E.upgradeOf('frame:driver'), k); }
  assert.equal(E.canUpgrade('frame:driver').reason, 'max');
  assert.equal(E.upgrade('frame:driver'), false);
  assert.equal(Profile.fuzz, 4500 - total);
  assert.deepEqual(Profile.upgrades, { 'frame:driver': 5 });
  assert.ok(Profile.equip('frame', null) && Profile.equipped.frame === 'frame:rally', 'null = the starter item');
  Profile.data.fuzz = 10; assert.equal(E.canUpgrade('frame:driver').reason, 'max');
  clearTimeout(Profile.timer);
});
await test('save migration v2 -> v3: starter gear equipped; Fuzz, XP, items, cosmetics, stats kept; bad gear ids repaired', () => {
  assert.equal(SCHEMA, 3);
  const v2 = { v: 2, id: 'abc', created: 5, updated: 9, xp: 12345, fuzz: 6789, owned: { 'outfit:crimson': 1, 'pro:rivas': 2 }, equipped: { outfit: 'outfit:crimson', racket: 'racket:optic', headwear: null, band: null, celebration: 'celebration:calm', title: null },
    stats: { matches: 40, wins: 22 }, history: [{ t: 1 }], ledger: [], daily: { date: '2026-09-27' }, achievements: { first_win: 3 }, seen: { level: 9 }, tour: { v: 1, week: 3 } };
  const d = normalize(JSON.parse(JSON.stringify(v2)));
  assert.equal(d.v, 3);
  assert.equal(d.xp, 12345); assert.equal(d.fuzz, 6789);
  assert.deepEqual(d.owned, v2.owned); assert.deepEqual(d.achievements, v2.achievements); assert.equal(d.stats.wins, 22); assert.equal(d.history.length, 1); assert.deepEqual(d.tour, v2.tour);
  for (const s of E.SLOTS) assert.equal(d.equipped[s], v2.equipped[s], `cosmetic ${s} kept`);
  for (const s of E.GEAR_SLOTS) assert.equal(d.equipped[s], E.STARTER_GEAR[s], `gear ${s} = starter`);
  assert.deepEqual(d.upgrades, {});
  // Older saves go all the way through; a v3 save with junk gets repaired, not rejected.
  const v0 = normalize({ xp: 700, fuzz: 50, owned: ['outfit:navy'] });
  assert.equal(v0.v, 3); assert.equal(v0.equipped.shoes, 'shoes:trainers'); assert.ok(v0.owned['outfit:navy'] !== undefined);
  const bad = normalize({ ...d, equipped: { ...d.equipped, frame: 'frame:nope', strings: 'outfit:crimson' }, upgrades: { 'frame:driver': 9, 'frame:cannon': -2, junk: 3, 'shoes:burst': '2' } });
  assert.equal(bad.equipped.frame, 'frame:rally'); assert.equal(bad.equipped.strings, 'strings:syngut');
  assert.deepEqual(bad.upgrades, { 'frame:driver': 5, 'shoes:burst': 2 });
  assert.equal(MIGRATIONS[2]({ v: 2, xp: 1, fuzz: 2 }).v, 3);
  const round = normalize(JSON.parse(JSON.stringify(d)));
  assert.deepEqual(round, d, 'a v3 save reloads unchanged');
});
await test('grind curve: Club in the first hour, a Pro kit in a few hours, Elite after many hours, Legend long-term', async () => {
  const r = await simulateGear({ hours: 130, perDay: 1.5 }), h = r.hoursTo, tot = await gearTotals();
  console.log(`   hours of play (all Fuzz on gear): Club ${h['first:club']}/${h['full:club']} · Pro ${h['first:pro']}/${h['full:pro']} · Elite ${h['first:elite']}/${h['full:elite']} · Legend ${h['first:legend']}/${h['full:legend']} (first item / full kit)`);
  assert.ok(h['first:club'] <= 0.75 && h['full:club'] <= 1.5, 'Club within the first hour');
  assert.ok(h['first:pro'] >= 1 && h['first:pro'] <= 3 && h['full:pro'] <= 8, 'Pro gear after an hour or two');
  assert.ok(h['first:elite'] >= 5 && h['first:elite'] <= 14 && h['full:elite'] >= 18 && h['full:elite'] <= 45, 'Elite after many hours');
  assert.ok(h['first:legend'] >= 25 && h['full:legend'] >= 70, 'Legend is a long-term goal');
  const rate = r.fuzzEarned / 130;
  assert.ok((tot.price + tot.upgrades) / rate > 250, 'every item fully upgraded is a very long sink');
  clearTimeout(Profile.timer);
});
console.log(`${n} gear tests passed`);
process.exit(0);
