// Palm Court: player stats from the pro you play as and the gear you have equipped (the grind: play more, earn Fuzz,
// buy and upgrade better gear, play better). Stats.forPlayer(p) returns S, a frozen object of multipliers:
//   { fh: {pow, ctl, spin}, bh: {pow, ctl, spin}, serve: {pow, ctl}, volley: {ctl}, touch, move: {speed, react}, reach }
// 1.0 = the Starter kit on your own player. pow scales ball speed, ctl divides error and spread (higher = more
// accurate), spin scales spin, touch = drops, slices and lobs, move / reach = footwork. S = the pro's base profile ×
// (1 + the equipped gear's deltas), clamped to STAT_MIN..STAT_MAX so no combination leaves the range the physics and
// the shot model were tuned for. The CPU gets gear that fits its level (Practice) or tour strength; online matches are
// neutral (all 1.0) unless Settings.onlineGear is on. The shot model (game.js groundShot / serveShot) applies
// pow / ctl / spin / touch; game.js startMatch / cpuTune / contact apply move and reach.
// No DOM: runs in plain Node for the tests.
import { Settings } from './core.js';
import { CATALOG, GEAR_SLOTS, GEAR_TIERS, STARTER_GEAR, itemById, isGear, gearStats, upgradeOf } from './economy.js';
import { Profile } from './profile.js';

export const STAT_MIN = 0.85, STAT_MAX = 1.25;
// Every stat, as a path into S.
export const PATHS = ['fh.pow', 'fh.ctl', 'fh.spin', 'bh.pow', 'bh.ctl', 'bh.spin', 'serve.pow', 'serve.ctl', 'volley.ctl', 'touch', 'move.speed', 'move.react', 'reach'];
// The short words gear and pro profiles are written in, and the stats each one moves (a full path works too).
export const EXPAND = {
  pow: ['fh.pow', 'bh.pow', 'serve.pow'], ctl: ['fh.ctl', 'bh.ctl', 'serve.ctl', 'volley.ctl'], spin: ['fh.spin', 'bh.spin'],
  serve: ['serve.pow', 'serve.ctl'], volley: ['volley.ctl'], touch: ['touch'], speed: ['move.speed'], react: ['move.react'], reach: ['reach'],
  fh: ['fh.pow', 'fh.ctl', 'fh.spin'], bh: ['bh.pow', 'bh.ctl', 'bh.spin'],
};
export const WORDS = { pow: 'Power', ctl: 'Control', spin: 'Spin', serve: 'Serve', volley: 'Volley', touch: 'Touch', speed: 'Speed', react: 'Reaction', reach: 'Reach' };

// ---- the pros: 1-2 signature strengths and a mild weakness each (deltas, like gear). Your own player is neutral. ----
export const PRO_BASE = {
  custom: {},
  // Rivas, the lefty clay grinder: the heaviest topspin forehand in the game and tireless legs; the serve is his weak spot.
  rivas: { 'fh.spin': 0.12, 'fh.pow': 0.06, 'fh.ctl': 0.05, speed: 0.03, serve: -0.04, volley: -0.03 },
  // Adler, elegant all-court: the one-handed backhand, a smooth serve, volleys and touch; not the quickest first step.
  adler: { 'bh.ctl': 0.08, 'bh.pow': 0.06, 'bh.spin': 0.04, serve: 0.06, volley: 0.08, touch: 0.07, react: -0.03, speed: -0.02 },
  // Varga, the wall: footwork, reactions (the return) and stretch, steady off both wings; less free power.
  varga: { react: 0.1, speed: 0.06, reach: 0.07, 'bh.ctl': 0.04, 'fh.ctl': 0.03, 'fh.pow': -0.03, 'serve.pow': -0.03 },
  // Ferro, flat power off both wings and a big serve; a flatter ball with less spin and less touch.
  ferro: { 'fh.pow': 0.1, 'bh.pow': 0.1, 'serve.pow': 0.05, spin: -0.07, touch: -0.05 },
  // Aranda, speed and drop shots: the fastest legs and the best hands; a little erratic.
  aranda: { speed: 0.08, react: 0.05, touch: 0.12, 'fh.pow': 0.03, ctl: -0.04 },
};

// ---- building S ----
const add = (acc, deltas) => {
  for (const [k, v] of Object.entries(deltas || {})) for (const path of EXPAND[k] || (PATHS.includes(k) ? [k] : [])) acc[path] = (acc[path] || 0) + v;
  return acc;
};
const clampS = (v) => Math.max(STAT_MIN, Math.min(STAT_MAX, v));
function shape(flat) {
  const g = (k) => +clampS(flat[k] ?? 1).toFixed(4);
  return Object.freeze({
    fh: Object.freeze({ pow: g('fh.pow'), ctl: g('fh.ctl'), spin: g('fh.spin') }),
    bh: Object.freeze({ pow: g('bh.pow'), ctl: g('bh.ctl'), spin: g('bh.spin') }),
    serve: Object.freeze({ pow: g('serve.pow'), ctl: g('serve.ctl') }), volley: Object.freeze({ ctl: g('volley.ctl') }),
    touch: g('touch'), move: Object.freeze({ speed: g('move.speed'), react: g('move.react') }), reach: g('reach'),
  });
}
export const NEUTRAL = shape({});
export const get = (S, path) => path.split('.').reduce((o, k) => o[k], S);
// S in the gear words (both wings averaged), for the shop's compare: { pow, ctl, spin, serve, volley, touch, speed, react, reach }.
export const summary = (S) => ({
  pow: (S.fh.pow + S.bh.pow) / 2, ctl: (S.fh.ctl + S.bh.ctl) / 2, spin: (S.fh.spin + S.bh.spin) / 2, serve: (S.serve.pow + S.serve.ctl) / 2,
  volley: S.volley.ctl, touch: S.touch, speed: S.move.speed, react: S.move.react, reach: S.reach,
});
// Names for every stat path and profile key (the Locker's "Your stats" and the pro picker's strengths).
export const LABELS = {
  'fh.pow': 'Forehand power', 'fh.ctl': 'Forehand control', 'fh.spin': 'Forehand spin', 'bh.pow': 'Backhand power', 'bh.ctl': 'Backhand control', 'bh.spin': 'Backhand spin',
  'serve.pow': 'Serve pace', 'serve.ctl': 'Serve accuracy', 'volley.ctl': 'Volleys', touch: 'Touch', 'move.speed': 'Speed', 'move.react': 'Reactions', reach: 'Reach',
  pow: 'Power', ctl: 'Control', spin: 'Spin', serve: 'Serve', volley: 'Volleys', speed: 'Speed', react: 'Reactions', fh: 'Forehand', bh: 'Backhand',
};
const cache = new Map();
// S for a pro id and a gear list [{ id, up }] (ids that aren't gear are skipped).
export function build(pro = 'custom', gear = []) {
  const list = gear.filter((g) => g && isGear(itemById(g.id))).map((g) => ({ id: itemById(g.id).id, up: g.up | 0 }));
  const key = `${PRO_BASE[pro] ? pro : 'custom'}|${list.map((g) => `${g.id}+${g.up}`).join(',')}`;
  let S = cache.get(key);
  if (S) return S;
  const base = add({}, PRO_BASE[pro]), plus = {};
  for (const g of list) add(plus, gearStats(g.id, g.up));
  const flat = {};
  for (const p of PATHS) flat[p] = (1 + (base[p] || 0)) * (1 + (plus[p] || 0));
  S = shape(flat);
  if (cache.size > 200) cache.clear();
  cache.set(key, S);
  return S;
}
// A loadout ({ slot: id }, upgrades { id: n }) as the gear list build() takes.
export const loadout = (equipped = {}, ups = {}) => GEAR_SLOTS.map((s) => ({ id: equipped[s] || STARTER_GEAR[s], up: ups[equipped[s]] | 0 }));

// ---- the CPU's gear: its tier from its level (Practice) or tour strength (the level's label), then per slot the item of
// that tier that suits its persona best. So a Pro CPU carries what a player has at about level 10-20 and the grind
// doesn't make the ladder trivial. '+' levels (tour) carry upgrades.
export const CPU_KIT = { Rookie: ['starter', 0], 'Rookie+': ['club', 0], Club: ['club', 0], 'Club+': ['club', 3], Pro: ['pro', 0], 'Pro+': ['pro', 3], Elite: ['elite', 2] };
function suits(item, persona = {}) {
  const w = (k) => 0.5 + (Number.isFinite(persona[k]) ? persona[k] : 0.5);
  const weight = { pow: w('aggression'), ctl: w('consistency'), spin: w('topspin'), serve: w('serve'), volley: w('net'), touch: (w('drop') + w('slice')) / 2, speed: w('speed'), react: w('defense'), reach: w('defense') };
  return Object.entries(item.stats).reduce((a, [k, v]) => a + v * (weight[k] ?? 1), 0);
}
export function cpuGear(level, persona) {
  const [tier, up] = CPU_KIT[level && level.label] || CPU_KIT.Club;
  return GEAR_SLOTS.map((slot) => {
    const items = CATALOG.filter((i) => i.kind === slot && i.tier === tier);
    if (!items.length) return { id: STARTER_GEAR[slot], up: 0 };   // no item of that tier in this slot: the starter one
    let best = items[0], bs = -Infinity;
    for (const i of items) { const s = suits(i, persona || {}); if (s > bs + 1e-9) { bs = s; best = i; } }
    return { id: best.id, up: tier === 'starter' ? 0 : up };
  });
}

// ---- the match being played (game.js startMatch calls begin(cfg) before it sets the players up) ----
let match = { mode: 'idle' }, profile = Profile;

export const Stats = {
  STAT_MIN, STAT_MAX, PATHS, NEUTRAL, PRO_BASE, WORDS, LABELS, build, loadout, cpuGear, get, summary,
  begin(cfg) { match = { mode: (cfg && cfg.mode) || 'idle' }; },
  // S for a game.js player ({ pro, ctl, level, persona }). o: { mode, onlineGear, gear: [{ id, up }] } overrides (tests).
  forPlayer(p, o = {}) {
    if (!p) return NEUTRAL;
    const mode = o.mode ?? match.mode, onlineGear = o.onlineGear ?? Settings.onlineGear;
    if (mode === 'online' && !onlineGear) return NEUTRAL;   // fair by default: nobody's grind decides an online match
    const pro = p.pro || 'custom';
    if (o.gear) return build(pro, o.gear);
    if (p.ctl === 'human') return build(pro, this.mine());
    if (p.ctl === 'cpu') return build(pro, cpuGear(p.level, p.persona));
    return build(pro, []);   // 'remote' (their own machine plays their shots) and the drill's ball machine
  },
  // Your equipped gear with its upgrades.
  mine(over = {}) { const eq = { ...((profile && profile.equipped) || {}), ...over }, P = profile; return loadout(eq, {}).map((g) => ({ id: g.id, up: upgradeOf(g.id, P) })); },
  // What you'd have as `pro` with `over` ({ slot: id }) equipped instead (the Pro Shop's compare).
  preview(pro = 'custom', over = {}) { return build(pro, this.mine(over)); },
  forPro(pro) { return build(pro, []); },
  // A pro's signature strengths (the top n) and their weak spot, for the pro picker: [{ key, label, v }].
  strengths(pro, n = 3) {
    const e = Object.entries(PRO_BASE[pro] || {}), pos = e.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, n), neg = e.filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]).slice(0, 1);
    return [...pos, ...neg].map(([key, v]) => ({ key, label: LABELS[key] || key, v }));
  },
  tierOf: (i) => GEAR_TIERS.find((t) => t.key === (typeof i === 'string' ? itemById(i) : i)?.tier) || GEAR_TIERS[0],
  // For tests: read gear from a stand-in profile ({ equipped, upgrades }).
  useProfile(p) { profile = p; },
};
