// Palm Court: a tiny event bus, so feature modules (profile, career, achievements, tutorial, gamepad, Steam bridge)
// can follow the match without game.js or ui.js having to know about them.
//
// Events emitted today (payloads are plain objects; never mutate them):
//   'match:start'  { cfg }                                   every Game.startMatch, attract mode included (check cfg.mode)
//   'hit'          { idx, human, local, stroke, kind, kmh, rpm, serve, rally, mode, q, tau }   every stroke that sends the ball
//   'fault'        { reason, serveNo, mode }                 a first-serve fault (a double fault arrives as 'point' reason 'df')
//   'point'        { w, reason, rally, ev, mode, localIdx }  reason: 'ace' | 'df' | 'winner' | 'error' | ...; ev = Match.pointTo result
//   'match:end'    { winner, localIdx, mode, cfg, stats, match }   a finished match (not attract)
//   'match:quit'   { mode, cfg }                             the player left a match before the end
//   'screen'       { screen }                                UI.go(screen); null = in play
const handlers = new Map();

const Bus = {
  on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(fn);
    return () => handlers.get(name).delete(fn);
  },
  once(name, fn) { const off = this.on(name, (d) => { off(); fn(d); }); return off; },
  emit(name, data) {
    const hs = handlers.get(name);
    if (!hs) return;
    for (const fn of [...hs]) {
      try { fn(data); } catch (e) { console.error(`[bus] ${name} handler failed`, e); }   // a feature bug must never stop the match
    }
  },
};

export { Bus };
