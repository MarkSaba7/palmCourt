// Economy balance simulation: plays out a season of modelled matches through the real reward pipeline (Progress.applyMatch
// -> Profile, with challenges and achievements) and prints hours of play to each level and unlock.
// Run: node test/balance.mjs [hoursPerDay=1.5] [control=mouse|hand]
// Model (from play-testing the match flow): a short set ~8 min / ~44 points, a tiebreak ~3 min, a full set ~13 min.

export function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const poisson = (r, lam) => { let k = 0, p = Math.exp(-lam), s = p; const u = r(); while (u > s && k < 60) { k++; p *= lam / k; s += p; } return k; };
const FMT = { short: { min: 8, pts: 44 }, tiebreak: { min: 3, pts: 12 }, full: { min: 13, pts: 70 } };

// A modelled player: picks CPU level as they get better, mostly short sets.
export function modelMatch(r, level, control, lvlUp) {
  const cpu = lvlUp < 6 ? 'rookie' : lvlUp < 18 ? 'club' : 'pro';
  const pWin = { rookie: 0.6, club: 0.48, pro: 0.35 }[cpu];
  const fmt = r() < 0.7 ? 'short' : r() < 0.67 ? 'tiebreak' : 'full', F = FMT[fmt];
  const won = r() < pWin, total = Math.round(F.pts * (0.8 + 0.4 * r())), share = won ? 0.54 + 0.06 * r() : 0.38 + 0.08 * r();
  const points = Math.round(total * share), k = F.pts / 44;
  const surface = ['hard', 'clay', 'grass'][Math.floor(r() * (level >= 6 ? 3 : level >= 3 ? 2 : 1))];
  const tod = ['day', 'golden', 'night'][Math.floor(r() * (level >= 8 ? 3 : level >= 4 ? 2 : 1))];
  const hits = Math.round(total * 2.2 * (0.8 + 0.4 * r())), onTime = Math.round(hits * (0.3 + 0.2 * r()));
  return {
    summary: {
      mode: 'cpu', won, score: '', games: won ? [4, Math.floor(r() * 3)] : [Math.floor(r() * 3), 4], level: cpu, surface, tod, format: fmt, opponent: ['varga', 'rivas', 'adler', 'ferro', 'aranda', 'custom'][Math.floor(r() * 6)],
      points, pointsLost: total - points, aces: poisson(r, 1.2 * k), doubleFaults: poisson(r, 1 * k), winners: poisson(r, 4 * k), errors: poisson(r, 8 * k),
      longestRally: 4 + Math.round(-Math.log(1 - r()) * 5 * Math.min(1.4, k)), hits, onTime, cleanHits: control === 'mouse' ? 0 : onTime,
      fastestServe: Math.round(150 + 45 * r()), durationS: F.min * 60, control,
    },
    minutes: F.min,
  };
}

// Plays `hours` of matches through the real pipeline; returns { level, fuzz, hoursTo: {L2.., pro:.., ...}, matches }.
export async function simulate({ hours = 30, perDay = 1.5, control = 'mouse', seed = 7, spendOnPros = false } = {}) {
  const { Profile } = await import('../src/profile.js');
  const { Progress } = await import('../src/progress.js');
  const E = await import('../src/economy.js');
  await Profile.ready;
  Profile.data = (await import('../src/profile.js')).freshData();
  const r = mulberry(seed), realNow = Date.now, t0 = Date.UTC(2026, 8, 1, 12);
  let played = 0, matches = 0, spent = 0;
  const hoursTo = {}, mark = (k) => { if (hoursTo[k] == null) hoursTo[k] = +(played / 60).toFixed(2); };
  try {
    while (played < hours * 60) {
      const dayN = Math.floor(played / 60 / perDay);
      Date.now = () => t0 + dayN * 86400000 + (played % (perDay * 60)) * 60000;   // one play session per UTC day
      const m = modelMatch(r, Profile.level, control, Profile.level);
      Progress.applyMatch(m.summary);
      played += m.minutes; matches++;
      for (const l of [2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 40, 50]) if (Profile.level >= l) mark(`L${l}`);
      for (const i of E.CATALOG) if (i.kind === 'pro' && E.isUnlocked(i.id, Profile)) mark(i.key);
      if (spendOnPros) for (const i of E.CATALOG) if (i.kind === 'pro' && E.canBuy(i.id, Profile).ok && E.buy(i.id, Profile)) { spent += i.price; mark(i.key); }
      if (Profile.stats.fuzzEarned >= 10000) mark('fuzz10k');
    }
  } finally { Date.now = realNow; clearTimeout(Profile.timer); }
  return { level: Profile.level, fuzzEarned: Profile.stats.fuzzEarned, fuzz: Profile.fuzz, hoursTo, matches, achievements: Object.keys(Profile.data.achievements).length, challenges: Profile.stats.challenges, spent };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const perDay = +(process.argv[2] || 1.5), control = process.argv[3] || 'mouse';
  const E = await import('../src/economy.js');
  const res = await simulate({ hours: 40, perDay, control });
  const buyer = await simulate({ hours: 40, perDay, control, spendOnPros: true, seed: 7 });
  const per = (res.fuzzEarned / 40).toFixed(0), cos = E.CATALOG.filter((i) => /outfit|racket|headwear|band|celebration/.test(i.kind));
  const cost = cos.reduce((a, i) => a + i.price, 0);
  console.log(`Balance: ${perDay} h/day, ${control} player, 40 h of play, ${res.matches} matches (${(res.matches / 40).toFixed(1)}/h)`);
  console.log(`  level ${res.level} after 40 h · ${res.fuzzEarned} Fuzz earned (~${per}/h) · ${res.achievements} achievements · ${res.challenges} challenges`);
  console.log('  hours to level:', Object.entries(res.hoursTo).filter(([k]) => /^L\d/.test(k)).map(([k, v]) => `${k} ${v}h`).join(' · '));
  console.log('  pros by level only:', ['rivas', 'adler', 'ferro', 'aranda'].map((k) => `${k} ${res.hoursTo[k] ?? '-'}h`).join(' · '));
  console.log('  pros buying with Fuzz asap:', ['rivas', 'adler', 'ferro', 'aranda'].map((k) => `${k} ${buyer.hoursTo[k] ?? '-'}h`).join(' · '));
  console.log('  surfaces: clay (L3) %sh, grass (L6) %sh · times: golden (L4) %sh, night (L8) %sh', res.hoursTo.L3, res.hoursTo.L6, res.hoursTo.L4, res.hoursTo.L8);
  console.log(`  cosmetics: ${cos.length} items, ${E.fmtFuzz(cost)} in all ≈ ${(cost / per).toFixed(0)} h of Fuzz`);
  for (const id of ['outfit:crimson', 'racket:optic', 'outfit:blackout', 'celebration:vamos', 'outfit:gold']) { const i = E.itemById(id); console.log(`    ${i.name}: L${i.level}, ${E.fmtFuzz(i.price)} ≈ ${(i.price / per).toFixed(1)} h of Fuzz`); }
  process.exit(0);
}
