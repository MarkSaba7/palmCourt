// Stats checks (no browser): pro profiles, gear stacking and upgrades, clamps, online neutral, CPU gear by level and
// tour strength. Run: node test/stats.test.mjs
import assert from 'node:assert/strict';
import { Stats, PATHS, PRO_BASE, NEUTRAL, STAT_MIN, STAT_MAX, get, build, cpuGear, summary, CPU_KIT } from '../src/stats.js';
import * as E from '../src/economy.js';
import { LEVELS, Settings } from '../src/core.js';
import { PROS } from '../src/pros.js';
import { cpuLevel } from '../src/tour.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const all = (S) => PATHS.map((p) => get(S, p));
const me = (pro, extra = {}) => ({ pro, ctl: 'human', level: LEVELS.club, ...extra });
const kit = (eq = {}, ups = {}) => ({ equipped: { ...E.STARTER_GEAR, ...eq }, upgrades: ups });

await test('contract shape: frozen, every path a number; custom + starter kit = 1.0 everywhere', () => {
  const S = build('custom', Stats.loadout(E.STARTER_GEAR));
  assert.ok(Object.isFrozen(S) && Object.isFrozen(S.fh) && Object.isFrozen(S.move));
  for (const k of ['fh', 'bh']) assert.deepEqual(Object.keys(S[k]), ['pow', 'ctl', 'spin']);
  assert.deepEqual(Object.keys(S.serve), ['pow', 'ctl']); assert.deepEqual(Object.keys(S.volley), ['ctl']); assert.deepEqual(Object.keys(S.move), ['speed', 'react']);
  assert.ok(Number.isFinite(S.touch) && Number.isFinite(S.reach));
  assert.ok(all(S).every((v) => v === 1), 'neutral');
  assert.deepEqual(all(NEUTRAL), all(S));
});
await test('pros: every roster pro has a profile with 1-2+ clear strengths and a weak spot; signatures as designed', () => {
  for (const p of PROS) assert.ok(PRO_BASE[p.id], p.id);
  for (const p of PROS.filter((x) => !x.custom)) {
    const S = Stats.forPro(p.id), v = all(S);
    assert.ok(Math.max(...v) >= 1.08, `${p.id} has a clear strength`);
    assert.ok(Math.min(...v) < 1 && Math.min(...v) >= 0.92, `${p.id} has a mild weakness`);
    assert.ok(v.every((x) => x >= STAT_MIN && x <= STAT_MAX));
  }
  const R = Stats.forPro('rivas'), A = Stats.forPro('adler'), V = Stats.forPro('varga'), F = Stats.forPro('ferro'), T = Stats.forPro('aranda');
  assert.ok(R.fh.spin > R.bh.spin && R.fh.pow > R.bh.pow && R.fh.ctl > R.bh.ctl, 'Rivas: a better forehand');
  assert.ok(A.bh.ctl > A.fh.ctl && A.bh.pow > A.fh.pow && A.serve.pow > 1 && A.volley.ctl > 1 && A.touch > 1, 'Adler: backhand, serve, volley, touch');
  assert.ok(V.move.react >= 1.08 && V.move.speed > 1 && V.reach > 1, 'Varga: defence and footwork');
  assert.ok(F.fh.pow >= 1.08 && F.bh.pow >= 1.08 && F.fh.spin < 1, 'Ferro: flat power off both wings');
  assert.ok(T.move.speed >= 1.06 && T.touch >= 1.1, 'Aranda: speed and drop shots');
  assert.equal(Stats.strengths('rivas')[0].key, 'fh.spin');
  assert.equal(Stats.strengths('adler')[0].key, 'bh.ctl');
  assert.ok(Stats.strengths('ferro').some((s) => s.v < 0), 'a weak spot is listed');
});
await test('gear stacks on the pro: pro base × (1 + gear deltas), upgrades grow strengths only', () => {
  const S = build('rivas', [{ id: 'frame:cannon', up: 0 }]);
  assert.equal(S.fh.pow, +(1.06 * 1.07).toFixed(4));
  assert.equal(S.bh.ctl, +(1 * 0.97).toFixed(4), 'a power frame costs control');
  assert.equal(S.serve.pow, +(0.96 * 1.09).toFixed(4), 'pow and serve both reach the serve');
  const U = build('rivas', [{ id: 'frame:cannon', up: 5 }]);
  assert.ok(U.fh.pow > S.fh.pow && U.bh.ctl === S.bh.ctl, 'upgrades: strengths up, costs unchanged');
  assert.equal(E.gearStats('frame:cannon', 5).pow, +(0.07 * (1 + 5 * E.UPGRADE_STEP)).toFixed(4));
  const two = build('custom', [{ id: 'frame:driver' }, { id: 'strings:multi' }]);
  assert.equal(two.fh.pow, +(1 + 0.04 + 0.02).toFixed(4), 'two items add their deltas');
  assert.equal(build('custom', [{ id: 'outfit:crimson' }, { id: 'nope' }]), build('custom', []), 'non-gear ids are ignored');
});
await test('clamps: no combination leaves 0.85-1.25; the best kit is +15-25 % at its extremes', () => {
  const legend = E.GEAR_SLOTS.map((s) => ({ id: E.CATALOG.find((i) => i.kind === s && i.tier === 'legend').id, up: 5 }));
  for (const pro of Object.keys(PRO_BASE)) for (const g of [legend, [{ id: 'frame:meteor', up: 5 }, { id: 'strings:silk', up: 5 }], [{ id: 'frame:tempest', up: 5 }, { id: 'shoes:anchor' }]]) {
    for (const v of all(build(pro, g))) assert.ok(v >= STAT_MIN && v <= STAT_MAX, `${pro} ${v}`);
  }
  assert.equal(build('ferro', [{ id: 'frame:meteor', up: 5 }, { id: 'strings:silk', up: 5 }]).fh.pow, STAT_MAX, 'clamped at the top');
  const top = Math.max(...all(build('custom', legend)));
  assert.ok(top >= 1.15 && top <= STAT_MAX, `best custom kit ${top}`);
  // Any single item moves any stat by at most ~20 % (fully upgraded), a cost by at most 4 %.
  for (const i of E.CATALOG.filter(E.isGear)) for (const v of Object.values(E.gearStats(i, 5))) assert.ok(v <= 0.2 && v >= -0.04, `${i.id} ${v}`);
});
await test('trade-offs, not a ladder: every Club+ tier has several items with different best stats, most with a cost', () => {
  for (const t of ['club', 'pro', 'elite']) {
    const items = E.CATALOG.filter((i) => i.tier === t);
    const best = new Set(items.map((i) => Object.entries(i.stats).sort((a, b) => b[1] - a[1])[0][0]));
    assert.ok(best.size >= 5, `${t}: ${[...best]}`);
    assert.ok(items.filter((i) => Object.values(i.stats).some((v) => v < 0)).length >= items.length * 0.7, `${t}: most items cost something`);
  }
  // A higher tier is better on its own strength, but not better at everything than the tier below.
  const cannon = E.gearStats('frame:cannon'), scalpel = E.gearStats('frame:scalpel');
  assert.ok(cannon.pow > 0.04 && cannon.ctl < scalpel.ctl);
});
await test('your gear: forPlayer reads the equipped kit + upgrades; the drill machine and a remote player are neutral-kit', () => {
  Stats.useProfile(kit({ frame: 'frame:cannon', shoes: 'shoes:stride' }, { 'frame:cannon': 3 }));
  Stats.begin({ mode: 'cpu' });
  const S = Stats.forPlayer(me('custom'));
  assert.equal(S, build('custom', [{ id: 'frame:cannon', up: 3 }, { id: 'strings:syngut' }, { id: 'shoes:stride' }, { id: 'grip:stock' }, { id: 'dampener:none' }]));
  assert.ok(S.fh.pow > 1 && S.move.speed > 1 && S.fh.ctl < 1);
  assert.equal(Stats.forPlayer(me('rivas')).fh.spin, Stats.forPro('rivas').fh.spin, 'pro base still there');
  assert.deepEqual(Stats.forPlayer({ pro: null, ctl: 'drill' }), NEUTRAL);
  assert.equal(Stats.forPlayer({ pro: 'varga', ctl: 'remote' }), Stats.forPro('varga'));
  assert.equal(Stats.forPlayer(null), NEUTRAL);
  const cmp = summary(Stats.preview('custom', { frame: 'frame:scalpel' })), now = summary(Stats.preview('custom'));
  assert.ok(cmp.ctl > now.ctl && cmp.pow < now.pow, 'preview for the shop compare');
});
await test('online is neutral by default; Settings.onlineGear turns gear (and pros) on', () => {
  Stats.begin({ mode: 'online' });
  const was = Settings.onlineGear;
  Settings.onlineGear = false;
  assert.equal(Stats.forPlayer(me('rivas')), NEUTRAL);
  assert.equal(Stats.forPlayer({ pro: 'ferro', ctl: 'remote' }), NEUTRAL);
  Settings.onlineGear = true;
  assert.ok(Stats.forPlayer(me('rivas')).fh.pow > 1);
  Settings.onlineGear = was;
  assert.equal(Stats.forPlayer(me('rivas'), { mode: 'cpu' }).fh.spin, Stats.forPlayer(me('rivas'), { mode: 'cpu', onlineGear: false }).fh.spin, 'practice ignores the setting');
  Stats.begin({ mode: 'cpu' });
});
await test('CPU gear: Rookie = starter, Club = club, Pro = pro; tour strengths add upgrades up to Elite; persona picks the item', () => {
  const tiers = (lv) => cpuGear(lv).map((g) => E.itemById(g.id).tier);
  assert.ok(tiers(LEVELS.rookie).every((t) => t === 'starter'));
  assert.ok(tiers(LEVELS.club).every((t) => t === 'club'));
  assert.ok(tiers(LEVELS.pro).every((t) => t === 'pro'));
  for (const [label, [tier, up]] of Object.entries(CPU_KIT)) for (const g of cpuGear({ label })) { assert.equal(E.itemById(g.id).tier, tier, label); assert.equal(g.up, tier === 'starter' ? 0 : up); }
  assert.ok(cpuGear(cpuLevel(1)).every((g) => E.itemById(g.id).tier === 'elite'), 'tour #1-level CPU: elite gear');
  assert.ok(cpuGear(cpuLevel(0)).every((g) => E.itemById(g.id).tier === 'starter'), 'tour #500: starter gear');
  const fast = cpuGear(LEVELS.pro, { speed: 1, defense: 0 }).find((g) => g.id.startsWith('shoes')), wall = cpuGear(LEVELS.pro, { speed: 0, defense: 1 }).find((g) => g.id.startsWith('shoes'));
  assert.notEqual(fast.id, wall.id, 'a fast CPU and a defender pick different shoes');
  // The ladder stays sane: each step is a few per cent, and no CPU is beyond what a player can own.
  const avg = (lv) => { const v = all(build('custom', cpuGear(lv))); return v.reduce((a, x) => a + x, 0) / v.length; };
  const r = avg(LEVELS.rookie), c = avg(LEVELS.club), p = avg(LEVELS.pro), e = avg(cpuLevel(1));
  assert.ok(r === 1 && c > r && p > c && e > p, `ladder ${r} ${c} ${p} ${e}`);
  assert.ok(p <= 1.08 && e <= 1.12, `pro ${p}, elite ${e}: a nudge, not a wall`);
  const cpu = { pro: 'rivas', ctl: 'cpu', level: LEVELS.pro, persona: PROS.find((x) => x.id === 'rivas').persona };
  assert.equal(Stats.forPlayer(cpu), build('rivas', cpuGear(LEVELS.pro, cpu.persona)), 'forPlayer uses the CPU kit');
});
console.log(`${n} stats tests passed`);
process.exit(0);
