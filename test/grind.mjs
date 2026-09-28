// Gear grind simulation: plays modelled matches (test/balance.mjs's model) through the real reward pipeline and spends
// the Fuzz on gear as soon as a better tier is affordable, to show how many hours of play each gear tier takes.
// Run: node test/grind.mjs [hoursPerDay=1.5]   (test/gear.test.mjs asserts the curve)
import { modelMatch, mulberry } from './balance.mjs';

// strategy 'tiers': every Fuzz goes to the next gear tier (no upgrades, no cosmetics): the fastest route up.
// strategy 'upgrades': the same, then upgrades on what's equipped while the next tier is still locked by level.
export async function simulateGear({ hours = 60, perDay = 1.5, seed = 7, strategy = 'tiers' } = {}) {
  const { Profile, freshData } = await import('../src/profile.js');
  const { Progress } = await import('../src/progress.js');
  const E = await import('../src/economy.js');
  await Profile.ready;
  Profile.data = freshData();
  const r = mulberry(seed), realNow = Date.now, t0 = Date.UTC(2026, 8, 1, 12), T = E.GEAR_TIERS.map((t) => t.key);
  let played = 0, matches = 0, spent = 0;
  const hoursTo = {}, mark = (k) => { if (hoursTo[k] == null) hoursTo[k] = +(played / 60).toFixed(2); };
  const tierOf = (slot) => E.tierIndex(E.itemById(Profile.equipped[slot]).tier), score = (i) => Object.values(i.stats).reduce((a, v) => a + v, 0);
  try {
    while (played < hours * 60) {
      const dayN = Math.floor(played / 60 / perDay);
      Date.now = () => t0 + dayN * 86400000 + (played % (perDay * 60)) * 60000;
      const m = modelMatch(r, Profile.level, 'mouse', Profile.level);
      Progress.applyMatch(m.summary);
      played += m.minutes; matches++;
      // Buy the best next-tier item per slot (lowest slot tier first, so the kit climbs together).
      for (let pass = 0; pass < 5; pass++) {
        const slots = [...E.GEAR_SLOTS].sort((a, b) => tierOf(a) - tierOf(b));
        let bought = false;
        for (const slot of slots) {
          const have = tierOf(slot), options = E.CATALOG.filter((i) => i.kind === slot && E.tierIndex(i.tier) > have && E.canBuy(i.id, Profile).ok);
          if (!options.length) continue;
          options.sort((a, b) => E.tierIndex(b.tier) - E.tierIndex(a.tier) || score(b) - score(a));
          const it = options[0];
          if (E.buy(it.id, Profile)) { Profile.equip(slot, it.id); spent += it.price; bought = true; }
        }
        if (!bought) break;
      }
      if (strategy === 'upgrades') {
        const next = (slot) => E.CATALOG.some((i) => i.kind === slot && E.tierIndex(i.tier) === tierOf(slot) + 1 && Profile.level >= i.level);
        for (const slot of E.GEAR_SLOTS) if (!next(slot)) { const c = E.canUpgrade(Profile.equipped[slot], Profile); if (c.ok && E.upgrade(Profile.equipped[slot], Profile)) spent += c.cost; }
      }
      for (let t = 1; t < T.length; t++) {
        const n = E.GEAR_SLOTS.filter((s) => tierOf(s) >= t).length;
        if (n >= 1) mark(`first:${T[t]}`);
        if (n === E.GEAR_SLOTS.length) mark(`full:${T[t]}`);
      }
      for (const l of [3, 5, 10, 25, 42, 50]) if (Profile.level >= l) mark(`L${l}`);
    }
  } finally { Date.now = realNow; clearTimeout(Profile.timer); }
  return { hoursTo, matches, spent, level: Profile.level, fuzzEarned: Profile.stats.fuzzEarned, equipped: { ...Profile.equipped }, upgrades: { ...Profile.upgrades } };
}
// All the gear and every upgrade, in Fuzz.
export async function gearTotals() {
  const E = await import('../src/economy.js'), gear = E.CATALOG.filter(E.isGear), up = (i) => [1, 2, 3, 4, 5].reduce((a, k) => a + E.upgradeCost(i.id, k), 0);
  const byTier = Object.fromEntries(E.GEAR_TIERS.map((t) => [t.key, gear.filter((i) => i.tier === t.key).reduce((a, i) => a + i.price, 0)]));
  return { items: gear.length, price: gear.reduce((a, i) => a + i.price, 0), upgrades: gear.reduce((a, i) => a + up(i), 0), byTier };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const perDay = +(process.argv[2] || 1.5);
  const a = await simulateGear({ hours: 150, perDay }), tot = await gearTotals(), rate = a.fuzzEarned / 150;
  const h = (k) => (a.hoursTo[k] != null ? `${a.hoursTo[k]} h` : '-');
  console.log(`Gear grind: ${perDay} h/day, every Fuzz on the next gear tier, 150 h of play (${a.matches} matches, ~${rate.toFixed(0)} Fuzz/h)`);
  for (const t of ['club', 'pro', 'elite', 'legend']) console.log(`  ${t.padEnd(7)} first item ${h(`first:${t}`).padEnd(8)} full kit (5 slots) ${h(`full:${t}`)}`);
  console.log(`  levels: L3 ${h('L3')} · L10 ${h('L10')} · L25 ${h('L25')} · L42 ${h('L42')} · L50 ${h('L50')}`);
  console.log(`  catalog: ${tot.items} gear items, ${tot.price.toLocaleString('en-US')} Fuzz to own all (${Object.entries(tot.byTier).map(([k, v]) => `${k} ${v.toLocaleString('en-US')}`).join(' · ')}), + ${tot.upgrades.toLocaleString('en-US')} to max every upgrade ≈ ${((tot.price + tot.upgrades) / rate).toFixed(0)} h of Fuzz`);
  process.exit(0);
}
