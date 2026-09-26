// Online play without PeerJS: two game pages (host and guest) in one browser, their Net connections replaced by a
// link the runner carries messages over, in lockstep on a shared virtual clock, with latency and jitter (in order, as
// PeerJS's reliable data channel delivers them). A scripted player swings on each side, and each page runs the rule
// checker from sim-page.js.
const SIM = '/tests/sim/sim-page.js';
// Each page first shows the menu match for a while on a later clock, as a real page does before its player joins: the
// guest's clock then jumps back to the host's when they connect (Net sets Clock.offset from the pings).
const load = (page) => page.evaluate(async (SIM) => {
  const S = await import(SIM), P = window.PalmCourt;
  S.install(); S.checker(); S.getChecker().reset();
  S.V.t = 9000; P.Game.startAttract(); S.run(40);
  S.getChecker().reset();
}, SIM);

// Deliver messages sent on one page to the other at send time + latency (+ jitter), never overtaking each other.
function schedule(queue, out, lat, jit, state) {
  for (const { t, m } of out) {
    const at = Math.max(state.last, t + lat + Math.random() * jit);
    state.last = at;
    queue.push({ at, m });
  }
}
const same = (x, y) => JSON.stringify({ p: x.pts, g: x.games, s: x.server, n: x.serveNo, tb: x.tb, o: x.over, w: x.winner }) === JSON.stringify({ p: y.pts, g: y.games, s: y.server, n: y.serveNo, tb: y.tb, o: y.over, w: y.winner });

export async function onlineMatch(A, B, o = {}) {
  const { format = 'short', surface = 'hard', lat = 0.06, jit = 0.03, skew = 0, chunk = 1 / 30, dt = 1 / 60, maxT = 2500, disconnectAt = null, quitAt = null, rematch = false } = o;
  await load(A); await load(B);
  await A.evaluate(({ SIM, format, surface }) => import(SIM).then((S) => { const P = window.PalmCourt; P.Settings.format = format; P.Settings.surface = surface; P.Settings.control = 'mouse'; S.linkUp('host', 'Guest'); }), { SIM, format, surface });
  await B.evaluate(({ SIM, skew }) => import(SIM).then((S) => { window.PalmCourt.Settings.control = 'mouse'; S.linkUp('guest', 'Host', 5000, skew); }), { SIM, skew });
  await A.evaluate(async () => { const { UI } = await import('/src/ui.js'); await UI.startOnlineAsHost(); });   // the host presses Start match
  const qA = [], qB = [], sA = { last: 0 }, sB = { last: 0 }, errors = [], fail = (msg) => { if (errors.length < 20) errors.push({ msg }); };
  const step = (page, inbox) => page.evaluate(({ SIM, inbox, chunk, dt }) => import(SIM).then((S) => { S.Link.inbox.push(...inbox); return S.onlineStep(chunk, dt); }), { SIM, inbox, chunk, dt });
  let t = 0, a, b, compared = 0, matches = 0, cut = false, note = '', started = false;
  while (t < maxT) {
    a = await step(A, qA.splice(0));
    if (!cut) schedule(qB, a.out, lat, jit, sB);
    b = await step(B, qB.splice(0));
    if (!cut) schedule(qA, b.out, lat, jit, sA);
    t += chunk;
    if (a.mode === 'online' && b.mode === 'online') started = true;
    else if (started || t > 5) { if (!started) fail(`match did not start: host ${a.mode}, guest ${b.mode}`); break; }
    else continue;   // the guest hasn't had 'start' yet
    // between points both machines must agree on the whole score
    if (a.st === 'serve' && b.st === 'serve' && a.m && b.m) { compared++; if (!same(a.m, b.m)) { fail(`scores differ at ${t.toFixed(1)} s: host ${JSON.stringify(a.m.pts)} ${JSON.stringify(a.m.games)} srv ${a.m.server}/${a.m.serveNo} · guest ${JSON.stringify(b.m.pts)} ${JSON.stringify(b.m.games)} srv ${b.m.server}/${b.m.serveNo}`); break; } }
    if (disconnectAt != null && t >= disconnectAt && !cut) {
      // the guest's network drops: PeerJS may never say so, so each side's ping timeout (8 s) closes the connection
      cut = true; qA.length = qB.length = 0;
      for (let i = 0; i < 8 / chunk; i++) { a = await step(A, []); b = await step(B, []); }
      await A.evaluate(() => window.PalmCourt.Net.onClose()); await B.evaluate(() => window.PalmCourt.Net.onClose());
      break;
    }
    if (quitAt != null && t >= quitAt) {
      await B.evaluate(async () => { const { UI } = await import('/src/ui.js'); UI.pause(); UI.quit(); });   // the guest quits from the pause menu
      b = await step(B, []); schedule(qA, b.out, lat, jit, sA);
      for (let i = 0; i < 1 / chunk; i++) { a = await step(A, qA.splice(0)); }
      break;
    }
    if (a.st === 'over' && b.st === 'over') {
      matches++;
      if (!same(a.m, b.m)) fail('final scores differ');
      if (a.screen !== 'over' || b.screen !== 'over') fail(`over screens: host ${a.screen} guest ${b.screen}`);
      const st = a.m.stats;
      note = `${a.m.games.join('-')}${a.m.tb ? ` (${a.m.pts.join('-')})` : ''}, winner ${a.m.winner} (points ${st.points.join('-')}, winners ${st.winners.join('-')}, errors ${st.errors.join('-')}, aces ${st.aces.join('-')})`;
      if (rematch && matches === 1) {
        await B.evaluate(async () => { const { UI } = await import('/src/ui.js'); UI.rematch(); });   // the guest asks for a rematch
        continue;
      }
      break;
    }
  }
  const rep = async (page) => page.evaluate((SIM) => import(SIM).then((S) => { const r = S.getChecker().report(); const P = window.PalmCourt, ui = document.getElementById('menuNote'); return { ...r, mode: P.Game.mode, st: P.Game.state, note: ui && ui.textContent }; }), SIM);
  const rA = await rep(A), rB = await rep(B);
  // the same scripted player on both sides: each should get its racket on the ball about as often
  for (const [who, r] of [['host', rA], ['guest', rB]]) {
    const sw = r.counts.botSwing || 0, hit = r.counts.groundStroke || 0;
    if (sw >= 8 && hit < 0.7 * sw) fail(`${who} connected with only ${hit} of ${sw} on-time swings (${r.counts['timing:Missed'] || 0} "Missed")`);
  }
  if (disconnectAt != null || quitAt != null) {
    for (const [who, r] of [['host', rA], ['guest', rB]]) if (r.mode !== 'attract') fail(`${who} still in mode ${r.mode} after the connection went`);
    if (disconnectAt != null && !/lost/.test(rA.note)) fail('host not told the connection was lost: ' + rA.note);
    note = `after drop: host ${rA.mode} "${rA.note}", guest ${rB.mode}`;
  } else if (matches < (rematch ? 2 : 1)) fail(`match not finished in ${maxT} s (${a.st}/${b.st})`);
  return { errors: [...errors, ...rA.errors.map((e) => ({ side: 'host', ...e })), ...rB.errors.map((e) => ({ side: 'guest', ...e }))], note: `${note} · ${rA.points}+${rB.points} calls, ${compared} checks, host counts ${JSON.stringify(Object.fromEntries(Object.entries(rA.counts).filter(([k]) => /^(call|reason|fault|let|onRemote|bot|ground|timing)/.test(k))))} · guest counts ${JSON.stringify(Object.fromEntries(Object.entries(rB.counts).filter(([k]) => /^(reason|bot|ground|timing)/.test(k))))}` };
}
