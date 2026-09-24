// Flows a player goes through, each run inside the game page by tests/sim/run.mjs. Every flow returns
// { errors: [...], note } where errors includes everything the rule checker (sim-page.js) caught meanwhile.
// Helpers available in the page: S = sim-page.js, P = window.PalmCourt, G = P.Game.

// Run `body` in the page with S, P, G, C (checker) and a `fail(msg)` collector; returns the report.
async function inPage(page, body, arg) {
  return page.evaluate(async ({ src, arg }) => {
    const S = await import('/tests/sim/sim-page.js'), P = window.PalmCourt, G = P.Game, C = S.getChecker();
    const UI = (await import('/src/ui.js')).UI, Replay = P.Replay, Clock = P.Clock, Input = P.Input;
    const errors = [], fail = (msg) => errors.push({ msg });
    const $ = (id) => document.getElementById(id);
    C.reset();
    const fn = new Function('S', 'P', 'G', 'C', 'UI', 'Replay', 'Clock', 'Input', 'fail', '$', 'arg', `return (async () => { ${src} })();`);
    let note = '';
    try { note = (await fn(S, P, G, C, UI, Replay, Clock, Input, fail, $, arg)) || ''; } catch (e) { fail('threw: ' + e.message + ' ' + (e.stack || '').split('\n')[1]); }
    return { errors: [...errors, ...C.report().errors], note: typeof note === 'string' ? note : JSON.stringify(note), counts: C.report().counts };
  }, { src: body, arg });
}

export const FLOWS = {
  // Pause in the middle of a rally: nothing moves, the clock stands still, and play carries on after Resume.
  'pause-resume mid-rally': (page) => inPage(page, `
    await S.startPractice({ format: 'short' });
    if (!S.runUntil(() => G.state === 'rally' && G.ball.rally >= 2, 120)) return fail('no rally');
    const b = G.ball, before = { p: { ...b.p }, simT: b.simT, now: Clock.now(), st: G.state, pts: G.match.pts.join() };
    UI.pause();
    if (!Clock.paused || UI.screen !== 'pause' || $('pause').hidden) fail('pause screen / clock');
    if (G.inPlay()) fail('inPlay while paused');
    S.run(5);
    if (Clock.now() !== before.now) fail('clock moved while paused');
    if (b.p.x !== before.p.x || b.p.z !== before.p.z || b.simT !== before.simT) fail('ball moved while paused');
    if (G.state !== before.st) fail('state changed while paused: ' + G.state);
    // a click on the court while paused is not a swing
    Input.press(0.6, 0.3, 'mouse');
    UI.resume();
    if (Clock.paused || UI.screen !== null) fail('resume');
    if (!S.runUntil(() => G.state === 'dead', 20)) fail('point never ended after resume');
    if (!S.runUntil(() => G.state === 'serve', 20)) fail('next point never started');
    return 'rally ' + b.rally;
  `),
  // Pause with the ball in the air on the toss: after Resume the serve is still struck (no re-toss).
  'pause-resume mid-toss': (page) => inPage(page, `
    await S.startPractice({ format: 'short' });
    let n = 0;
    for (let i = 0; i < 6; i++) {
      if (!S.runUntil(() => G.state === 'toss' && Clock.now() - G.tossT > 0.3, 60)) return fail('no toss');
      const ret0 = C.counts.retoss || 0;
      UI.pause(); S.run(3); UI.resume();
      if (!S.runUntil(() => G.state !== 'toss', 3)) fail('toss never ended');
      if (G.state !== 'rally') fail('serve not struck after pausing mid-toss: ' + G.state);
      if ((C.counts.retoss || 0) !== ret0) fail('re-toss after a pause');
      n++;
      S.runUntil(() => G.state === 'serve', 30);
    }
    // pausing during the pre-serve ball bounce and between points
    S.runUntil(() => G.state === 'serve' && G.bouncing(Clock.now()), 30);
    UI.pause(); S.run(4); UI.resume();
    if (!S.runUntil(() => G.state === 'toss', 8)) fail('no toss after pausing during the bounce');
    S.runUntil(() => G.state === 'dead', 30);
    const dl = G.deadUntil - Clock.now();
    UI.pause(); S.run(6); UI.resume();
    if (Math.abs(G.deadUntil - Clock.now() - dl) > 1e-6) fail('dead timer ran during the pause');
    return n + ' paused tosses';
  `),
  // Pause during an instant replay: the replay freezes and resumes.
  'pause during replay': (page) => inPage(page, `
    await S.startPractice({ format: 'full', level: 'pro' });
    if (!S.runUntil(() => Replay.active && Replay.phase === 'play', 900)) return fail('no replay in 900 s');
    S.run(0.3);
    const t = Replay.t;
    UI.pause(); S.run(3);
    if (Replay.t !== t) fail('replay ran while paused');
    UI.resume();
    if (!S.runUntil(() => !Replay.busy(), 30)) fail('replay never finished');
    if (!S.runUntil(() => G.state === 'serve', 5)) fail('no serve after the replay');
    if (!$('replay').hidden) fail('replay banner left on');
    return Replay.spec.style;
  `),
  // Skip a replay with a swing (the way a player does): it ends at once and the next point comes quickly.
  'replay skip': (page) => inPage(page, `
    await S.startPractice({ format: 'full', level: 'pro' });
    let skipped = 0;
    for (let i = 0; i < 3; i++) {
      Replay.lastAt = -99;   // allow back-to-back replays
      if (!S.runUntil(() => Replay.active && Replay.phase === 'play', 900)) return fail('no replay');
      const style = Replay.spec.style;
      Input.press(0.6, 0.3, 'mouse');
      if (Replay.phase !== 'out') fail('swing did not skip the ' + style + ' replay: ' + Replay.phase);
      if (!S.runUntil(() => G.state === 'serve', 2.5)) fail('next point slow after a skip: ' + G.state + ' ' + Replay.phase);
      if (!$('replay').hidden || !$('hawkeye').hidden) fail('replay overlay left on after skip');
      skipped++;
    }
    return skipped + ' skipped';
  `),
  // Quit to the menu mid-point, then start a different match: nothing carries over.
  'quit mid-point, new match with other settings': (page) => inPage(page, `
    await S.startPractice({ format: 'full', surface: 'hard', level: 'pro' });
    S.runUntil(() => G.match.games[0] + G.match.games[1] >= 1 && G.state === 'rally', 600);
    UI.pause(); UI.quit();
    if (G.mode !== 'attract' || UI.screen !== 'menu' || Clock.paused) fail('quit did not return to the menu: ' + G.mode + ' ' + UI.screen + ' paused ' + Clock.paused);
    if (!$('hud').hidden) fail('HUD still shown on the menu');
    S.run(20);
    await S.startPractice({ format: 'tiebreak', surface: 'clay', level: 'rookie' });
    const m = G.match;
    if (m.fmtKey !== 'tiebreak' || !m.tb || m.pts.join() !== '0,0' || m.games.join() !== '0,0' || m.over) fail('new match not fresh: ' + JSON.stringify(m.toJSON()));
    if (m.stats.points.join() !== '0,0' || m.stats.aces.join() !== '0,0') fail('stats carried over');
    if (P.World.surface !== 'clay') fail('surface not applied');
    if (G.players[1].level.label !== 'Rookie') fail('level not applied');
    if (!S.runUntil(() => G.state === 'over', 1500)) fail('tiebreak match did not finish');
    return m.pts.join('-');
  `),
  // Quit while an instant replay is playing (and while it is waiting to start).
  'quit mid-replay': (page) => inPage(page, `
    const out = [];
    for (const phase of ['play', 'hold', 'wait']) {
      await S.startPractice({ format: 'full', level: 'pro' });
      Replay.lastAt = -99;
      const ok = S.runUntil(() => Replay.phase === phase && (phase !== 'play' || Replay.active), 1500);
      if (!ok) { out.push(phase + ': not reached'); continue; }
      UI.quit();
      if (Replay.busy() || Replay.active) fail(phase + ': replay still running after quit');
      if (!$('replay').hidden || !$('hawkeye').hidden || $('hud').classList.contains('replaying')) fail(phase + ': replay overlay left on');
      if (Replay.foot.visible) fail(phase + ': Hawk-Eye footprint left on court');
      S.run(1);
      if (G.mode !== 'attract' || G.state === 'dead' && Replay.busy()) fail(phase + ': menu match stuck');
      // the stadium screen shows the menu match, not REPLAY / HAWK-EYE
      if (UI.board && UI.board.note !== 'PALM COURT') fail(phase + ': board note ' + UI.board.note);
      out.push(phase + ' ok');
    }
    await S.startPractice({ format: 'short' });
    if (!S.runUntil(() => G.state === 'dead', 120)) fail('new match after quitting mid-replay did not play');
    return out.join(', ');
  `),
  // Finish a match, check the end screen, then Play again.
  'match end, over screen, rematch': (page) => inPage(page, `
    await S.startPractice({ format: 'tiebreak', level: 'club' });
    if (!S.runUntil(() => G.state === 'over', 1500)) return fail('match did not finish');
    if (UI.screen !== 'over' || $('over').hidden) fail('over screen not shown');
    const score = $('overScore').textContent, title = $('overTitle').textContent;
    if (!/\\d+–\\d+/.test(score)) fail('over score ' + score);
    S.run(10);   // the over screen stays up
    if (G.state !== 'over' || UI.screen !== 'over') fail('left the over screen by itself');
    UI.rematch();
    await new Promise((r) => setTimeout(r, 0));
    S.cpuBoth();
    if (UI.screen !== null || G.state !== 'serve' || G.match.over || G.match.pts.join() !== '0,0') fail('rematch did not start a fresh match');
    if ($('hud').hidden) fail('HUD hidden after rematch');
    if (!S.runUntil(() => G.state === 'over', 1500)) fail('rematch did not finish');
    return title + ' ' + score;
  `),
  // A human who tosses and never swings: the ball is caught and re-tossed, forever, with nothing drifting.
  'human toss without a swing': (page) => inPage(page, `
    await S.startPractice({ format: 'short', cpu: false, first: 0 });
    const me = G.players[0];
    if (G.match.currentServer !== 0) return fail('not serving');
    let tosses = 0;
    for (let i = 0; i < 8; i++) {
      S.runUntil(() => G.state === 'serve' && Clock.now() >= G.serveReadyAt, 10);
      Input.press(0.6, 0.3, 'mouse');   // a click tosses
      if (!S.runUntil(() => G.state === 'toss', 3)) { fail('click did not toss (state ' + G.state + ')'); break; }
      tosses++;
      if (!S.runUntil(() => G.state === 'serve', 2)) { fail('no re-toss after an unhit toss'); break; }
      const b = G.ball;
      if (b.active || Math.abs(b.p.x - me.x) > 0.5 || Math.abs(b.p.z - me.z) > 0.5) fail('ball not back in the hand');
    }
    if (G.match.pts.join() !== '0,0' || G.match.serveNo !== 1) fail('an unhit toss changed the score: ' + G.match.pts + ' serve ' + G.match.serveNo);
    // now serve properly: toss, then swing near the top of the toss
    S.runUntil(() => G.state === 'serve' && Clock.now() >= G.serveReadyAt, 10);
    Input.press(0.6, 0.3, 'mouse');
    S.runUntil(() => G.state === 'toss' && Clock.now() - G.tossT > 0.62, 3);
    Input.press(0.7, 0.3, 'mouse');
    if (!S.runUntil(() => G.state !== 'toss', 2) || G.state !== 'rally') fail('a swing at the top of the toss did not serve: ' + G.state);
    return tosses + ' tosses caught';
  `),
  // A human server who never tosses: the match waits (no auto-serve), the ball stays in hand, and nothing breaks.
  'human server idles': (page) => inPage(page, `
    await S.startPractice({ format: 'short', cpu: false, first: 0 });
    const me = G.players[0], b = G.ball;
    S.run(60);
    if (G.state !== 'serve' || b.active) fail('state ' + G.state);
    if (Math.abs(b.p.x - me.x) > 0.5 || Math.abs(b.p.z - me.z) > 0.5 || b.p.y < 0.5) fail('ball left the hand: ' + JSON.stringify(b.p));
    if ($('prompt').textContent === '') fail('no toss prompt');
    // a toss after a long wait still works
    Input.press(0.6, 0.3, 'mouse');
    if (!S.runUntil(() => G.state === 'toss', 3)) fail('toss after idling');
    return 'prompt: ' + $('prompt').textContent;
  `),
  // A human who never swings: the CPU's serves go past (aces), and when the human serves they toss but never hit.
  'human never swings (receiving)': (page) => inPage(page, `
    await S.startPractice({ format: 'short', cpu: false, first: 1 });
    const want = [];
    // the CPU serves the first game; the human never swings
    if (!S.runUntil(() => G.match.games[1] === 1, 200)) fail('CPU did not hold serve against a human who never swings: ' + JSON.stringify(G.match.toJSON()));
    const k = C.counts;
    if ((k['reason:ace'] || 0) + (k['reason:df'] || 0) < 4) fail('points were not aces/double faults: ' + JSON.stringify(k));
    return 'aces ' + (k['reason:ace'] || 0) + ', df ' + (k['reason:df'] || 0);
  `),
  // A human who mashes the button at random moments in every state: nothing illegal happens.
  'human random clicks': (page) => inPage(page, `
    await S.startPractice({ format: 'short', cpu: false, first: 0 });
    let clicks = 0;
    const end = S.V.t + 900;
    while (S.V.t < end && G.state !== 'over') {
      S.run(0.05 + Math.random() * 0.5);
      if (Math.random() < 0.5) { Input.press(Math.random(), Math.random() * 2 - 1, Math.random() < 0.5 ? 'mouse' : 'key'); clicks++; }
    }
    return clicks + ' clicks, ' + C.points + ' points, ' + G.state + ' ' + JSON.stringify(G.match.games);
  `),
  // A human who swings on time every time (at the planned contact moment): rallies happen and calls stay legal.
  'human on-time swings': (page) => inPage(page, `
    await S.startPractice({ format: 'short', cpu: false });
    const me = G.players[0];
    let swings = 0, hits = 0;
    const end = S.V.t + 1200;
    while (S.V.t < end && G.state !== 'over') {
      S.run(1 / 60);
      const now = Clock.now(), m = G.match;
      if (G.state === 'serve' && m.currentServer === 0 && now >= G.serveReadyAt && !G.bouncing(now)) Input.press(0.6, 0.3, 'mouse');
      else if (G.state === 'toss' && m.currentServer === 0 && now - G.tossT >= 0.66 && me.hitFor !== -3) Input.press(0.7, 0.3, 'mouse');
      else if (G.state === 'rally' && me.plan && G.ball.lastHitter === 1 && me.hitFor !== G.ball.rally && me.plan.t - now <= 0.02) {
        const r0 = G.ball.rally; Input.press(0.6, 0.4, 'mouse'); swings++; if (G.ball.rally !== r0 || G.pending) hits++;
      }
    }
    if (G.state !== 'over') fail('match with a human did not finish: ' + JSON.stringify(G.match.toJSON()));
    return swings + ' swings, ' + hits + ' contacts, ' + C.points + ' points, longest rally ' + C.maxRally;
  `),
  // Forced close calls: a CPU shot aimed a hair outside / inside the sideline. The call must match the bounce, and the
  // Hawk-Eye replay must agree with the call.
  'hawk-eye close calls': (page) => inPage(page, `
    const core = await import('/src/core.js');
    await S.startPractice({ format: 'full', level: 'pro' });
    const res = [];
    for (const off of [0.03, -0.03, 0.01, -0.005, 0.05]) {
      S.runUntil(() => G.state === 'rally' && G.ball.rally >= 2 && G.ball.lastHitter >= 0, 300);
      // wait for the next ground stroke, then re-aim it just by the sideline, deep
      const hit0 = G.ball.rally;
      if (!S.runUntil(() => G.ball.rally > hit0 && G.state === 'rally' && !G.ball.serve, 30)) { res.push(off + ': no stroke'); continue; }
      const b = G.ball, pl = G.players[b.lastHitter], side = pl.side;
      const tx = -side * 0 + Math.sign(b.p.x || 1) * (4.115 + off), tz = -side * 9.5;
      const sol = core.solveShot({ ...b.p }, tx, tz, 24, 1800 * core.RPM, { minNet: 0.3 });
      b.v = { ...sol.v }; b.w = { ...sol.w };
      G.bounceLog.length = 0; G.hist.length = 0;
      G.replanAll();
      Replay.lastAt = -99;
      const before = C.points;
      S.runUntil(() => G.bounceLog.length >= 1 || G.state !== 'rally', 5);
      const bl = G.bounceLog[0];
      if (!bl) { res.push(off + ': no bounce'); continue; }
      const out = Math.abs(bl.x) > 4.115 + core.LINE_TOL;
      S.run(0.05);
      const called = G.state === 'dead' && C.points > before;
      if (out !== called) fail('call ' + (called ? 'out' : 'in') + ' but bounce at x ' + bl.x.toFixed(4));
      if (called) {
        if (!S.runUntil(() => Replay.phase === 'hold', 12)) { res.push(off + ': no hawk-eye'); continue; }
        const shown = $('hawkCall').textContent;
        if ((shown === 'Out') !== out) fail('Hawk-Eye shows ' + shown + ' for bounce x ' + bl.x.toFixed(4));
        res.push(off + ': ' + shown + ' ' + $('hawkDist').textContent);
        S.runUntil(() => G.state === 'serve', 10);
      } else { res.push(off + ': in (' + (Math.abs(bl.x) - 4.115).toFixed(4) + ')'); S.runUntil(() => G.state === 'serve', 30); }
    }
    return res.join('; ');
  `),
  // Long rallies: a replay of a 12+ shot rally is labelled with its length, plays and hands back to the match.
  'long rally replay': (page) => inPage(page, `
    await S.startPractice({ format: 'full', level: 'pro' });
    let seen = null;
    const end = S.V.t + 3000;
    while (S.V.t < end && !seen) {
      Replay.lastAt = -99;
      S.runUntil(() => (Replay.active && Replay.spec.rally >= 12 && !Replay.spec.matchPoint && Replay.spec.style !== 'hawk') || G.state === 'over', end - S.V.t);
      if (G.state === 'over') { await S.startPractice({ format: 'full', level: 'pro' }); continue; }
      if (Replay.active) seen = { rally: Replay.spec.rally, kind: $('replayKind').textContent, reason: Replay.spec.reason };
    }
    if (!seen) return 'no 12+ shot rally in 3000 s (not a failure)';
    if (!S.runUntil(() => !Replay.busy(), 30)) fail('long replay never finished');
    if (!S.runUntil(() => G.state === 'serve' || G.state === 'over', 5)) fail('match did not continue after the replay');
    if (!/rally|Winner/.test(seen.kind)) fail('replay label ' + seen.kind);
    return JSON.stringify(seen);
  `),
  // The tab is hidden: a practice match pauses itself; the menu match keeps running on main.js's setInterval tick
  // (no animation frames in a hidden tab). Runs on the real clock, so it goes last.
  'hidden tab': (page) => inPage(page, `
    await S.startPractice({ format: 'short' });
    S.runUntil(() => G.state === 'rally', 60);
    const vis = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    const paused = Clock.paused && UI.screen === 'pause';
    delete document.hidden;
    if (!paused) fail('hiding the tab did not pause the practice match');
    UI.resume(); UI.quit();
    // back to the real clock (continuously), with animation frames still stopped as in a hidden tab
    Clock.offset += S.V.t - performance.now() / 1000;
    const perf = Clock.perf; Clock.perf = () => performance.now() / 1000;
    const seen = new Set(), t0 = Clock.now();
    const iv = setInterval(() => seen.add(G.state), 20);
    await new Promise((r) => setTimeout(r, 9000));
    clearInterval(iv);
    const ran = Clock.now() - t0;
    S.V.t = performance.now() / 1000; Clock.perf = perf;   // back on the virtual clock, from the same instant
    if (!seen.has('toss') && !seen.has('rally')) fail('menu match did not run on the timer tick: states ' + [...seen]);
    return 'states seen in ' + ran.toFixed(1) + ' s: ' + [...seen].join(' ');
  `),
};
