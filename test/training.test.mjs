// Training drill checks (no browser): target zones, shot and serve judging, grades, the rally feeder's ramp, the
// coaching hint for every control mode, training rewards (small, capped per day) and personal bests on the Profile.
// Run: node test/training.test.mjs
import assert from 'node:assert/strict';
import * as D from '../src/drills.js';
import * as E from '../src/economy.js';
import { inServiceBox, inCourt } from '../src/core.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await test('zones sit where their names say, for either feed side', () => {
  for (const side of [1, -1]) {
    const cross = D.zoneRect('cross', side), line = D.zoneRect('line', side), angle = D.zoneRect('angle', side);
    assert.ok(Math.sign((cross.x0 + cross.x1) / 2) === -side, 'cross-court is on the other side from the feed');
    assert.ok(Math.sign((line.x0 + line.x1) / 2) === side, 'down the line is on the feed side');
    assert.ok(Math.sign((angle.x0 + angle.x1) / 2) === -side);
    for (const r of [cross, line, angle]) {
      assert.ok(r.x0 < r.x1 && r.z0 < r.z1 && r.z1 < 0, 'in the far half');
      assert.ok(inCourt((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2), 'inside the singles court');
    }
    assert.ok(Math.abs(angle.z1) < Math.abs(cross.z1) && Math.max(Math.abs(angle.z0), Math.abs(angle.z1)) <= 8.2 + 1e-9, 'the short angle is short');
  }
  // The far end's hitter mirrors everything.
  const far = D.zoneRect('cross', 1, -1);
  assert.ok(far.z0 > 0 && (far.x0 + far.x1) / 2 > 0);
});

await test('shots are judged by their first bounce', () => {
  const r = D.zoneRect('cross', 1);
  assert.equal(D.judgeShot({ x: -2.5, z: -10 }, 1, r), 'zone');
  assert.equal(D.judgeShot({ x: 2.5, z: -10 }, 1, r), 'in');
  assert.equal(D.judgeShot({ x: 5, z: -10 }, 1, r), 'out');
  assert.equal(D.judgeShot({ x: 0, z: -12.5 }, 1, r), 'out');
  assert.equal(D.judgeShot({ x: 0, z: 3 }, 1, r), 'net', 'landed on the hitter\'s own half');
  assert.equal(D.judgeShot(null, 1, r), 'net');
  assert.equal(D.targetPoints('zone', true), 4); assert.equal(D.targetPoints('zone', false), 3);
  assert.equal(D.targetPoints('in', true), 1); assert.equal(D.targetPoints('out', true), 0);
});

await test('serve boxes match the game\'s service-box rule', () => {
  for (const court of ['deuce', 'ad']) {
    const r = D.serviceRect(court, 1), cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    assert.ok(inServiceBox(cx, cz, -1, court), court);
    assert.equal(D.judgeServe({ x: cx, z: cz }, court, 1), 'in');
    assert.equal(D.judgeServe({ x: -cx, z: cz }, court, 1), 'out', 'the wrong box');
    assert.equal(D.judgeServe({ x: cx, z: -8 }, court, 1), 'out', 'long');
    assert.equal(D.judgeServe({ x: cx, z: 2 }, court, 1), 'net');
  }
  // The server stands right of centre in the deuce court (x > 0 for the near end): the box is across, x < 0.
  assert.ok(D.serviceRect('deuce', 1).x1 <= 0 && D.serviceRect('ad', 1).x0 >= 0);
  assert.equal(D.servePoints('in', 176), 18); assert.equal(D.servePoints('out', 200), 0);
});

await test('grades rise with the score', () => {
  for (const id of ['target', 'serve', 'rally']) {
    const order = [-1, 0, 5, 14, 26, 38, 50, 90, 130, 170, 400].map((s) => 'DCBAS'.indexOf(D.gradeFor(id, s)));
    for (let i = 1; i < order.length; i++) assert.ok(order[i] >= order[i - 1], id);
    assert.equal(D.gradeFor(id, 1e6), 'S'); assert.equal(D.gradeFor(id, 0), 'D');
  }
  assert.equal(D.gradeFor('tutorial', 5), '');
});

await test('the rally feeder ramps up and stays steady', () => {
  assert.equal(D.rallyTier(0), 0); assert.equal(D.rallyTier(D.RALLY_STEP), 1); assert.equal(D.rallyTier(999), D.RALLY_TIERS.length - 1);
  for (let t = 1; t < D.RALLY_TIERS.length; t++) {
    const a = D.feederLevel(t - 1), b = D.feederLevel(t);
    assert.ok(b.power[1] > a.power[1] && b.power[0] >= a.power[0], 'more pace each tier');
    assert.ok(b.err <= 0.6, 'few errors');
    assert.ok(D.feederPersona(t).aggression >= D.feederPersona(t - 1).aggression);
  }
  const L = D.feederLevel(0);
  for (const k of ['speed', 'acc', 'react', 'err', 'power', 'serve', 'iq', 'pos', 'judge', 'sErr', 'risk']) assert.ok(k in L, k);
  assert.equal(D.feederPersona(2).drop, 0, 'no drop shots from a feeder');
});

await test('every control mode gets a hint in every phase', () => {
  const phases = ['ready', 'incoming', 'now', 'serve', 'toss'], fbs = [null, 'early', 'late', 'miss', 'wrong', 'good', 'clean', 'zone', 'out', 'net', 'in'];
  for (const control of ['mouse', 'hand', 'paddle', 'phone']) for (const pad of [false, true]) for (const phase of phases) for (const feedback of fbs) for (const zone of [null, 'cross', 'line', 'angle']) {
    const h = D.coachHint({ control, pad, handed: 'R', phase, stroke: 'bh', feedback, zone, glyph: '✕' });
    assert.ok(h && h.head && h.text, `${control} ${pad} ${phase} ${feedback}`);
    assert.ok(['', 'now', 'warn', 'good'].includes(h.tone));
    assert.ok(!/undefined|null|NaN/.test(h.head + h.text), h.text);
  }
  // Camera swings get the direction arrow (mirrored picture: a right-hander's forehand goes right to left).
  assert.equal(D.coachHint({ control: 'hand', phase: 'incoming', stroke: 'fh', handed: 'R' }).arrow, '←');
  assert.equal(D.coachHint({ control: 'paddle', phase: 'incoming', stroke: 'bh', handed: 'R' }).arrow, '→');
  assert.equal(D.coachHint({ control: 'hand', phase: 'incoming', stroke: 'fh', handed: 'L' }).arrow, '→');
  assert.equal(D.coachHint({ control: 'mouse', phase: 'incoming', stroke: 'fh' }).arrow, '');
  assert.match(D.coachHint({ control: 'hand', phase: 'ready', feedback: 'late' }).text, /earlier/);
  assert.match(D.coachHint({ control: 'mouse', phase: 'incoming', zone: 'line' }).text, /late/);
  assert.match(D.coachHint({ control: 'mouse', pad: true, phase: 'serve', glyph: '✕' }).text, /✕/);
  assert.match(D.coachHint({ control: 'hand', phase: 'serve' }).text, /toss line/);
  assert.equal(D.coachHint({ control: 'hand', phase: 'now', stroke: 'fh' }).tone, 'now');
});

await test('drill definitions are complete', () => {
  for (const d of D.DRILLS) {
    assert.ok(d.id && d.name && d.blurb && d.unit && d.pb);
    assert.ok(d.kind === 'time' ? d.secs >= 60 && d.secs <= 90 : d.balls >= 10 && d.balls <= 20 && d.maxSecs > 0, 'short: 60-90 s or up to 20 balls');
    assert.equal(D.drillById(d.id), d);
  }
  assert.equal(D.drillById('tutorial'), D.TUTORIAL);
  assert.equal(D.drillById('nope'), null);
  assert.deepEqual(D.TUTORIAL_STEPS.map((s) => s.id), ['fh', 'bh', 'serve']);
});

await test('training rewards are small and capped per day', () => {
  const S = (o = {}) => ({ mode: 'training', drill: 'target', name: 'Target practice', grade: 'S', score: 60, pb: 60, ...o });
  const r = E.rewardsFor(S(), {});
  assert.equal(r.xp, E.TRAINING.base[0] + E.TRAINING.grade.S[0]);
  assert.equal(r.fuzz, E.TRAINING.base[1] + E.TRAINING.grade.S[1]);
  // A top-grade drill with a personal best (about a minute) pays well under half of a lost short set (several minutes).
  const loss = E.rewardsFor({ mode: 'cpu', won: false, format: 'short', level: 'club', points: 12 });
  assert.ok((r.xp + E.TRAINING.best[0]) * 2 < loss.xp, `${r.xp} vs ${loss.xp}`);
  // A day of drilling can't pay more than the cap, however many runs.
  const today = { xp: 0, fuzz: 0 };
  let paid = 0, capped = false;
  for (let i = 0; i < 60; i++) {
    const x = E.trainingRewards(S({ grade: 'S' }), { today, newBest: i % 3 === 0 });
    today.xp += x.counted.xp; today.fuzz += x.counted.fuzz; paid += x.xp; capped ||= x.capped;
    assert.ok(x.xp >= 0 && x.fuzz >= 0);
  }
  assert.ok(capped);
  assert.equal(paid, E.TRAINING.daily[0]); assert.equal(today.fuzz, E.TRAINING.daily[1]);
  const after = E.trainingRewards(S(), { today });
  assert.equal(after.xp, 0); assert.equal(after.fuzz, 0);
  assert.ok(after.lines.some((l) => /cap/i.test(l.label)));
  // The one-time tutorial bonus is paid even on a capped day.
  const tut = E.trainingRewards({ mode: 'training', drill: 'tutorial', name: 'Tutorial', grade: '' }, { today, firstTutorial: true });
  assert.equal(tut.xp, E.TRAINING.tutorial[0]); assert.equal(tut.fuzz, E.TRAINING.tutorial[1]);
  assert.deepEqual(tut.counted, { xp: 0, fuzz: 0 });
});

await test('Progress.applyTraining pays, keeps personal bests and the daily cap', async () => {
  const { Profile } = await import('../src/profile.js');
  const { Progress } = await import('../src/progress.js');
  await Profile.ready;
  const xp0 = Profile.xp, fz0 = Profile.fuzz;
  const a = Progress.applyTraining({ mode: 'training', drill: 'serve', name: 'Serve speed', grade: 'B', score: 100, pb: 171 });
  assert.equal(Profile.xp - xp0, a.xp); assert.equal(Profile.fuzz - fz0, a.fuzz);
  assert.ok(a.best.isNew && !a.best.prev);
  assert.equal(Progress.best('serve').v, 171);
  const b = Progress.applyTraining({ mode: 'training', drill: 'serve', name: 'Serve speed', grade: 'C', score: 60, pb: 150 });
  assert.ok(!b.best.isNew); assert.equal(Progress.best('serve').v, 171);
  const c = Progress.applyTraining({ mode: 'training', drill: 'serve', name: 'Serve speed', grade: 'A', score: 140, pb: 188 });
  assert.ok(c.best.isNew && c.best.prev.v === 171);
  assert.ok(c.lines.some((l) => l.label === 'Personal best'));
  // Not a match: no match stats, history, or challenge progress.
  assert.equal(Profile.stats.matches, 0); assert.equal(Profile.history.length, 0);
  for (let i = 0; i < 40; i++) Progress.applyTraining({ mode: 'training', drill: 'target', name: 'Target practice', grade: 'S', score: 70, pb: 70 });
  const T = Progress.training();
  assert.ok(T.day.xp <= E.TRAINING.daily[0] && T.day.fuzz <= E.TRAINING.daily[1]);
  assert.equal(T.runs.serve, 3); assert.equal(T.runs.target, 40);
  const t1 = Progress.applyTraining({ mode: 'training', drill: 'tutorial', name: 'Tutorial', grade: '', pb: 1 });
  const t2 = Progress.applyTraining({ mode: 'training', drill: 'tutorial', name: 'Tutorial', grade: '', pb: 1 });
  assert.equal(t1.xp, E.TRAINING.tutorial[0]); assert.equal(t2.xp, 0, 'the tutorial bonus is paid once');
  // A new UTC day starts a fresh allowance.
  T.day.date = '2000-01-01';
  assert.equal(Progress.training().day.xp, 0);
});

console.log(`${n} training tests passed`);
