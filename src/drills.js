// Palm Court: training drills as data and pure functions (no DOM, no three.js: runs in plain Node for the tests).
// The drills (target practice, serve speed, rally streak) and the first-run tutorial's guided rally: their target
// zones, scoring, grades, the rally feeder's ramp, and the live coaching hint for each control mode.
// src/training.js runs them in the game; rewards are economy.trainingRewards, paid by Progress.applyTraining.
import { LEVELS, inCourt, inServiceBox } from './core.js';

// kind 'balls': ends after `balls` balls (or maxSecs, if the player stops); 'time': after `secs` seconds. `pb` is what
// the personal best keeps.
export const DRILLS = [
  { id: 'target', name: 'Target practice', kind: 'balls', balls: 20, maxSecs: 150, pb: 'score', unit: 'pts',
    blurb: 'The ball machine feeds you 20 balls. Hit the glowing zones: deep cross-court, down the line and the short angle.' },
  { id: 'serve', name: 'Serve speed', kind: 'balls', balls: 12, maxSecs: 150, pb: 'kmh', unit: 'km/h',
    blurb: 'Twelve serves at the lit box. Toss, hit, see the speed: every serve that goes in scores.' },
  { id: 'rally', name: 'Rally streak', kind: 'time', secs: 90, pb: 'streak', unit: 'shots',
    blurb: '90 seconds against a steady feeder. Keep the ball in the court: the pace picks up every few shots.' },
];
export const drillById = (id) => DRILLS.find((d) => d.id === id) || (id === 'tutorial' ? TUTORIAL : null);
// The first-run tutorial's guided rally: a few balls to each side, then serves. Each step moves on after `goal`
// good ones, or after `max` tries anyway (a guide, not a test).
export const TUTORIAL = { id: 'tutorial', name: 'Tutorial', kind: 'steps', maxSecs: 300, unit: '' };
export const TUTORIAL_STEPS = [
  { id: 'fh', stroke: 'fh', title: 'Forehand', goal: 2, max: 6 },
  { id: 'bh', stroke: 'bh', title: 'Backhand', goal: 2, max: 6 },
  { id: 'serve', title: 'Serve', goal: 2, max: 6 },
];

// ---- grades: [S, A, B, C] thresholds on the drill's score; below the last is D ----
export const GRADES = { target: [50, 38, 26, 14], serve: [170, 130, 90, 50], rally: [20, 12, 7, 3] };
export function gradeFor(drill, score) {
  const t = GRADES[drill];
  if (!t) return '';
  for (let i = 0; i < t.length; i++) if (score >= t[i]) return 'SABC'[i];
  return 'D';
}

// ---- target zones ----
// In the hitter's frame: u = across (+ = towards the side the ball was fed to), d = depth past the net (metres).
// Cross-court zones sit on the other side from the feed. Timing aims a shot (early pulls it cross-court, late sends it
// down the line), so the zones teach timing as much as accuracy.
export const ZONES = {
  cross: { name: 'Deep cross-court', u: [1.0, 4.115], d: [8.2, 11.885], cross: true, tip: 'swing a touch early' },
  line: { name: 'Down the line', u: [1.7, 4.115], d: [7.0, 11.885], cross: false, tip: 'swing a touch late' },
  angle: { name: 'Short angle', u: [2.3, 4.115], d: [3.6, 8.9], cross: true, tip: 'early, with slice' },
};
export const ZONE_ORDER = ['cross', 'line', 'cross', 'angle', 'line'];
// The zone as a court rectangle { x0, x1, z0, z1 } for a ball fed to feedSide (+1 = the hitter's right) and a hitter
// on `side` (+1 = the near end, z > 0).
export function zoneRect(key, feedSide, side = 1) {
  const Z = ZONES[key], s = (Z.cross ? -feedSide : feedSide) * side;
  const xs = [Z.u[0] * s, Z.u[1] * s].sort((a, b) => a - b), zs = [-Z.d[0] * side, -Z.d[1] * side].sort((a, b) => a - b);
  return { x0: xs[0], x1: xs[1], z0: zs[0], z1: zs[1] };
}
export const inRect = (r, x, z, pad = 0.03) => !!r && x >= r.x0 - pad && x <= r.x1 + pad && z >= r.z0 - pad && z <= r.z1 + pad;
// Where a shot's first bounce put it: 'zone' | 'in' | 'out' | 'net' (it came down on the hitter's own half, or never
// bounced). bounce = { x, z } or null.
export function judgeShot(bounce, side = 1, rect = null) {
  if (!bounce || Math.sign(bounce.z || 1e-9) === side) return 'net';
  if (!inCourt(bounce.x, bounce.z)) return 'out';
  return inRect(rect, bounce.x, bounce.z) ? 'zone' : 'in';
}
// Target practice points: a zone is 3 (4 with clean timing), anywhere else in the court 1.
export const targetPoints = (res, clean) => (res === 'zone' ? 3 + (clean ? 1 : 0) : res === 'in' ? 1 : 0);
// A serve: 'in' | 'out' | 'net' from its first bounce (receiver on -side), and its points (km/h / 10 when in).
export function judgeServe(bounce, court, side = 1) {
  if (!bounce || Math.sign(bounce.z || 1e-9) === side) return 'net';
  return inServiceBox(bounce.x, bounce.z, -side, court) ? 'in' : 'out';
}
export const servePoints = (res, kmh) => (res === 'in' ? Math.round((kmh || 0) / 10) : 0);
// The service box to aim at, as a court rectangle (server on `side`).
export function serviceRect(court, side = 1) {
  const r = -side, s = court === 'deuce' ? r : -r;   // inServiceBox: x * s runs 0..4.115 inside the box
  const xs = [0, 4.115 * s].sort((a, b) => a - b), zs = [0, 6.4 * r].sort((a, b) => a - b);
  return { x0: xs[0], x1: xs[1], z0: zs[0], z1: zs[1] };
}
export const CLEAN = 0.35;   // |tau| under this is clean timing (the HUD's "On time")

// ---- the rally feeder: steady, and a little quicker every few good returns ----
export const RALLY_STEP = 4;   // good returns per step up
export const RALLY_TIERS = [
  { label: 'Warm-up', power: [0.12, 0.3], err: 0.35, aggression: 0.05 },
  { label: 'Steady', power: [0.2, 0.42], err: 0.4, aggression: 0.15 },
  { label: 'Rolling', power: [0.3, 0.55], err: 0.45, aggression: 0.3 },
  { label: 'Pressing', power: [0.4, 0.7], err: 0.5, aggression: 0.45 },
  { label: 'Match pace', power: [0.5, 0.85], err: 0.55, aggression: 0.6 },
];
export const rallyTier = (good) => Math.min(RALLY_TIERS.length - 1, Math.floor(Math.max(0, good) / RALLY_STEP));
// A CPU level (see core.js LEVELS) for the feeder at a tier: a pro's legs, so it reaches your ball and the streak is
// yours to lose; low error and little risk; shot pace from the tier. Plus the persona that keeps it at the baseline.
export function feederLevel(tier) {
  const T = RALLY_TIERS[Math.max(0, Math.min(RALLY_TIERS.length - 1, tier | 0))];
  return { ...LEVELS.club, speed: LEVELS.pro.speed, acc: LEVELS.pro.acc, react: LEVELS.pro.react, label: T.label, power: T.power.slice(), err: T.err, iq: 0.15, pos: 0.12, judge: 0.25, risk: 0.1 };
}
export function feederPersona(tier) {
  const T = RALLY_TIERS[Math.max(0, Math.min(RALLY_TIERS.length - 1, tier | 0))];
  return { aggression: T.aggression, topspin: 0.45, slice: 0.1, drop: 0, net: 0, serve: 0.5, consistency: 0.95, defense: 0.8, speed: 0.7 };
}

// ---- live coaching hint, for the control in use ----
// ctx: { control: 'mouse'|'hand'|'paddle'|'phone', pad (a controller is in use), touch (a touch screen), glyph (the
// controller's A button name), handed: 'R'|'L', phase: 'ready'|'incoming'|'now'|'serve'|'toss', stroke: 'fh'|'bh',
// feedback: null|'early'|'late'|'miss'|'wrong'|'good'|'clean'|'zone'|'out'|'net'|'in', zone: ZONES key or null, serve: the
// feedback is about a serve }.
// Returns { arrow, head, text, tone: ''|'now'|'warn'|'good' }. The arrow is the swing's direction across the body as the
// player sees it in the mirrored camera picture (a right-hander's forehand sweeps right to left), like the HUD's hint.
export function strokeArrow(stroke, handed = 'R') { return (stroke === 'fh') === (handed !== 'L') ? '←' : '→'; }
const STROKE = { fh: 'Forehand', bh: 'Backhand' };
export function coachHint(ctx = {}) {
  const c = ctx.control || 'mouse', mode = ctx.pad ? 'pad' : c, cam = mode === 'hand' || mode === 'paddle', phone = mode === 'phone';
  const A = ctx.glyph || 'A', stroke = ctx.stroke === 'bh' ? 'bh' : 'fh', arrow = strokeArrow(stroke, ctx.handed);
  const thing = mode === 'paddle' ? 'the paddle' : mode === 'phone' ? 'your phone' : 'your hand';
  const verb = mode === 'pad' ? `Press ${A}` : mode === 'mouse' ? (ctx.touch ? 'Tap' : 'Click (or press Space)') : cam ? `Swing ${thing} across your body ${arrow}` : `Swing your phone ${arrow}`;
  const zone = ctx.zone && ZONES[ctx.zone];
  const aim = zone ? `${zone.name}: ${zone.tip}.` : '';
  const f = ctx.feedback;
  // What the last ball taught comes first, while the next one is on its way.
  if (f && (ctx.phase === 'ready' || ctx.phase === 'incoming')) {
    if (f === 'early') return { arrow: '', head: 'A bit early', text: cam || phone ? 'Wait a moment longer: swing as the ball reaches your side.' : 'Wait for the ball to reach you, then swing.', tone: 'warn' };
    if (f === 'late') return { arrow: '', head: 'A bit late', text: 'Swing earlier: start as the ball bounces on your side.', tone: 'warn' };
    if (f === 'miss') return { arrow: cam || phone ? arrow : '', head: 'Swing!', text: `${verb} as the ball reaches you. Your player does the running.`, tone: 'warn' };
    if (f === 'wrong') return { arrow, head: 'Other way', text: `A ${STROKE[stroke].toLowerCase()} goes ${arrow}: swing across your body the other way.`, tone: 'warn' };
    if (ctx.serve && (f === 'out' || f === 'net')) return { arrow: '', head: f === 'net' ? 'Net' : 'Out', text: 'Hit it just as the ball starts to drop. The harder you swing, the more it can miss.', tone: 'warn' };
    if (ctx.serve && f === 'in') return { arrow: '', head: 'In!', text: 'A faster swing serves faster, and scores more.', tone: 'good' };
    if (f === 'out') return { arrow: '', head: 'Out', text: 'A slower, smoother swing keeps it in. Timing aims it.', tone: 'warn' };
    if (f === 'net') return { arrow: '', head: 'Net', text: mode === 'mouse' ? 'Flick the mouse upward as you click for topspin and height.' : 'Swing low to high to lift it over the net.', tone: 'warn' };
    if (f === 'clean') return { arrow: '', head: 'Clean timing!', text: aim || 'Just like that.', tone: 'good' };
    if (f === 'zone') return { arrow: '', head: 'On target!', text: aim || 'Keep it going.', tone: 'good' };
    if (f === 'good' || f === 'in') return { arrow: '', head: 'Good', text: aim || 'Keep it going.', tone: 'good' };
  }
  if (ctx.phase === 'serve') {
    const text = mode === 'pad' ? `Press ${A} to toss the ball.` : mode === 'mouse' ? `${ctx.touch ? 'Tap' : 'Click (or press Space)'} to toss the ball.` : cam ? `Raise ${thing} above the toss line to toss.` : 'Tap your phone, or lift it, to toss.';
    return { arrow: cam ? '↑' : '', head: 'Serve', text, tone: '' };
  }
  if (ctx.phase === 'toss') {
    const text = mode === 'pad' ? `Press ${A} again as the ball starts to drop.` : mode === 'mouse' ? `${ctx.touch ? 'Tap' : 'Click'} again as the ball starts to drop.` : cam ? `Swing ${thing} down through the ball as it starts to drop.` : 'Swing your phone overhead as the ball starts to drop.';
    return { arrow: cam ? '↓' : '', head: 'Hit it', text, tone: 'now' };
  }
  if (ctx.phase === 'now') return { arrow: cam || phone ? arrow : '', head: 'Swing now!', text: aim || STROKE[stroke], tone: 'now' };
  if (ctx.phase === 'incoming') {
    const how = `${verb} as the ball reaches you.`;
    return { arrow: cam || phone ? arrow : '', head: STROKE[stroke], text: aim ? `${how} ${aim}` : how, tone: '' };
  }
  // Waiting for the next ball: how this control works.
  const ready = {
    mouse: 'Your player runs to the ball: you only swing. Early pulls it cross-court, late sends it down the line.',
    pad: `${A} or a flick of the right stick swings. RT hits harder, LT slices.`,
    hand: 'Stand back so your hand stays in the picture on both sides. Your player does the running.',
    paddle: 'Keep the paddle in the picture on both sides. Your player does the running.',
    phone: 'Hold your phone like a racket handle. Your player does the running.',
  }[mode] || '';
  return { arrow: '', head: 'Get ready', text: aim || ready, tone: '' };
}
