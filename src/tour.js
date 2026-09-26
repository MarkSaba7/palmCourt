// Palm Court: the World Tour career. A season calendar of fictional tournaments (Challenger → 500 → Masters → Major →
// Finals), draws of generated CPU players plus the named pros, seeding, a rolling ranking (start #500, climb to #1),
// prize money, trophies. Pure data + logic (no DOM, runs in plain Node for the tests); the screens are tourui.js.
// State lives on the Profile as Profile.data.tour (its own `v`, migrated here), so a run survives reloads.
import { LEVELS } from './core.js';
import { PROS, proById } from './pros.js';
import { Profile } from './profile.js';
import { Bus } from './events.js';

export const TOUR_V = 1;

// ---- tiers ----
// draw: 8 or 16. ranks: the field slots (world ranking) generated entrants come from. pros: named pros in the draw.
// req: entry needs rank <= req.rank OR level >= req.level (either one). pts/fuzz/xp: by round reached (0 = lost the
// first match ... last = champion). web: playable in the free web edition.
export const TIERS = {
  challenger: { key: 'challenger', name: 'Challenger', short: 'CH', draw: 8, format: 'short', ranks: [150, 480], pros: 0, req: {}, web: true,
    pts: [8, 25, 50, 100], fuzz: [50, 120, 220, 400], xp: [60, 120, 200, 350], color: '#c98a4b' },
  t500: { key: 't500', name: 'Tour 500', short: '500', draw: 16, format: 'short', ranks: [20, 230], pros: 1, req: { rank: 250, level: 8 },
    pts: [25, 90, 180, 330, 500], fuzz: [120, 250, 450, 700, 1100], xp: [100, 200, 320, 480, 700], color: '#b9c3cc' },
  masters: { key: 'masters', name: 'Masters', short: 'M', draw: 16, format: 'short', ranks: [8, 110], pros: 2, req: { rank: 100, level: 14 },
    pts: [45, 180, 360, 650, 1000], fuzz: [200, 400, 700, 1100, 1800], xp: [150, 300, 480, 700, 1000], color: '#e3c15a' },
  major: { key: 'major', name: 'Major', short: 'MJ', draw: 16, format: 'full', ranks: [6, 90], pros: 5, req: { rank: 50, level: 20 },
    pts: [90, 360, 720, 1300, 2000], fuzz: [300, 600, 1100, 1800, 3000], xp: [200, 400, 650, 950, 1400], color: '#f2f5ee' },
  finals: { key: 'finals', name: 'Finals', short: 'F', draw: 8, format: 'full', ranks: [6, 7], pros: 5, req: { rank: 8, level: 40 },
    pts: [200, 600, 1000, 1500], fuzz: [600, 1200, 2000, 3500], xp: [400, 700, 1000, 1500], color: '#d6f04a' },
};

// ---- the season: one entry per week, one event per week for you (like the real tour) ----
const EV = (id, name, tier, surface, tod, city, req) => ({ id, name, tier, surface, tod, city, ...(req ? { req } : {}) });
export const CALENDAR = [
  [EV('palm-court', 'Palm Court Open', 'challenger', 'hard', 'day', 'Palm Court')],
  [EV('coral-bay', 'Coral Bay Classic', 'challenger', 'hard', 'golden', 'Coral Bay'), EV('seaside', 'Seaside 500', 't500', 'hard', 'day', 'Port Azure')],
  [EV('marina', 'Marina Challenger', 'challenger', 'hard', 'day', 'Marina Point', { rank: 450, level: 2 }), EV('harbour', 'Harbour Lights Masters', 'masters', 'hard', 'night', 'Harbour City')],
  [EV('red-dune-ch', 'Red Dune Challenger', 'challenger', 'clay', 'day', 'Red Dune', { rank: 420, level: 3 }), EV('terracotta', 'Terracotta 500', 't500', 'clay', 'golden', 'Terracotta')],
  [EV('sierra', 'Sierra Clay Cup', 'challenger', 'clay', 'golden', 'Sierra Alta', { rank: 400, level: 3 }), EV('red-dune', 'Red Dune Clay Masters', 'masters', 'clay', 'day', 'Red Dune')],
  [EV('grand-rouge', 'Grand Rouge Major', 'major', 'clay', 'day', 'Rouge-sur-Mer')],
  [EV('hedgerow', 'Hedgerow Challenger', 'challenger', 'grass', 'day', 'Hedgerow', { rank: 380, level: 4 }), EV('garden', 'Garden Party 500', 't500', 'grass', 'golden', 'Kingsmead')],
  [EV('lawn-club', 'Lawn Club Championship', 'major', 'grass', 'day', 'Lawn Club')],
  [EV('neon-alley', 'Neon Alley Challenger', 'challenger', 'hard', 'night', 'Neon Alley', { rank: 350, level: 5 }), EV('skyline', 'Skyline Masters', 'masters', 'hard', 'night', 'Skyline Bay')],
  [EV('neon-nights', 'Neon Nights Finals', 'finals', 'hard', 'night', 'Neon City')],
];
export const WEEKS = CALENDAR.length;
export const EVENTS = CALENDAR.flat();
export const eventById = (id) => EVENTS.find((e) => e.id === id) || null;
export const tierOf = (ev) => TIERS[(typeof ev === 'string' ? eventById(ev) : ev)?.tier] || null;
export const reqOf = (ev) => ev.req || TIERS[ev.tier].req;
export const rounds = (n) => Math.round(Math.log2(n));
export function roundName(R, r) { const k = R - r; return k === 1 ? 'Final' : k === 2 ? 'Semi-final' : k === 3 ? 'Quarter-final' : `Round of ${2 ** k}`; }
// What reaching round `reached` (0 = lost the first match, R = won the title) is called.
export function reachedName(R, reached) { const k = R - reached; return k === 0 ? 'Champion' : k === 1 ? 'Runner-up' : k === 2 ? 'Semi-finalist' : k === 3 ? 'Quarter-finalist' : `Round of ${2 ** k}`; }

// ---- the ranking: a field of 499 players with points on a fixed curve; your rank = 1 + everyone with at least your points ----
export const FIELD_SIZE = 499, START_RANK = FIELD_SIZE + 1;
const ANCHORS = [[1, 9000], [2, 7200], [3, 6000], [5, 4600], [8, 3600], [10, 3200], [20, 2200], [50, 1250], [100, 700], [200, 330], [300, 170], [400, 90], [499, 40]];
export const FIELD = [0];
for (let k = 1; k <= FIELD_SIZE; k++) {
  let i = 0;
  while (i < ANCHORS.length - 2 && k > ANCHORS[i + 1][0]) i++;
  const [r0, p0] = ANCHORS[i], [r1, p1] = ANCHORS[i + 1], f = (Math.log(k) - Math.log(r0)) / (Math.log(r1) - Math.log(r0));
  FIELD[k] = Math.round(Math.exp(Math.log(p0) + f * (Math.log(p1) - Math.log(p0))));
}
export function rankFor(pts) {
  let lo = 1, hi = FIELD_SIZE + 1;   // first field slot with fewer points than you (FIELD is decreasing)
  while (lo < hi) { const m = (lo + hi) >> 1; if (FIELD[m] >= pts) lo = m + 1; else hi = m; }
  return pts > 0 ? lo : START_RANK;
}
// Field slot k's world ranking once you are ranked `me`: everyone from your rank down moves one place.
export const slotRank = (k, me) => (k < me ? k : k + 1);

// ---- deterministic randomness (a draw is the same on every reload) ----
export function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function rng(seed) {
  let a = hashStr(String(seed));
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pickR = (R, a) => a[Math.floor(R() * a.length) % a.length];
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ---- the field: fictional players (nobody real), one per ranking slot; the named pros hold slots 1-5 ----
const FIRST = ['Arlo', 'Bastien', 'Cato', 'Dario', 'Emil', 'Fabian', 'Gideon', 'Hugo', 'Ilya', 'Jonas', 'Kai', 'Leandro', 'Marek', 'Niko', 'Oskar', 'Paolo', 'Quentin', 'Ruben', 'Silas', 'Teo', 'Umar', 'Viktor', 'Wes', 'Anton', 'Bruno', 'Cyril', 'Enzo', 'Florian', 'Henrik', 'Ivo', 'Joaquin', 'Kenta', 'Lorenzo', 'Mika', 'Nils', 'Otto', 'Pavel', 'Santiago', 'Tobias', 'Valentin', 'Yusuf', 'Aurelio', 'Björn'];
const LAST = ['Albrecht', 'Brisco', 'Castellano', 'Dragomir', 'Eklund', 'Falkner', 'Grozdan', 'Halloran', 'Ibarra', 'Jansky', 'Kovar', 'Lindahl', 'Marchetti', 'Novotny', 'Okonkwo', 'Petrak', 'Quarles', 'Rosendahl', 'Sandoval', 'Tavernier', 'Ulloa', 'Varden', 'Wexley', 'Yardani', 'Zelenko', 'Achterberg', 'Corvalan', 'Delmar', 'Fontaine', 'Galvani', 'Hartwell', 'Iskander', 'Jovanic', 'Kellerman', 'Lucchesi', 'Montag', 'Nakagawa', 'Pellegrin', 'Solberg', 'Tamura', 'Uhlig', 'Whitlock', 'Zorrilla', 'Brandvold', 'Oyelaran', 'Ferreira-Lind', 'Moravec'];
const COUNTRIES = ['FRA', 'ESP', 'ITA', 'GER', 'USA', 'ARG', 'AUS', 'GBR', 'JPN', 'CZE', 'SWE', 'NOR', 'BRA', 'CAN', 'NED', 'POL', 'CRO', 'SRB', 'CHI', 'RSA', 'NGR', 'KOR', 'AUT', 'BEL', 'POR', 'MEX'];
// Playing styles for the generated players (player.persona, 0..1, 0.5 neutral).
export const STYLES = {
  baseliner: { label: 'Baseliner', p: { aggression: 0.55, topspin: 0.7, slice: 0.35, drop: 0.3, net: 0.25, serve: 0.5, consistency: 0.75, defense: 0.6, speed: 0.6 } },
  server: { label: 'Big server', p: { aggression: 0.8, topspin: 0.45, slice: 0.35, drop: 0.2, net: 0.5, serve: 0.92, consistency: 0.45, defense: 0.35, speed: 0.4 } },
  counter: { label: 'Counter-puncher', p: { aggression: 0.3, topspin: 0.55, slice: 0.55, drop: 0.4, net: 0.2, serve: 0.4, consistency: 0.85, defense: 0.85, speed: 0.75 } },
  allcourt: { label: 'All-court', p: { aggression: 0.6, topspin: 0.5, slice: 0.6, drop: 0.55, net: 0.6, serve: 0.6, consistency: 0.6, defense: 0.55, speed: 0.6 } },
  volleyer: { label: 'Serve and volley', p: { aggression: 0.75, topspin: 0.35, slice: 0.7, drop: 0.5, net: 0.9, serve: 0.78, consistency: 0.5, defense: 0.4, speed: 0.65 } },
  grinder: { label: 'Grinder', p: { aggression: 0.35, topspin: 0.85, slice: 0.3, drop: 0.25, net: 0.15, serve: 0.45, consistency: 0.9, defense: 0.75, speed: 0.7 } },
};
const STYLE_KEYS = Object.keys(STYLES);
export const PRO_ORDER = ['varga', 'aranda', 'ferro', 'rivas', 'adler'];   // their world ranking, 1-5
const SKINS = [0xf1c7a5, 0xe1ae88, 0xd9a27e, 0xc68a62, 0xa46a45, 0x8a5536, 0x6b3f28];
const HAIRS = [['short', 0x2b1d14], ['crop', 0x1d1510], ['buzz', 0x15100c], ['wavy', 0x6b4a2b], ['curly', 0x2c1d13], ['textured', 0x3a2a1c], ['short', 0xb08a52], ['bald', 0x2b1d14], ['crop', 0x8c5a32]];
const SHIRTS = [[0x2f6fb3, 0xf2f5ee], [0xc9443a, 0x1c1f24], [0x3f7a55, 0xf2f5ee], [0x5b3a8c, 0xf2c14e], [0xf2c14e, 0x1d2b44], [0x222428, 0xd6f04a], [0xe8733a, 0x2b2f36], [0x8fd6b8, 0x2b6f5a], [0x1d2b44, 0xf2f5ee], [0xe7839b, 0x1c1f24]];

// Skill 0..1 from a world ranking: #500 is 0, #1 is 1 (log scale, so the top is steep).
export const skillFor = (rank) => clamp01(1 - Math.log(Math.max(1, rank)) / Math.log(START_RANK));
// The field player in slot k (1..499): a pro for slots 1-5, otherwise a generated player (the same every time).
export function fieldPlayer(k) {
  if (k <= PRO_ORDER.length) {
    const p = proById(PRO_ORDER[k - 1]);
    return { id: p.id, pro: p.id, name: p.name, short: p.short, country: p.country, handed: p.handed, slot: k, style: null, look: { ...p.look, ...p.kit } };
  }
  const R = rng(`field:${k}`), n = FIRST.length * LAST.length, idx = (k * 7919) % n;   // 7919 is prime: every slot gets its own name
  const first = FIRST[idx % FIRST.length], last = LAST[Math.floor(idx / FIRST.length) % LAST.length];
  const [hair, hairColor] = pickR(R, HAIRS), [shirt, accent] = pickR(R, SHIRTS), headwear = R() < 0.18 ? 'headband' : R() < 0.1 ? 'cap' : 'none';
  return {
    id: `f${k}`, pro: null, name: `${first} ${last}`, short: last, country: pickR(R, COUNTRIES), handed: R() < 0.14 ? 'L' : 'R', slot: k, style: pickR(R, STYLE_KEYS),
    look: { skin: pickR(R, SKINS), hair, hairColor, headwear, headband: headwear === 'headband', beard: R() < 0.3 ? +(R() * 0.8).toFixed(2) : 0, shirt, accent, band: accent, design: 1 + Math.floor(R() * 3), pants: 0x1c1f24, height: +(0.96 + R() * 0.08).toFixed(3) },
  };
}
// A generated player's persona: their style, nudged a little so no two play quite alike.
export function personaFor(e) {
  if (e.pro) return { ...proById(e.pro).persona };
  const R = rng(`persona:${e.slot}`), base = STYLES[e.style]?.p || STYLES.allcourt.p, p = {};
  for (const k in base) p[k] = +clamp01(base[k] + (R() - 0.5) * 0.1).toFixed(3);
  return p;
}

// ---- CPU strength from skill: rookie (0) → club (0.3) → pro (0.72) → elite (1), every LEVELS field interpolated ----
const ELITE = { label: 'Elite', speed: 5.9, acc: 5.3, react: 0.22, err: 0.52, power: [0.48, 0.95], serve: [0.7, 1.0], iq: 0.95, pos: 0.08, judge: 0.15, sErr: 1.2, risk: 0.85 };
const LADDER = [[0, 'rookie'], [0.3, 'club'], [0.72, 'pro'], [1, ELITE]];
export function cpuLevel(skill) {
  const s = clamp01(skill), L = (x) => (typeof x === 'string' ? LEVELS[x] : x);
  let i = 0;
  while (i < LADDER.length - 2 && s > LADDER[i + 1][0]) i++;
  const [s0, a0] = LADDER[i], [s1, a1] = LADDER[i + 1], A = L(a0), B = L(a1), f = clamp01((s - s0) / (s1 - s0)), out = {};
  for (const k in A) {
    if (typeof A[k] === 'number') out[k] = +(A[k] + (B[k] - A[k]) * f).toFixed(4);
    else if (Array.isArray(A[k])) out[k] = A[k].map((v, j) => +(v + (B[k][j] - v) * f).toFixed(4));
  }
  out.label = levelLabel(s);
  return out;
}
// The nearest named level: what the economy's difficulty multiplier and the "wins by level" stats see.
export const levelKey = (skill) => (skill < 0.18 ? 'rookie' : skill < 0.55 ? 'club' : 'pro');
export const levelLabel = (s) => (s < 0.1 ? 'Rookie' : s < 0.22 ? 'Rookie+' : s < 0.38 ? 'Club' : s < 0.55 ? 'Club+' : s < 0.7 ? 'Pro' : s < 0.85 ? 'Pro+' : 'Elite');

// ---- draws ----
// Standard bracket order: seed 1 top, seed 2 in the other half, seeds 3-4 in the other quarters, ...
export function seedOrder(n) {
  let o = [1];
  while (o.length < n) { const m = o.length * 2; o = o.flatMap((s) => [s, m + 1 - s]); }
  return o;
}
// The entrants for an event: n-1 field players (pros per tier, generated players from the tier's ranking band) + you.
// me: { rank, name, short, country, pro } (pro = who you play as; that pro stays out of the draw).
export function makeField(ev, season, me, key = '') {
  const T = TIERS[ev.tier], n = T.draw, R = rng(`draw:${key}:${ev.id}:${season}`), slots = new Set(), mine = me.rank;
  let pros = PRO_ORDER.map((id, i) => i + 1).filter((k) => PRO_ORDER[k - 1] !== me.pro);
  if (ev.tier === 'finals') { for (let k = 1; slots.size < n - 1; k++) if (k > 5 || pros.includes(k)) slots.add(k); }
  else {
    const want = T.pros === 1 ? (R() < 0.6 ? 1 : 0) : T.pros;
    for (let i = pros.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [pros[i], pros[j]] = [pros[j], pros[i]]; }
    pros.slice(0, Math.min(want, n - 1)).forEach((k) => slots.add(k));
    const [lo, hi] = T.ranks;
    for (let guard = 0; slots.size < n - 1 && guard < 5000; guard++) {
      const k = Math.round(Math.exp(Math.log(lo) + R() * (Math.log(hi) - Math.log(lo))));   // log-uniform: fewer strong players
      if (k > 5 && k <= FIELD_SIZE) slots.add(k);
    }
  }
  const out = [...slots].map((k) => { const f = fieldPlayer(k), rank = slotRank(k, mine); return { ...f, rank, skill: skillFor(rank), you: false }; });
  out.push({ id: 'you', you: true, pro: me.pro || null, name: me.name || 'You', short: me.short || me.name || 'You', country: me.country || '', rank: mine, skill: skillFor(mine), slot: 0 });
  return out;
}
// Place entrants into a bracket: seeds (the best quarter by ranking) in the standard spots, the rest drawn at random.
export function makeDraw(entrants, R) {
  const n = entrants.length, byRank = [...entrants].sort((a, b) => a.rank - b.rank), nSeeds = n / 4, order = seedOrder(n);
  const draw = new Array(n).fill(null), seeds = byRank.slice(0, nSeeds), rest = byRank.slice(nSeeds);
  seeds.forEach((e, i) => { e.seed = i + 1; draw[order.indexOf(i + 1)] = e; });
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  for (let i = 0, j = 0; i < n; i++) if (!draw[i]) draw[i] = rest[j++];
  return draw;
}

// ---- simulated matches between CPU players ----
export const winChance = (a, b) => 1 / (1 + Math.exp(-7 * (a - b)));
// A believable one-set score from the winner's side, closer when the two are close.
export function fakeScore(R, format, close) {
  const G = format === 'full' ? 6 : 4, l = Math.min(G, Math.floor(R() * (G - 1) * (0.45 + 0.55 * close) + (R() < 0.35 * close ? 2 : R() * 1.2)));
  if (l <= G - 2) return `${G}–${l}`;
  if (l === G - 1) return `${G + 1}–${G - 1}`;
  return `${G + 1}–${G} (${Math.floor(R() * 6)})`;
}
// Slot indexes of match m in round r: the draw pairs for r = 0, then the winners of the two feeder matches.
export function pairOf(run, r, m) { return r === 0 ? [2 * m, 2 * m + 1] : [run.wins[r - 1][2 * m], run.wins[r - 1][2 * m + 1]]; }
export const myMatch = (run, r = run.round) => Math.floor(run.me / 2 ** (r + 1));
function simRound(run, r, R) {
  const T = TIERS[eventById(run.ev).tier], count = run.n / 2 ** (r + 1);
  run.wins[r] = run.wins[r] || []; run.scores[r] = run.scores[r] || [];
  for (let m = 0; m < count; m++) {
    if (run.wins[r][m] != null) continue;
    const [a, b] = pairOf(run, r, m);
    if (a == null || b == null) continue;
    const A = run.draw[a], B = run.draw[b];
    if (A.you || B.you) continue;   // yours is played
    const p = winChance(A.skill, B.skill), aw = R() < p;
    run.wins[r][m] = aw ? a : b;
    run.scores[r][m] = fakeScore(R, T.format, 1 - Math.abs(p - 0.5) * 2);
  }
}

// ---- the saved state (Profile.data.tour) ----
export function freshTour() {
  return { v: TOUR_V, season: 1, week: 0, entries: [], run: null, last: null, trophies: [], best: START_RANK, history: [], played: {}, stats: { runs: 0, titles: 0, finals: 0, won: 0, lost: 0, retired: 0, fuzz: 0 } };
}
// Old or partial saves -> the current shape (unknown fields kept).
export function migrateTour(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return freshTour();
  const f = freshTour(), arr = (x) => (Array.isArray(x) ? x : []), obj = (x, d) => (x && typeof x === 'object' && !Array.isArray(x) ? x : d);
  const out = { ...f, ...t, v: TOUR_V, entries: arr(t.entries), trophies: arr(t.trophies), history: arr(t.history).slice(-30), played: obj(t.played, {}), stats: { ...f.stats, ...obj(t.stats, {}) } };
  out.season = Math.max(1, Math.floor(+t.season) || 1); out.week = Math.max(0, Math.min(WEEKS - 1, Math.floor(+t.week) || 0));
  out.best = Math.max(1, Math.min(START_RANK, Math.floor(+t.best) || START_RANK));
  if (out.run && (!eventById(out.run.ev) || !Array.isArray(out.run.draw))) out.run = null;
  return out;
}
export const absWeek = (t) => (t.season - 1) * WEEKS + t.week;
// Rolling points: each week's result counts for a season; last season's result at this week is "defending" until
// this week is done.
export const livePoints = (t) => t.entries.filter((e) => e.i >= absWeek(t) - WEEKS);
export const totalPoints = (t) => livePoints(t).reduce((a, e) => a + e.pts, 0);
export const defending = (t) => t.entries.filter((e) => e.i === absWeek(t) - WEEKS).reduce((a, e) => a + e.pts, 0);
export const rankOf = (t) => rankFor(totalPoints(t));

// ---- editions: the web build plays the Challenger tier; ?edition=steam or ?unlockAll=1 opens the rest ----
let CONFIG = null;
import('./config.js').then((m) => { CONFIG = m.CONFIG || null; }, () => {});
const param = (k) => { try { return new URLSearchParams(globalThis.location?.search || '').get(k); } catch (e) { return null; } };
export const unlockAll = () => param('unlockAll') === '1';
export const edition = () => param('edition') || (CONFIG && CONFIG.edition) || 'full';
export const fullTour = () => unlockAll() || edition() !== 'web';
export const steamUrl = () => (CONFIG && CONFIG.steamUrl) || '';

// Can you enter this event now? { ok, why, steam } (steam: only the Steam edition has it).
export function eligibility(t, ev, level, { week = true } = {}) {
  const T = TIERS[ev.tier], req = reqOf(ev), rank = rankOf(t);
  if (!T.web && !fullTour()) return { ok: false, steam: true, why: 'Full World Tour on Steam' };
  if (unlockAll()) return { ok: true };
  if (week && !CALENDAR[t.week].includes(ev)) return { ok: false, why: 'Not this week' };
  const byRank = req.rank != null && rank <= req.rank, byLevel = req.level != null && level >= req.level;
  if (req.rank == null && req.level == null) return { ok: true };
  if (byRank || byLevel) return { ok: true };
  const parts = [req.rank != null ? `rank #${req.rank}` : '', req.level != null ? `Level ${req.level}` : ''].filter(Boolean);
  return { ok: false, why: `Needs ${parts.join(' or ')}` };
}

// ---- the career, on the Profile ----
const round0 = (x) => Math.round(x);
export const Tour = {
  profile: Profile,
  use(p) { this.profile = p; },   // tests pass their own Profile-like store
  get t() {
    const d = this.profile.data;
    if (!d.tour || d.tour.v !== TOUR_V) d.tour = migrateTour(d.tour);
    return d.tour;
  },
  get rank() { return rankOf(this.t); },
  get points() { return totalPoints(this.t); },
  get run() { return this.t.run; },
  week() { return CALENDAR[this.t.week]; },
  upcoming(n = 4) { const t = this.t, out = []; for (let i = 1; i <= n; i++) { const w = t.week + i; out.push({ week: (w % WEEKS) + 1, season: t.season + Math.floor(w / WEEKS), events: CALENDAR[w % WEEKS] }); } return out; },
  eligibility(ev) { return eligibility(this.t, typeof ev === 'string' ? eventById(ev) : ev, this.profile.level); },
  changed() { const p = this.profile; if (p.changed) p.changed(); else if (p.save) p.save(); },

  // Start an event: builds the field and the draw. me: { name, short, country, pro } (who you are this run).
  enter(id, me = {}) {
    const t = this.t, ev = eventById(id);
    if (!ev || t.run) return null;
    if (!this.eligibility(ev).ok) return null;
    const rank = this.rank, R = rng(`bracket:${this.profile.data.id || ''}:${ev.id}:${t.season}`);
    const draw = makeDraw(makeField(ev, t.season, { ...me, rank }, this.profile.data.id || ''), R);
    t.run = { ev: ev.id, season: t.season, week: t.week, n: draw.length, R: rounds(draw.length), draw, me: draw.findIndex((e) => e.you), round: 0, wins: [], scores: [], live: false, started: Date.now(), rank };
    t.played[ev.id] = t.played[ev.id] || { entered: 0, titles: 0, best: -1 };
    t.played[ev.id].entered++;
    this.changed();
    return t.run;
  },
  // Your next opponent (entrant) and round, or null.
  next() {
    const run = this.run;
    if (!run || run.done) return null;
    const [a, b] = pairOf(run, run.round, myMatch(run));
    const opp = run.draw[a === run.me ? b : a];
    return opp ? { round: run.round, name: roundName(run.R, run.round), opp, final: run.round === run.R - 1 } : null;
  },
  // What UI.startCpu takes for your next match (cfg.tour rides along to the match summary and back here).
  matchOpts(me = {}) {
    const run = this.run, nx = this.next();
    if (!nx) return null;
    const ev = eventById(run.ev), T = TIERS[ev.tier], o = nx.opp;
    return {
      opponent: o.pro ? undefined : o.short, oppHanded: o.handed, surface: ev.surface, tod: ev.tod, format: T.format, level: levelKey(o.skill),
      pros: [me.pro || 'custom', o.pro || 'custom'], countries: [me.country || '', o.country || ''],
      tour: { ev: ev.id, name: ev.name, tier: ev.tier, season: run.season, week: run.week, round: nx.round, rounds: run.R, roundName: nx.name, final: nx.final, opp: o.id, oppName: o.name, oppRank: o.rank, skill: +o.skill.toFixed(3) },
    };
  },
  // The CPU side of a tour match: interpolated LEVELS + persona for the entrant.
  cpuFor(tourCfg) {
    const run = this.run, o = run && run.draw.find((e) => e.id === tourCfg.opp);
    const skill = o ? o.skill : tourCfg.skill ?? 0.3;
    return { level: cpuLevel(skill), persona: o ? personaFor(o) : null, entrant: o || null };
  },
  // Is this match cfg.tour the one the current run is waiting for?
  isCurrent(tc) { const run = this.run; return !!(tc && run && !run.done && tc.ev === run.ev && tc.season === run.season && tc.round === run.round); },
  matchStarted(tc) { if (this.isCurrent(tc)) { this.run.live = true; this.changed(); } },

  // Your match result. score: from the winner's side ("4–2"). Returns the run result when the run ends, else null.
  record(won, score = '', { retired = false } = {}) {
    const t = this.t, run = t.run;
    if (!run || run.done) return null;
    const r = run.round, m = myMatch(run), [a, b] = pairOf(run, r, m), opp = a === run.me ? b : a, R = rng(`sim:${run.ev}:${run.season}:${r}:${run.started}`);
    run.wins[r] = run.wins[r] || []; run.scores[r] = run.scores[r] || [];
    run.wins[r][m] = won ? run.me : opp; run.scores[r][m] = retired ? `${score ? score + ' ' : ''}ret.` : score;
    run.live = false;
    simRound(run, r, R);
    t.stats[won ? 'won' : 'lost']++;
    if (!won) return this.finish(r, { retired });
    if (r === run.R - 1) return this.finish(run.R);
    run.round++;
    this.changed();
    return null;
  },
  // Quitting a match is a retirement (you lose it); before a match it's a withdrawal (same thing, no score).
  retire() { return this.record(false, '', { retired: true }); },
  withdraw() { return this.record(false, '', { retired: true }); },

  // The run is over: points, prize money, trophy, next week.
  finish(reached, { retired = false } = {}) {
    const t = this.t, run = t.run, ev = eventById(run.ev), T = TIERS[ev.tier], P = this.profile, rankFrom = this.rank;
    for (let r = run.round; r < run.R; r++) simRound(run, r, rng(`rest:${run.ev}:${run.season}:${r}:${run.started}`));   // play out the rest
    const champ = run.wins[run.R - 1] && run.wins[run.R - 1][0] != null ? run.draw[run.wins[run.R - 1][0]] : null;
    const pts = T.pts[reached], fuzz = T.fuzz[reached], xp = T.xp[reached], title = reached === run.R;
    t.entries = t.entries.filter((e) => e.i >= absWeek(t) - WEEKS && e.i !== absWeek(t));
    t.entries.push({ i: absWeek(t), ev: ev.id, pts, reached });
    const pl = t.played[ev.id] || (t.played[ev.id] = { entered: 1, titles: 0, best: -1 });
    pl.best = Math.max(pl.best, reached);
    if (title) { pl.titles++; t.stats.titles++; t.trophies.push({ ev: ev.id, name: ev.name, tier: ev.tier, surface: ev.surface, season: run.season, t: Date.now() }); }
    if (reached >= run.R - 1) t.stats.finals++;
    t.stats.runs++; t.stats.fuzz += fuzz; if (retired) t.stats.retired++;
    if (P.addFuzz) P.addFuzz(fuzz, `tour ${ev.id}`);
    if (P.addXP) P.addXP(xp, `tour ${ev.id}`);
    const res = { ev: ev.id, name: ev.name, tier: ev.tier, season: run.season, week: run.week, reached, R: run.R, label: reachedName(run.R, reached), title, retired, pts, fuzz, xp, rankFrom, champion: champ ? { id: champ.id, name: champ.name, you: !!champ.you } : null, t: Date.now() };
    t.last = { ...res, draw: run.draw, wins: run.wins, scores: run.scores, me: run.me, n: run.n };
    t.history.push(res); if (t.history.length > 30) t.history.splice(0, t.history.length - 30);
    t.run = null;
    this.advance();
    res.rankTo = this.rank; t.last.rankTo = res.rankTo;
    t.best = Math.min(t.best, res.rankTo);
    this.changed();
    Bus.emit('tour:result', res);
    return res;
  },
  // Next week (a new season after the Finals week). Your points from a season ago drop as their week comes round.
  advance() {
    const t = this.t;
    t.week++;
    if (t.week >= WEEKS) { t.week = 0; t.season++; }
    t.entries = t.entries.filter((e) => e.i >= absWeek(t) - WEEKS);
  },
  skipWeek() { if (this.t.run) return false; this.advance(); this.changed(); return true; },
  // A match that was being played when the page closed: the round is played again.
  recover() { const run = this.t.run; if (run && run.live) { run.live = false; this.changed(); return true; } return false; },
  reset() { this.profile.data.tour = freshTour(); this.changed(); },
};

// ---- follow tour matches on the Bus ----
const gamesOf = (e) => { const m = e.match, me = e.localIdx, op = 1 - me; return m.tbOnly ? [m.pts[me], m.pts[op]] : [m.games[me], m.games[op]]; };
Bus.on('match:start', ({ cfg }) => { if (cfg && cfg.tour) Tour.matchStarted(cfg.tour); });
Bus.on('match:end', (e) => {
  const tc = e.cfg && e.cfg.tour;
  if (!tc || e.localIdx < 0 || !Tour.isCurrent(tc)) return;
  const won = e.winner === e.localIdx, g = gamesOf(e), tb = e.match.tb && !e.match.tbOnly ? ` (${Math.min(e.match.pts[0], e.match.pts[1])})` : '';
  const score = won ? `${g[0]}–${g[1]}${tb}` : `${g[1]}–${g[0]}${tb}`;
  const res = Tour.record(won, score);
  Bus.emit('tour:match', { won, score, ended: res, tour: tc });
});
Bus.on('match:quit', ({ cfg }) => {
  const tc = cfg && cfg.tour;
  if (!tc || !Tour.isCurrent(tc)) return;
  const res = Tour.retire();
  Bus.emit('tour:match', { won: false, score: 'ret.', retired: true, ended: res, tour: tc });
});
if (Profile.ready) Profile.ready.then(() => { if (Tour.profile === Profile && Profile.loaded) Tour.recover(); });
