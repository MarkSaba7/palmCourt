// Palm Court: the progression economy as data and pure functions (no DOM, runs in plain Node for the tests).
// XP curve and Player Level, match rewards, the unlock CATALOG (pros, surfaces, times of day, cosmetics, titles),
// Daily Challenges and Achievements. The Profile (profile.js) stores progress; progress.js wires both to the match.
// Currency is Fuzz (earned by playing, never sold).

export const MAX_LEVEL = 50;

// ---- XP curve ----
// XP to go from level l to l+1: flat early (about 2 matches for level 2, ~7 h of play for 30), steep towards 50.
export function xpForLevel(l) {
  if (!(l >= 1) || l >= MAX_LEVEL) return 0;
  return Math.round((600 + 0.015 * (l - 1) ** 3) / 10) * 10;
}
const REACH = [0, 0];
for (let l = 2; l <= MAX_LEVEL; l++) REACH[l] = REACH[l - 1] + xpForLevel(l - 1);
// Total XP needed to reach level l (xpToReach(1) = 0).
export const xpToReach = (l) => REACH[Math.max(1, Math.min(MAX_LEVEL, Math.floor(l) || 1))];
export function levelFor(xp) {
  let l = 1;
  while (l < MAX_LEVEL && xp >= REACH[l + 1]) l++;
  return l;
}

const nf = (n) => Math.round(n).toLocaleString('en-US');
export const fmtFuzz = (n) => `${nf(n || 0)} Fuzz`;
export const fmtXP = (n) => `${nf(n || 0)} XP`;
// Day key for daily things: the UTC date, 'YYYY-MM-DD'.
export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

// ---- the profile the lookups use (profile.js registers itself; tests pass their own) ----
let bound = null;
export function useProfile(p) { bound = p; }
// ?unlockAll=1 in the page URL unlocks everything (testing).
const unlockAll = () => { try { return new URLSearchParams(globalThis.location?.search || '').get('unlockAll') === '1'; } catch (e) { return false; } };

// ---- match rewards ----
// summary: { mode, won, score, level, surface, tod, format, opponent, points, pointsLost, aces, doubleFaults, winners,
// errors, longestRally, cleanHits, fastestServe, durationS, control, tour? } (see progress.js buildSummary).
export const DIFFICULTY = { rookie: 1, club: 1.25, pro: 1.6, online: 1.25 };
export const FORMAT_SCALE = { tiebreak: 0.35, short: 1, full: 1.6 };
export const REWARD = {
  win: [120, 60], loss: [60, 25],   // [xp, fuzz], scaled by the match format
  point: [3, 1], ace: [6, 3], winner: [4, 2], clean: [1, 1],
  rallyFrom: 6,                   // rallies of 6+ shots: 3 XP and 1 Fuzz per shot past 5
  firstWin: [200, 150],
  caps: { points: 150, aces: 40, winners: 80, clean: 40, rally: 20 },   // a very long match can't mint without limit
};
// ctx: { firstWinToday } (progress.js works it out from the Profile; tests pass it).
export function rewardsFor(s, ctx = {}) {
  if (s && s.mode === 'training') return trainingRewards(s, ctx);
  const lines = [], R = REWARD, C = R.caps, n = (v, cap) => Math.max(0, Math.min(cap, Math.floor(+v || 0)));
  const add = (label, xp, fuzz) => { if (xp || fuzz) lines.push({ label, xp: Math.round(xp), fuzz: Math.round(fuzz) }); };
  const f = FORMAT_SCALE[s.format] ?? 1, base = s.won ? R.win : R.loss;
  add(s.won ? 'Victory' : 'Match played', base[0] * f, base[1] * f);
  const pts = n(s.points, C.points), aces = n(s.aces, C.aces), win = n(s.winners, C.winners), clean = n(s.cleanHits, C.clean);
  if (pts) add(`Points won ×${pts}`, pts * R.point[0], pts * R.point[1]);
  if (aces) add(`Aces ×${aces}`, aces * R.ace[0], aces * R.ace[1]);
  if (win) add(`Winners ×${win}`, win * R.winner[0], win * R.winner[1]);
  const rally = n(s.longestRally, 999), extra = Math.min(C.rally, rally - (R.rallyFrom - 1));
  if (rally >= R.rallyFrom) add(`Longest rally: ${rally} shots`, extra * 3, extra);
  if (clean) add(`Clean timing ×${clean}`, clean * R.clean[0], clean * R.clean[1]);
  const mult = s.mode === 'online' ? DIFFICULTY.online : DIFFICULTY[s.level] ?? 1;
  if (mult !== 1) {
    const sx = lines.reduce((a, l) => a + l.xp, 0), sf = lines.reduce((a, l) => a + l.fuzz, 0);
    add(s.mode === 'online' ? `Online match ×${mult}` : `${cap(s.level)} CPU ×${mult}`, sx * (mult - 1), sf * (mult - 1));
  }
  if (s.won && ctx.firstWinToday) add('First win of the day', R.firstWin[0], R.firstWin[1]);
  return { xp: lines.reduce((a, l) => a + l.xp, 0), fuzz: lines.reduce((a, l) => a + l.fuzz, 0), lines };
}
const cap = (t) => String(t || '').charAt(0).toUpperCase() + String(t || '').slice(1);

// ---- training drills (src/training.js, src/drills.js) ----
// Small on purpose: drills teach the controls and warm you up, matches are where the progress is. What drills pay
// counts against a per-UTC-day cap (about one short match's worth); the one-time tutorial bonus sits outside it.
export const TRAINING = { base: [10, 3], grade: { S: [20, 6], A: [14, 4], B: [8, 2], C: [4, 1], D: [0, 0] }, best: [10, 4], daily: [240, 60], tutorial: [100, 50] };
// s: { mode: 'training', drill, name, grade, ... }. ctx: { today: { xp, fuzz } paid by drills so far today, newBest (beat
// an earlier personal best), firstTutorial }. Returns { xp, fuzz, lines, capped, counted: { xp, fuzz } toward the cap }.
export function trainingRewards(s, ctx = {}) {
  const T = TRAINING, lines = [], add = (label, xp, fuzz) => { if (xp || fuzz) lines.push({ label, xp, fuzz }); };
  const sum = (k) => lines.reduce((a, l) => a + l[k], 0);
  add(`Training: ${s.name || cap(s.drill)}`, T.base[0], T.base[1]);
  const g = T.grade[s.grade];
  if (g) add(`Grade ${s.grade}`, g[0], g[1]);
  if (ctx.newBest) add('Personal best', T.best[0], T.best[1]);
  const day = ctx.today || {}, leftX = Math.max(0, T.daily[0] - (+day.xp || 0)), leftF = Math.max(0, T.daily[1] - (+day.fuzz || 0));
  let xp = sum('xp'), fuzz = sum('fuzz'), capped = false;
  if (xp > leftX || fuzz > leftF) {
    capped = true;
    lines.push({ label: 'Daily training cap reached', xp: Math.min(xp, leftX) - xp, fuzz: Math.min(fuzz, leftF) - fuzz });
    xp = Math.min(xp, leftX); fuzz = Math.min(fuzz, leftF);
  }
  const counted = { xp, fuzz };
  if (s.drill === 'tutorial' && ctx.firstTutorial) { add('Tutorial complete', T.tutorial[0], T.tutorial[1]); xp += T.tutorial[0]; fuzz += T.tutorial[1]; }
  return { xp, fuzz, lines, capped, counted };
}

// ---- career stats (Profile.stats), updated from each match summary ----
export const newStats = () => ({
  matches: 0, wins: 0, losses: 0, points: 0, pointsLost: 0, aces: 0, doubleFaults: 0, winners: 0, errors: 0, hits: 0, cleanHits: 0,
  longestRally: 0, fastestServe: 0, timeS: 0, streak: 0, bestStreak: 0, bagels: 0, onlineWins: 0, challenges: 0, bought: 0, tourTitles: 0,
  xpEarned: 0, fuzzEarned: 0, winsBy: {}, winsOn: {}, winsAt: {}, beat: {},
});
export function recordMatch(st, s) {
  const i = (v) => Math.max(0, Math.floor(+v || 0)), inc = (o, k) => { if (k) o[k] = (o[k] || 0) + 1; };
  st.matches++; st.points += i(s.points); st.pointsLost += i(s.pointsLost); st.aces += i(s.aces); st.doubleFaults += i(s.doubleFaults);
  st.winners += i(s.winners); st.errors += i(s.errors); st.hits += i(s.hits); st.cleanHits += i(s.cleanHits); st.timeS += i(s.durationS);
  st.longestRally = Math.max(st.longestRally, i(s.longestRally)); st.fastestServe = Math.max(st.fastestServe, i(s.fastestServe));
  if (s.won) {
    st.wins++; st.streak++; st.bestStreak = Math.max(st.bestStreak, st.streak);
    inc(st.winsBy, s.mode === 'online' ? null : s.level); inc(st.winsOn, s.surface); inc(st.winsAt, s.tod);
    if (s.mode === 'online') st.onlineWins++;
    if (s.tour && s.tour.final) st.tourTitles = (st.tourTitles || 0) + 1;   // won a World Tour final
    if (s.mode !== 'online' && PRO_IDS.includes(s.opponent)) inc(st.beat, s.opponent);
    if (s.format !== 'tiebreak' && Array.isArray(s.games) && s.games[1] === 0) st.bagels++;
  } else { st.losses++; st.streak = 0; }
  return st;
}

// ---- unlock catalog ----
// kind: pro | surface | tod | outfit | racket | headwear | band | celebration | title. how: 'free' | 'level' (free at
// `level`) | 'buy' (Pro Shop: `price` Fuzz once you are `level`) | 'level-or-buy' (free at `level`, or buy it
// earlier) | 'earn' (granted by an achievement). preview is what Avatar.setKit / setLook / setStyle / makeRacket take.
const PRO_IDS = ['varga', 'rivas', 'adler', 'ferro', 'aranda'];
export const SLOTS = ['outfit', 'racket', 'headwear', 'band', 'celebration', 'title'];
const it = (kind, key, name, how, level, price, preview, extra) => ({ id: `${kind}:${key}`, kind, key, name, how, level, price, preview, ...extra });
const O = (key, name, level, price, shirt, pants, shoe, accent, design, how = 'buy') => it('outfit', key, name, how, level, price, { kit: { shirt, pants, shoe, accent, design } });
const RK = (key, name, level, price, frame, accent, strings, how = 'buy') => it('racket', key, name, how, level, price, { racket: { frame, accent, ...(strings ? { strings } : {}) } });
const HW = (key, name, level, price, headwear, band, how = 'buy') => it('headwear', key, name, how, level, price, { look: { headwear, headband: headwear === 'headband' }, ...(band != null ? { kit: { band } } : {}) });
const WB = (key, name, level, price, band, how = 'buy') => it('band', key, name, how, level, price, { look: { wristband: band != null }, ...(band != null ? { kit: { band } } : {}) });
const CE = (key, name, level, price, celebrate, how = 'buy') => it('celebration', key, name, how, level, price, { style: { celebrate } });
const TI = (key, name, how = 'earn', level = 1) => it('title', key, name, how, level, 0, { text: name });

// ---- gear with stats (G1): the grind. src/stats.js turns what you have equipped into shot and footwork multipliers ----
// Five gear slots, apart from the cosmetic ones (a racket's paint stays a cosmetic). Everyone starts with the Starter
// kit (neutral: 1.0 everywhere); Club, Pro, Elite and Legend items unlock by Player Level and cost Fuzz, and each
// can be upgraded +1..+5 for more Fuzz. Items trade off inside a tier (a power frame costs control), so higher tiers
// are better but there is no single best item. `stats` are fractions (+0.04 = 4 % better): pow / ctl / spin act on
// both wings (pow and ctl on the serve too, ctl on volleys), serve = serve pace + accuracy, volley = volley control,
// touch = drops, slices and lobs, speed / react = footwork, reach = how far you can stretch.
export const GEAR_SLOTS = ['frame', 'strings', 'shoes', 'grip', 'dampener'];
export const GEAR_TIERS = [
  { key: 'starter', name: 'Starter', color: '#a9b6c2' }, { key: 'club', name: 'Club', color: '#7fe0a8' }, { key: 'pro', name: 'Pro', color: '#6fb6ff' },
  { key: 'elite', name: 'Elite', color: '#c996ff' }, { key: 'legend', name: 'Legend', color: '#f2c14e' },
];
export const MAX_UPGRADE = 5, UPGRADE_STEP = 0.06;   // each +1 makes an item's strengths 6 % stronger (its costs stay)
const G = (kind, key, name, tier, level, price, stats, blurb) => it(kind, key, name, tier === 'starter' ? 'free' : 'buy', level, price, { gear: { tier, stats } }, { tier, stats, blurb });
const GEAR = [
  // Rackets (the frame; its colours are the "Racket paint" cosmetic): power, control or spin.
  G('frame', 'rally', 'Rally 100', 'starter', 1, 0, {}, 'The club loaner: does everything, nothing special'),
  G('frame', 'driver', 'Driver 102', 'club', 3, 500, { pow: 0.04, ctl: -0.02 }, 'A big sweet spot: free pace, a little wild'),
  G('frame', 'scalpel', 'Scalpel 95', 'club', 3, 500, { ctl: 0.04, pow: -0.02 }, 'A small head for precise hitting'),
  G('frame', 'whip', 'Whip 100', 'club', 4, 600, { spin: 0.05, ctl: -0.01 }, 'Open strings that bite the ball'),
  G('frame', 'cannon', 'Cannon 100', 'pro', 10, 2000, { pow: 0.07, serve: 0.02, ctl: -0.03 }, 'Stiff and heavy: pace off both wings and the serve'),
  G('frame', 'chisel', 'Chisel 97', 'pro', 11, 2200, { ctl: 0.07, touch: 0.02, pow: -0.03 }, 'Thin beam, pure feel'),
  G('frame', 'cyclone', 'Cyclone 98', 'pro', 12, 2400, { spin: 0.08, pow: 0.02, ctl: -0.02 }, 'Whippy and fast through the air'),
  G('frame', 'tempest', 'Tempest 100', 'elite', 24, 6500, { pow: 0.1, spin: 0.03, ctl: -0.04 }, 'Tour-level pace for first-strike tennis'),
  G('frame', 'surgeon', 'Surgeon 93', 'elite', 25, 7000, { ctl: 0.1, touch: 0.04, pow: -0.03 }, 'Paints lines: for players who make their own pace'),
  G('frame', 'monsoon', 'Monsoon 98', 'elite', 27, 7500, { spin: 0.11, ctl: 0.03, pow: -0.02 }, 'Heavy topspin that still lands'),
  G('frame', 'sovereign', 'Sovereign 97', 'legend', 42, 21000, { pow: 0.07, ctl: 0.07, spin: 0.05, touch: 0.03 }, 'The all-court classic: no weak spot'),
  G('frame', 'meteor', 'Meteor 100', 'legend', 45, 24000, { pow: 0.13, spin: 0.07, ctl: -0.03 }, 'Raw power and spin, if you can hold it'),
  // Strings: spin against touch.
  G('strings', 'syngut', 'Synthetic Gut', 'starter', 1, 0, {}, 'Basic nylon: fine for everything'),
  G('strings', 'poly', 'Poly 17', 'club', 3, 450, { spin: 0.04, ctl: 0.01, touch: -0.02 }, 'Firm polyester: bite and control, less feel'),
  G('strings', 'multi', 'Multifilament', 'club', 5, 550, { touch: 0.03, pow: 0.02, spin: -0.02 }, 'Soft and lively'),
  G('strings', 'hexpoly', 'Hex Poly 16L', 'pro', 11, 2000, { spin: 0.07, ctl: 0.02, touch: -0.03 }, 'Shaped strings that grab the ball'),
  G('strings', 'gut', 'Natural Gut', 'pro', 13, 2400, { touch: 0.05, pow: 0.04, spin: -0.02 }, 'The softest feel there is'),
  G('strings', 'octa', 'Octa Poly', 'elite', 25, 6500, { spin: 0.1, ctl: 0.03, touch: -0.03 }, 'Eight edges of spin'),
  G('strings', 'hybrid', 'Gut / Poly Hybrid', 'elite', 28, 7500, { spin: 0.05, touch: 0.05, pow: 0.04 }, 'Poly mains for bite, gut crosses for feel'),
  G('strings', 'silk', 'Silk Gut', 'legend', 44, 22000, { spin: 0.08, touch: 0.08, pow: 0.05 }, 'Hand-made: spin, pace and feel together'),
  // Shoes: top speed against the first step and the stretch.
  G('shoes', 'trainers', 'Court Trainers', 'starter', 1, 0, {}, 'Everyday court shoes'),
  G('shoes', 'sprinters', 'Court Sprinters', 'club', 3, 500, { speed: 0.04, react: -0.01 }, 'Light and quick in a straight line'),
  G('shoes', 'lowriders', 'Low Riders', 'club', 4, 550, { react: 0.04, reach: 0.01, speed: -0.01 }, 'Low to the ground for a sharp first step'),
  G('shoes', 'stride', 'Long Stride', 'pro', 10, 2000, { speed: 0.07, reach: 0.02, react: -0.02 }, 'Built for covering the whole baseline'),
  G('shoes', 'burst', 'Burst', 'pro', 12, 2200, { react: 0.07, speed: 0.02 }, 'Explosive split-step'),
  G('shoes', 'sliders', 'Clay Sliders', 'pro', 14, 2500, { reach: 0.05, speed: 0.03, react: -0.01 }, 'Slide into the wide ones'),
  G('shoes', 'blaze', 'Blaze', 'elite', 24, 6800, { speed: 0.1, react: 0.03, reach: -0.02 }, 'The fastest shoe on tour'),
  G('shoes', 'anchor', 'Anchor', 'elite', 26, 7200, { react: 0.09, reach: 0.05, speed: -0.02 }, 'Planted: quick reactions and a long stretch'),
  G('shoes', 'wingfoot', 'Wingfoot', 'legend', 43, 22000, { speed: 0.09, react: 0.08, reach: 0.04 }, 'Everywhere at once'),
  // Grips and overgrips: control and serve.
  G('grip', 'stock', 'Stock Grip', 'starter', 1, 0, {}, 'The grip the racket came with'),
  G('grip', 'tacky', 'Tacky Overgrip', 'club', 3, 400, { ctl: 0.03, pow: -0.01 }, 'Sticky: the racket never turns in your hand'),
  G('grip', 'dry', 'Dry Overgrip', 'pro', 10, 1800, { ctl: 0.05, serve: 0.03, touch: -0.01 }, 'Stays dry in the heat: a steady serve'),
  G('grip', 'leather', 'Leather Grip', 'pro', 12, 2200, { touch: 0.05, ctl: 0.03, pow: -0.02 }, 'You feel every string'),
  G('grip', 'tourwrap', 'Tour Wrap', 'elite', 26, 6500, { ctl: 0.08, serve: 0.04, touch: -0.02 }, 'The pros\' choice for control'),
  G('grip', 'featherleather', 'Feather Leather', 'elite', 29, 7500, { touch: 0.08, ctl: 0.04, pow: -0.02 }, 'Thin leather for soft hands'),
  G('grip', 'legendwrap', 'Champion\'s Wrap', 'legend', 46, 21000, { ctl: 0.09, touch: 0.06, serve: 0.04 }, 'Worn smooth by a hundred titles'),
  // Dampeners: feel at the net.
  G('dampener', 'none', 'No dampener', 'starter', 1, 0, {}, 'Nothing between you and the strings'),
  G('dampener', 'button', 'Button Dampener', 'club', 5, 450, { volley: 0.03, touch: 0.03, pow: -0.01 }, 'Takes the ping out: softer hands'),
  G('dampener', 'worm', 'Worm Dampener', 'pro', 13, 2000, { volley: 0.06, touch: 0.03, pow: -0.01 }, 'A calm racket for punch volleys'),
  G('dampener', 'netrusher', 'Net Rusher', 'elite', 27, 6500, { volley: 0.09, touch: 0.05, pow: -0.02 }, 'Volley like it\'s the 1980s'),
  G('dampener', 'whisper', 'Whisper', 'legend', 48, 20000, { volley: 0.1, touch: 0.08, serve: 0.03 }, 'Silence, and perfect feel'),
];
export const CATALOG = [
  it('pro', 'custom', 'Your player', 'free', 1, 0, { pro: 'custom' }),
  it('pro', 'varga', 'Luka Varga', 'free', 1, 0, { pro: 'varga' }),
  it('pro', 'rivas', 'Mateo Rivas', 'level-or-buy', 5, 1000, { pro: 'rivas' }),
  it('pro', 'adler', 'Julian Adler', 'level-or-buy', 10, 2000, { pro: 'adler' }),
  it('pro', 'ferro', 'Luca Ferro', 'level-or-buy', 15, 3000, { pro: 'ferro' }),
  it('pro', 'aranda', 'Tomas Aranda', 'level-or-buy', 20, 4000, { pro: 'aranda' }),
  it('surface', 'hard', 'Hard court', 'free', 1, 0, { surface: 'hard' }),
  it('surface', 'clay', 'Clay court', 'level', 3, 0, { surface: 'clay' }),
  it('surface', 'grass', 'Grass court', 'level', 6, 0, { surface: 'grass' }),
  it('tod', 'day', 'Day', 'free', 1, 0, { tod: 'day' }),
  it('tod', 'golden', 'Golden hour', 'level', 4, 0, { tod: 'golden' }),
  it('tod', 'night', 'Night session', 'level', 8, 0, { tod: 'night' }),
  // Outfits: shirt, shorts, shoes, trim colour, shirt design (0-3).
  O('classic', 'Club Classic', 1, 0, 0xf2f5ee, 0x1f3b5c, 0xf4f4f0, 0xd6f04a, 1, 'free'),
  O('crimson', 'Crimson Set', 2, 400, 0xc9443a, 0x1c1f24, 0x22262b, 0xf2f5ee, 2),
  O('navy', 'Navy Blazer', 2, 400, 0x1d2b44, 0xf2f5ee, 0xf4f4f0, 0xd6f04a, 1),
  O('whites', 'Lawn Whites', 4, 600, 0xf7f7f2, 0xf7f7f2, 0xf7f7f2, 0x2f6b3a, 0),
  O('ocean', 'Ocean Drive', 5, 700, 0x2f6fb3, 0x1d2b44, 0x1d2b44, 0xf2f5ee, 1),
  O('forest', 'Forest Green', 6, 750, 0x3f7a55, 0xf2f5ee, 0xf4f4f0, 0xf2c14e, 2),
  O('flamingo', 'Flamingo', 8, 1000, 0xe7839b, 0x1c1f24, 0xf4f4f0, 0xf2f5ee, 3),
  O('sunflower', 'Sunflower', 10, 1100, 0xf2c14e, 0x1d2b44, 0xf4f4f0, 0x1d2b44, 2),
  O('blackout', 'Blackout', 12, 1350, 0x222428, 0x222428, 0x222428, 0xd6f04a, 3),
  O('sunset', 'Sunset Orange', 15, 1650, 0xe8733a, 0x2b2f36, 0xf4f4f0, 0xf7d9a0, 1),
  O('mint', 'Mint Condition', 18, 1950, 0x8fd6b8, 0xf2f5ee, 0xf4f4f0, 0x2b6f5a, 0),
  O('royal', 'Royal Purple', 22, 2400, 0x5b3a8c, 0x1c1f24, 0xf4f4f0, 0xf2c14e, 2),
  O('gold', 'Champion Gold', 30, 4500, 0xd8b04a, 0xf2f5ee, 0xf4f4f0, 0x1c1f24, 3),
  // Racket paints: frame, accent (and strings).
  RK('stock', 'Stock Frame', 1, 0, 0x1b2026, 0xd6f04a, null, 'free'),
  RK('optic', 'Optic Pop', 2, 300, 0xd6f04a, 0x1b2026),
  RK('crimson', 'Crimson Fire', 3, 450, 0xb8322b, 0xf2f5ee),
  RK('cobalt', 'Cobalt', 5, 600, 0x2456a8, 0xf2f5ee),
  RK('ivory', 'Ivory', 7, 750, 0xf2efe6, 0xc9443a),
  RK('jade', 'Jade', 10, 1050, 0x2e8a6a, 0x1b2026, 0xe8f5c8),
  RK('carbon', 'Raw Carbon', 14, 1400, 0x2a2d31, 0x8a8f96, 0xd9d9d0),
  RK('sunset', 'Sunset Fade', 20, 2100, 0xe8733a, 0xf2c14e, 0xfff3d0),
  RK('gold', 'Gold Leaf', 28, 3900, 0xc9a13e, 0x1b2026, 0xf7ecc8),
  // Headwear: shape and colour (the colour is also the wristband colour: the renderer has one band colour).
  HW('none', 'Bare head', 1, 0, 'none', null, 'free'),
  HW('headband-white', 'White Headband', 2, 300, 'headband', 0xf2f5ee),
  HW('headband-optic', 'Optic Headband', 4, 450, 'headband', 0xd6f04a),
  HW('bandana-red', 'Red Bandana', 6, 700, 'bandana', 0xc9443a),
  HW('bandana-navy', 'Navy Bandana', 9, 800, 'bandana', 0x1d2b44),
  HW('cap-white', 'White Cap', 12, 1050, 'cap', 0xf2f5ee),
  HW('cap-black', 'Black Cap', 16, 1350, 'cap', 0x222428),
  HW('bandana-gold', 'Gold Bandana', 25, 2700, 'bandana', 0xd8b04a),
  // Wristbands (look.wristband + the band colour).
  WB('none', 'No wristbands', 1, 0, null, 'free'),
  WB('white', 'White Wristbands', 2, 200, 0xf2f5ee),
  WB('optic', 'Optic Wristbands', 3, 300, 0xd6f04a),
  WB('red', 'Red Wristbands', 5, 450, 0xc9443a),
  WB('navy', 'Navy Wristbands', 8, 600, 0x1d2b44),
  WB('pink', 'Pink Wristbands', 11, 750, 0xe7839b),
  // Celebrations (Avatar.setStyle celebrate).
  CE('fist', 'Fist Pump', 1, 0, 'fist', 'free'),
  CE('calm', 'Ice Cold', 3, 450, 'calm'),
  CE('arms', 'Arms Wide', 7, 900, 'arms'),
  CE('heart', 'Heart to the Crowd', 12, 1350, 'heart'),
  CE('vamos', 'Vamos!', 18, 2100, 'vamos'),
  // Profile titles (shown under your name): from levels and achievements.
  TI('rookie', 'Rookie', 'free'),
  TI('regular', 'Club Regular', 'level', 5),
  TI('contender', 'Contender', 'level', 15),
  TI('veteran', 'Tour Veteran', 'level', 30),
  TI('hof', 'Hall of Famer', 'level', 50),
  TI('ace', 'Ace Machine'), TI('grinder', 'Baseline Grinder'), TI('timing', 'Timing Master'),
  TI('giant', 'Giant Slayer'), TI('unstoppable', 'Unstoppable'), TI('champion', 'Champion'),
  ...GEAR,
];
const BY_ID = new Map(CATALOG.map((i) => [i.id, i]));
const LOOKUP = new Map(CATALOG.filter((i) => /^(pro|surface|tod)$/.test(i.kind)).map((i) => [i.key, i]));   // bare ids: 'clay', 'night', 'rivas'
export const itemById = (id) => BY_ID.get(id) || LOOKUP.get(id) || null;

export function isUnlocked(id, p = bound) {
  const item = itemById(id);
  if (!item) return true;   // not a gated thing (e.g. 'random' opponent)
  if (item.how === 'free' || unlockAll()) return true;
  if (p && p.owns(item.id)) return true;
  return (item.how === 'level' || item.how === 'level-or-buy') && !!p && p.level >= item.level;
}
// Can this be bought now? { ok, reason } (reason: 'owned' | 'not-for-sale' | 'level' | 'fuzz').
export function canBuy(id, p = bound) {
  const item = itemById(id);
  if (!item || !p) return { ok: false, reason: 'not-for-sale' };
  if (isUnlocked(item.id, p)) return { ok: false, reason: 'owned' };
  if (!(item.how === 'buy' || item.how === 'level-or-buy') || !item.price) return { ok: false, reason: 'not-for-sale' };
  if (item.how === 'buy' && p.level < item.level) return { ok: false, reason: 'level' };
  if (p.fuzz < item.price) return { ok: false, reason: 'fuzz' };
  return { ok: true };
}
export function buy(id, p = bound) {
  const item = itemById(id);
  if (!canBuy(id, p).ok || !p.spend(item.price, `buy ${item.id}`)) return false;
  p.grant(item.id);
  p.stats.bought = (p.stats.bought || 0) + 1;
  p.save();
  return true;
}
// How a locked item unlocks, for labels: 'Level 6', 'Level 10 or 1,800 Fuzz', '450 Fuzz', 'Achievement'.
export function unlockHint(id) {
  const i = itemById(id);
  if (!i) return '';
  return { free: 'Free', level: `Level ${i.level}`, 'level-or-buy': `Level ${i.level} or ${fmtFuzz(i.price)}`, buy: i.level > 1 ? `Level ${i.level} · ${fmtFuzz(i.price)}` : fmtFuzz(i.price), earn: 'Achievement' }[i.how] || '';
}
// Items that unlock by reaching exactly this level (for the level-up screen).
export const unlocksAtLevel = (l) => CATALOG.filter((i) => (i.how === 'level' || i.how === 'level-or-buy') && i.level === l);
// The equipped cosmetics as one look: { kit, look, style, racket } for Avatar.setKit / setLook / setStyle and the
// racket colours (makeRacket takes { frame, accent, strings }). The band colour: headwear's, else the wristbands'.
export function lookFor(equipped = {}) {
  const out = { kit: {}, look: {}, style: {}, racket: null }, get = (slot) => { const i = itemById(equipped[slot]); return i && i.kind === slot ? i.preview : null; };
  for (const slot of ['outfit', 'band', 'headwear', 'celebration']) {
    const p = get(slot);
    if (!p) continue;
    Object.assign(out.kit, p.kit); Object.assign(out.look, p.look); Object.assign(out.style, p.style);
  }
  const hw = get('headwear'), wb = get('band');
  if (hw && hw.kit && wb) out.look.wristband = !!wb.look.wristband;
  const r = get('racket');
  if (r) out.racket = { ...r.racket };
  return out;
}

// ---- gear: starter kit, stats with upgrades, upgrade prices (G1) ----
export const isGear = (i) => !!i && GEAR_SLOTS.includes(i.kind);
export const STARTER_GEAR = Object.freeze(Object.fromEntries(GEAR_SLOTS.map((s) => [s, CATALOG.find((i) => i.kind === s && i.tier === 'starter').id])));
export const tierIndex = (t) => Math.max(0, GEAR_TIERS.findIndex((x) => x.key === t));
// The Profile's upgrade levels ({ id: 0..5 }); tests pass a plain { upgrades } object.
const upsOf = (p) => (p && (p.upgrades || (p.data && p.data.upgrades))) || {};
export const upgradeOf = (id, p = bound) => { const i = itemById(id), k = i ? upsOf(p)[i.id] : 0; return Math.max(0, Math.min(MAX_UPGRADE, Math.floor(+k || 0))); };
// An item's stat deltas at upgrade level k: its strengths grow by UPGRADE_STEP per level, its costs stay.
export function gearStats(id, k = 0) {
  const i = typeof id === 'string' ? itemById(id) : id, out = {};
  if (!isGear(i)) return out;
  const m = 1 + UPGRADE_STEP * Math.max(0, Math.min(MAX_UPGRADE, k | 0));
  for (const [s, v] of Object.entries(i.stats)) out[s] = +(v > 0 ? v * m : v).toFixed(4);
  return out;
}
// Fuzz for upgrade level k (1..5): 15 % of the item's price for +1, rising 5 % a level (+1..+5 = 1.25× the price).
export function upgradeCost(id, k) { const i = itemById(id); return isGear(i) && i.price > 0 && k >= 1 && k <= MAX_UPGRADE ? Math.round((i.price * (0.1 + 0.05 * k)) / 10) * 10 : 0; }
// Can this gear be upgraded now? { ok, reason, next, cost } (reason: 'not-gear' | 'starter' | 'locked' | 'max' | 'fuzz').
export function canUpgrade(id, p = bound) {
  const i = itemById(id);
  if (!isGear(i) || !p) return { ok: false, reason: 'not-gear' };
  if (!i.price) return { ok: false, reason: 'starter' };
  if (!isUnlocked(i.id, p)) return { ok: false, reason: 'locked' };
  const next = upgradeOf(i.id, p) + 1, cost = upgradeCost(i.id, next);
  if (next > MAX_UPGRADE) return { ok: false, reason: 'max', next };
  if (p.fuzz < cost) return { ok: false, reason: 'fuzz', next, cost };
  return { ok: true, next, cost };
}
export function upgrade(id, p = bound) {
  const i = itemById(id), c = canUpgrade(id, p);
  if (!c.ok || !p.spend(c.cost, `upgrade ${i.id} +${c.next}`)) return false;
  const ups = p.data ? (p.data.upgrades ||= {}) : (p.upgrades ||= {});
  ups[i.id] = c.next;
  if (p.changed) p.changed(); else if (p.save) p.save();
  return true;
}

// ---- seeded randomness (daily challenges) ----
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; }
function rng(seed) { let a = hash(String(seed)); return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---- daily challenges ----
// count(summary) is added to the progress after each match (max: true keeps the best single match instead).
const W = (s) => (s.won ? 1 : 0);
export const CHALLENGES = [
  { id: 'play3', text: 'Play 3 matches', goal: 3, xp: 150, fuzz: 100, count: () => 1 },
  { id: 'win2', text: 'Win 2 matches', goal: 2, xp: 250, fuzz: 150, count: W },
  { id: 'points40', text: 'Win 40 points', goal: 40, xp: 150, fuzz: 100, count: (s) => s.points },
  { id: 'points80', text: 'Win 80 points', goal: 80, xp: 250, fuzz: 150, count: (s) => s.points, minLevel: 5 },
  { id: 'aces3', text: 'Serve 3 aces', goal: 3, xp: 200, fuzz: 120, count: (s) => s.aces },
  { id: 'winners10', text: 'Hit 10 winners', goal: 10, xp: 200, fuzz: 120, count: (s) => s.winners },
  { id: 'rally10', text: 'Play a 10-shot rally', goal: 10, xp: 150, fuzz: 100, count: (s) => s.longestRally, max: true },
  { id: 'rally18', text: 'Play an 18-shot rally', goal: 18, xp: 250, fuzz: 160, count: (s) => s.longestRally, max: true, minLevel: 6 },
  { id: 'ontime15', text: 'Hit 15 shots on time', goal: 15, xp: 200, fuzz: 120, count: (s) => s.onTime ?? s.cleanHits },
  { id: 'serve170', text: 'Serve at 170 km/h or faster', goal: 170, xp: 200, fuzz: 120, count: (s) => s.fastestServe, max: true, unit: 'km/h' },
  { id: 'nodf', text: 'Win a match without a double fault', goal: 1, xp: 250, fuzz: 150, count: (s) => (s.won && !s.doubleFaults ? 1 : 0) },
  { id: 'club', text: 'Beat a Club or Pro CPU', goal: 1, xp: 250, fuzz: 150, count: (s) => (s.won && s.mode !== 'online' && (s.level === 'club' || s.level === 'pro') ? 1 : 0) },
  { id: 'pro', text: 'Beat a Pro CPU', goal: 1, xp: 400, fuzz: 250, count: (s) => (s.won && s.mode !== 'online' && s.level === 'pro' ? 1 : 0), minLevel: 8 },
  { id: 'clay', text: 'Win a match on clay', goal: 1, xp: 250, fuzz: 150, count: (s) => (s.won && s.surface === 'clay' ? 1 : 0), minLevel: 3 },
  { id: 'grass', text: 'Win a match on grass', goal: 1, xp: 250, fuzz: 150, count: (s) => (s.won && s.surface === 'grass' ? 1 : 0), minLevel: 6 },
  { id: 'night', text: 'Win a night match', goal: 1, xp: 250, fuzz: 150, count: (s) => (s.won && s.tod === 'night' ? 1 : 0), minLevel: 8 },
  { id: 'full', text: 'Win a full set', goal: 1, xp: 350, fuzz: 200, count: (s) => (s.won && s.format === 'full' ? 1 : 0), minLevel: 4 },
];
const CH_BY_ID = new Map(CHALLENGES.map((c) => [c.id, c]));
export const challengeById = (id) => CH_BY_ID.get(id) || null;
const poolFor = (level) => CHALLENGES.filter((c) => (c.minLevel || 1) <= level);
// The day's 3 challenges: the same for everyone at the same level range on the same UTC day.
export function dailyChallenges(dateKey = utcDay(), level = MAX_LEVEL) {
  const pool = poolFor(level).slice(), r = rng(`daily:${dateKey}`), out = [];
  while (out.length < 3 && pool.length) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return out;
}
// The free reroll: a seeded replacement for one slot, never one already on the list.
export function rerollChallenge(dateKey, slot, current = [], level = MAX_LEVEL) {
  const pool = poolFor(level).filter((c) => !current.includes(c.id));
  return pool.length ? pool[Math.floor(rng(`reroll:${dateKey}:${slot}`)() * pool.length)] : null;
}
// New progress for one challenge after a match.
export function challengeStep(ch, progress, s) {
  const v = Math.max(0, Math.floor(+ch.count(s) || 0));
  return Math.min(ch.goal, ch.max ? Math.max(progress || 0, v) : (progress || 0) + v);
}

// ---- achievements ----
// A career counter (stat path + goal, so the Locker can show a progress bar) or a test on the match just played.
const A = (id, name, desc, fuzz, cond, title) => ({ id, name, desc, fuzz, xp: Math.round(fuzz / 2), ...cond, ...(title ? { title: `title:${title}` } : {}) });
export const ACHIEVEMENTS = [
  A('first_match', 'Walk-on', 'Play your first match', 50, { stat: 'matches', goal: 1 }),
  A('first_win', 'On the Board', 'Win your first match', 100, { stat: 'wins', goal: 1 }),
  A('wins_10', 'Regular', 'Win 10 matches', 200, { stat: 'wins', goal: 10 }),
  A('wins_50', 'Contender', 'Win 50 matches', 600, { stat: 'wins', goal: 50 }),
  A('wins_150', 'Champion', 'Win 150 matches', 1500, { stat: 'wins', goal: 150 }, 'champion'),
  A('matches_25', 'Court Rat', 'Play 25 matches', 250, { stat: 'matches', goal: 25 }),
  A('matches_100', 'Iron Legs', 'Play 100 matches', 800, { stat: 'matches', goal: 100 }),
  A('ace_1', 'Ace!', 'Serve an ace', 50, { stat: 'aces', goal: 1 }),
  A('aces_100', 'Ace Machine', 'Serve 100 aces', 600, { stat: 'aces', goal: 100 }, 'ace'),
  A('aces_match_5', 'Serve Clinic', 'Serve 5 aces in one match', 300, { test: (s) => s.aces >= 5 }),
  A('winners_100', 'Shotmaker', 'Hit 100 winners', 400, { stat: 'winners', goal: 100 }),
  A('winners_match_10', 'Highlight Reel', 'Hit 10 winners in one match', 300, { test: (s) => s.winners >= 10 }),
  A('rally_15', 'Grinder', 'Play a 15-shot rally', 200, { stat: 'longestRally', goal: 15 }),
  A('rally_30', 'Marathon Rally', 'Play a 30-shot rally', 600, { stat: 'longestRally', goal: 30 }, 'grinder'),
  A('serve_180', 'Big Server', 'Serve at 180 km/h', 250, { stat: 'fastestServe', goal: 180 }),
  A('serve_200', 'Rocket Launcher', 'Serve at 200 km/h', 600, { stat: 'fastestServe', goal: 200 }),
  A('clean_100', 'In the Zone', 'Land 100 on-time hits with a camera or phone', 300, { stat: 'cleanHits', goal: 100 }),
  A('clean_1000', 'Timing Master', 'Land 1,000 on-time hits with a camera or phone', 1200, { stat: 'cleanHits', goal: 1000 }, 'timing'),
  A('win_club', 'Club Champion', 'Beat a Club CPU', 150, { stat: 'winsBy.club', goal: 1 }),
  A('win_pro', 'Giant Killer', 'Beat a Pro CPU', 400, { stat: 'winsBy.pro', goal: 1 }),
  A('pro_10', 'Tour Ready', 'Beat a Pro CPU 10 times', 1000, { stat: 'winsBy.pro', goal: 10 }),
  A('win_clay', 'Red Dirt', 'Win on clay', 150, { stat: 'winsOn.clay', goal: 1 }),
  A('win_grass', 'Lawn Master', 'Win on grass', 150, { stat: 'winsOn.grass', goal: 1 }),
  A('win_night', 'Under the Lights', 'Win a night match', 150, { stat: 'winsAt.night', goal: 1 }),
  A('all_surfaces', 'Surface Tension', 'Win on hard, clay and grass', 400, { test: (s, st) => ['hard', 'clay', 'grass'].every((k) => st.winsOn[k] > 0) }),
  A('beat_all', 'Giant Slayer', 'Beat all five pros', 1000, { test: (s, st) => PRO_IDS.every((k) => st.beat[k] > 0) }, 'giant'),
  A('streak_3', 'Hot Streak', 'Win 3 matches in a row', 200, { stat: 'bestStreak', goal: 3 }),
  A('streak_10', 'Unstoppable', 'Win 10 matches in a row', 1000, { stat: 'bestStreak', goal: 10 }, 'unstoppable'),
  A('bagel', 'Bakery', 'Win a set without dropping a game', 300, { stat: 'bagels', goal: 1 }),
  A('spotless', 'Spotless', 'Beat a Pro CPU without a double fault', 500, { test: (s) => s.won && s.mode !== 'online' && s.level === 'pro' && !s.doubleFaults }),
  A('online_win', 'Friendly Rivalry', 'Win an online match', 200, { stat: 'onlineWins', goal: 1 }),
  A('daily_10', 'Daily Grind', 'Complete 10 daily challenges', 400, { stat: 'challenges', goal: 10 }),
  A('shopper', 'Fresh Kit', 'Buy something in the Pro Shop', 100, { stat: 'bought', goal: 1 }),
  A('level_10', 'Rising Star', 'Reach level 10', 300, { test: (s, st, lv) => lv >= 10 }),
  A('level_30', 'Veteran', 'Reach level 30', 1000, { test: (s, st, lv) => lv >= 30 }),
  A('tour_title', 'Silverware', 'Win a World Tour title', 800, { stat: 'tourTitles', goal: 1 }),
];
const statAt = (st, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), st) || 0;
// { value, goal } for a counter achievement (null for one-match tests).
export const achievementProgress = (a, st) => (a.stat ? { value: Math.min(a.goal, statAt(st, a.stat)), goal: a.goal } : null);
// Newly earned achievements: stats after the match, the summary (may be null), ids already earned, the level.
export function checkAchievements(st, s, have = {}, level = 1) {
  return ACHIEVEMENTS.filter((a) => !have[a.id] && (a.stat ? statAt(st, a.stat) >= a.goal : !!(a.test && (s || a.test.length > 1) && safe(() => a.test(s || {}, st, level)))));
}
const safe = (fn) => { try { return fn(); } catch (e) { return false; } };
