// Palm Court: progression wiring. Follows the match on the Bus (events.js), builds the match summary, pays the
// rewards into the Profile, and moves Daily Challenges and Achievements along. No UI here: screens read
// Progress.last (the latest result, set before UI.showOver runs) or listen to Profile.on('reward').
import { Bus } from './events.js';
import { Clock, Settings } from './core.js';
import { Profile } from './profile.js';
import { rewardsFor, recordMatch, dailyChallenges, rerollChallenge, challengeById, challengeStep, checkAchievements, utcDay } from './economy.js';

const CAM = ['hand', 'paddle', 'phone'];   // clean-timing hits count for camera and phone players
const ON_TIME = 0.35;                      // |tau| under this is the HUD's "On time"

// The match summary for the local player: { mode, won, score, games, level, surface, tod, format, opponent,
// opponentName, playAs, points, pointsLost, aces, doubleFaults, winners, errors, longestRally, hits, onTime, cleanHits,
// fastestServe, durationS, control, tour? }. e = the 'match:end' payload, t = what the 'hit' events added up.
export function buildSummary(e, t = {}) {
  const me = e.localIdx, op = 1 - me, st = e.stats, m = e.match, cfg = e.cfg || {};
  const games = m.tbOnly ? [m.pts[me], m.pts[op]] : [m.games[me], m.games[op]];
  const tb = m.tb && !m.tbOnly ? ` (${Math.min(m.pts[0], m.pts[1])})` : '';
  const s = {
    mode: e.mode, won: e.winner === me, score: `${games[0]}–${games[1]}${tb}`, games,
    level: e.mode === 'online' ? null : cfg.level || 'club', surface: cfg.surface || 'hard', tod: t.tod || cfg.tod || Settings.tod || 'day', format: cfg.format || m.fmtKey,
    opponent: (cfg.pros && cfg.pros[op]) || 'custom', opponentName: (cfg.names && cfg.names[op]) || '', playAs: (cfg.pros && cfg.pros[me]) || 'custom',
    points: st.points[me], pointsLost: st.points[op], aces: st.aces[me], doubleFaults: st.df[me], winners: st.winners[me], errors: st.errors[me],
    longestRally: st.longest, hits: t.hits || 0, onTime: t.onTime || 0, cleanHits: t.clean || 0, fastestServe: Math.max(st.fastest[me] || 0, t.fastest || 0),
    durationS: Math.max(0, Math.round(t.t0 != null ? Clock.now() - t.t0 : 0)), control: t.control || Settings.control,
  };
  const tour = cfg.tour || cfg.career;
  if (tour) s.tour = tour;
  return s;
}

// ---- daily challenges (3 per UTC day, stored on the Profile so they stay put all day) ----
function day() {
  const d = Profile.data.daily, key = utcDay();
  if (d.date !== key) {
    Object.assign(d, { date: key, ids: dailyChallenges(key, Profile.level).map((c) => c.id), progress: {}, done: {}, rerolled: false });
    Profile.changed();
  }
  return d;
}
const view = (d) => (id, slot) => { const c = challengeById(id) || {}; return { id, slot, text: c.text, goal: c.goal, unit: c.unit || '', xp: c.xp, fuzz: c.fuzz, progress: d.progress[id] || 0, done: !!d.done[id] }; };
function stepChallenges(s) {
  const d = day(), out = [];
  for (const id of d.ids) {
    const c = challengeById(id);
    if (!c || d.done[id]) continue;
    d.progress[id] = challengeStep(c, d.progress[id], s);
    if (d.progress[id] >= c.goal) {
      d.done[id] = Date.now(); Profile.stats.challenges = (Profile.stats.challenges || 0) + 1;
      Profile.addXP(c.xp, `challenge ${id}`); Profile.addFuzz(c.fuzz, `challenge ${id}`);
      out.push({ id, text: c.text, xp: c.xp, fuzz: c.fuzz });
    }
  }
  return out;
}
// ---- achievements ----
function awardAchievements(s) {
  const out = [];
  for (let pass = 0; pass < 3; pass++) {   // an achievement's XP can level you up into another one
    const got = checkAchievements(Profile.stats, s, Profile.data.achievements, Profile.level);
    if (!got.length) break;
    for (const a of got) {
      Profile.data.achievements[a.id] = Date.now();
      Profile.addFuzz(a.fuzz, `achievement ${a.id}`); Profile.addXP(a.xp, `achievement ${a.id}`);
      if (a.title) Profile.grant(a.title);
      out.push({ id: a.id, name: a.name, desc: a.desc, xp: a.xp, fuzz: a.fuzz, title: a.title || null });
      Profile.emit('achievement', a);
    }
  }
  return out;
}

export const Progress = {
  last: null,       // the latest applyMatch result
  track: null,      // the match being followed
  // Pay out a finished match. Returns { summary, xp, fuzz, lines, levelFrom, levelTo, challenges, achievements, unlocked }
  // (xp/fuzz/lines are the match itself; challenges and achievements carry their own xp/fuzz on top).
  applyMatch(s) {
    const P = Profile, d = P.data, today = utcDay(), unlocked = [];
    const off = P.on('unlock', (u) => unlocked.push(u.id));
    try {
      const r = rewardsFor(s, { firstWinToday: !!s.won && d.daily.lastWin !== today });
      const levelFrom = P.level;
      if (s.won) d.daily.lastWin = today;
      recordMatch(d.stats, s);
      d.history.push({ ...s, xp: r.xp, fuzz: r.fuzz, t: Date.now() });
      if (d.history.length > 50) d.history.splice(0, d.history.length - 50);
      P.addXP(r.xp, 'match'); P.addFuzz(r.fuzz, 'match');
      const challenges = stepChallenges(s), achievements = awardAchievements(s);
      const res = { summary: s, ...r, levelFrom, levelTo: P.level, challenges, achievements, unlocked, totalXP: r.xp + [...challenges, ...achievements].reduce((a, x) => a + x.xp, 0), totalFuzz: r.fuzz + [...challenges, ...achievements].reduce((a, x) => a + x.fuzz, 0) };
      this.last = res;
      P.emit('reward', res);
      P.save();
      return res;
    } finally { off(); }
  },
  daily() { const d = day(); return d.ids.map(view(d)); },
  // One free reroll per day, for a challenge that isn't done yet.
  reroll(slot) {
    const d = day(), id = d.ids[slot];
    if (d.rerolled || !id || d.done[id]) return false;
    const c = rerollChallenge(d.date, slot, d.ids, Profile.level);
    if (!c) return false;
    d.ids[slot] = c.id; delete d.progress[id]; d.rerolled = true;
    Profile.changed();
    return true;
  },
  canReroll() { const d = day(); return !d.rerolled; },
  // Achievements as earned: id -> time (Profile.data.achievements); see economy ACHIEVEMENTS / achievementProgress.
  earned(id) { return !!Profile.data.achievements[id]; },
};

// ---- follow the match on the Bus ----
Bus.on('match:start', ({ cfg }) => {
  Progress.track = (cfg.mode === 'cpu' || cfg.mode === 'online') && cfg.localIdx >= 0 ? { t0: Clock.now(), hits: 0, onTime: 0, clean: 0, fastest: 0, control: Settings.control, tod: cfg.tod || Settings.tod } : null;
});
Bus.on('hit', (h) => {
  const t = Progress.track;
  if (!t || !h.local || !h.human) return;
  t.hits++;
  if (h.serve) t.fastest = Math.max(t.fastest, h.kmh || 0);
  else if (h.tau != null && Math.abs(h.tau) < ON_TIME) { t.onTime++; if (CAM.includes(t.control)) t.clean++; }
});
Bus.on('match:quit', () => { Progress.track = null; });
Bus.on('match:end', (e) => {
  const t = Progress.track;
  Progress.track = null;
  if (!t || e.localIdx < 0 || !(e.mode === 'cpu' || e.mode === 'online') || !Profile.loaded) return;
  Progress.applyMatch(buildSummary(e, t));
});
