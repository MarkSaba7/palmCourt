// TEST ONLY: plays a practice match with a simulated phone racket, across two tabs of the same origin.
//   game tab:   const t = await import('/tests/phone-e2e.js'); t.coach(window.PalmCourt)
//   phone tab:  const t = await import('/tests/phone-e2e.js'); t.racket(window, fhSign)
// The coach watches the ball and says when to toss and which way to swing; the racket turns that into
// synthetic motion, which goes through the phone's real swing detector, the link and the game.
import * as sim from './phone-sim.js';

const CH = 'palmcourt-test';

export function coach(P, { lead = 0.16, windup = false } = {}) {
  const ch = new BroadcastChannel(CH), G = P.Game, log = { tosses: 0, serveSwings: 0, swings: 0, hits: [], strokes: { fh: 0, bh: 0 } };
  // Count the hits the game reports to the phone (the same message that makes it vibrate).
  const send = P.Phone.send.bind(P.Phone);
  P.Phone.send = (m) => { if (m && m.type === 'hit') log.hits.push({ power: +(+m.power).toFixed(3), stroke: m.stroke || 'serve' }); send(m); };
  let tossedAt = -9, swungFor = '';
  const id = setInterval(() => {
    const me = G.me(), m = G.match, b = G.ball, now = P.Clock.now();
    if (!me || !m || !(G.mode === 'cpu') || G.state === 'over') return;
    // Toss (again, like a player would, if the last one didn't take), alternating a lift and a tap on the button.
    if (m.currentServer === me.idx && G.state === 'serve' && now > G.serveReadyAt + 0.3 && now - tossedAt > 2.5) {
      tossedAt = now; log.tosses++; ch.postMessage({ do: log.tosses % 2 ? 'toss' : 'tap' });
    } else if (m.currentServer === me.idx && G.state === 'toss' && swungFor !== 's' + G.tossT && now > G.tossT + 0.68 - lead - (windup ? 0.32 : 0)) {
      swungFor = 's' + G.tossT; log.serveSwings++; ch.postMessage({ do: 'swing', stroke: 'fh', windup });
    } else if (G.state === 'rally' && me.plan && b.lastHitter >= 0 && b.lastHitter !== me.idx && me.hitFor !== b.rally && swungFor !== 'r' + b.rally) {
      if (me.plan.t - now < lead + (windup ? 0.32 : 0)) { swungFor = 'r' + b.rally; log.swings++; log.strokes[me.plan.stroke]++; ch.postMessage({ do: 'swing', stroke: me.plan.stroke, windup }); }
    }
  }, 8);
  return { log, stop() { clearInterval(id); ch.close(); P.Phone.send = send; } };
}

export function racket(win, fhSign, up = sim.HOLDS.tilted) {
  const ch = new BroadcastChannel(CH), log = { toss: 0, tap: 0, swing: 0 };
  let busy = Promise.resolve();
  ch.onmessage = (e) => {
    const m = e.data;
    busy = busy.then(async () => {
      if (m.do === 'toss') { log.toss++; await sim.lift(win, up); }
      else if (m.do === 'tap') { const b = win.document.getElementById('btnToss'); if (!b.hidden) { log.tap++; b.click(); } }
      else if (m.do === 'swing') {
        log.swing++;
        const sign = m.stroke === 'bh' ? -fhSign : fhSign;
        if (m.windup) await sim.stroke(win, up, sign, { recover: 0.5 });
        else { await sim.turn(win, up, { sign, peak: 900, ms: 260 }); await sim.still(win, up, 60); }
      }
    });
  };
  return { log, stop() { ch.close(); } };
}
