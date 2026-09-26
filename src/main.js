// Palm Court: boot sequence and main loop.
import { Clock, Settings } from './core.js';
import { Perf, render, Env, World, Stadium, Crowd, Effects, renderer, scene, camera } from './render/world.js';
import { Cam, BallView } from './render/actors.js';
import { Input, Tracker } from './input.js';
import { Game } from './game.js';
import { Net } from './net.js';
import { Phone } from './phone.js';
import { UI } from './ui.js';
import { Replay } from './replay.js';
import { BallKids } from './render/ballkids.js';

const $ = (id) => document.getElementById(id);
const status = (t, p) => { const el = $('loadingMsg'); if (el) el.textContent = t; if (p != null && $('loadBar')) $('loadBar').style.setProperty('--p', p + '%'); };

let lastT = performance.now(), lastRaf = 0, lastRender = 0, booted = false;
// Profiling (Perf.profile()): main-thread time of each part of the frame. When it's off, one test per part.
let secT = 0;
const sec = (k) => { const n = performance.now(); Perf.section(k, n - secT); secT = n; };
renderer.info.autoReset = false;   // count the whole frame (shadow maps, scene and every post pass), not just the last pass
function tick(t) {
  if (!booted) return;
  const dt = Math.min(0.05, Math.max(0, (t - lastT) / 1000)), prof = Perf.sections;
  lastT = t;
  if (prof) secT = performance.now();
  // An instant replay takes over the players, the ball and the camera while it runs.
  const replay = Replay.update(dt);
  if (prof) sec('Replay');
  if (!replay) {
    Game.update(dt);
    if (prof) sec('Game');
    BallKids.update(Clock.paused ? 0 : dt, Game);
    if (prof) sec('BallKids');
    Replay.record(Game.ball, BallView.mesh.visible);
    if (prof) sec('Replay');
    Cam.update(dt, Game.mode === 'cpu' || Game.mode === 'online' ? Game.me() : null, Game);
    if (prof) sec('Cam');
  }
  if (!Clock.paused) for (const p of Game.players) p.avatar.updateBlur();   // a paused frame keeps its blur, like a photo
  if (prof) sec('Blur');
  const secs = t / 1000, ball = BallView.mesh.visible ? BallView.mesh.position : null;
  Env.update(secs);
  if (prof) sec('Env');
  World.update(Clock.now());
  if (prof) sec('World');
  Stadium.update(secs, ball);
  if (prof) sec('Stadium');
  Crowd.update(ball);
  if (prof) sec('Crowd');
  Effects.update(Clock.paused ? 0 : Replay.active ? dt * Replay.timeScale : dt, ball, Game.players.map((p) => p.avatar));
  if (prof) sec('Effects');
  UI.frame(dt);
  if (prof) sec('UI');
}
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  lastRaf = now;
  // On 120/144 Hz screens draw every other refresh: 60-75 fps is plenty and halves the graphics load.
  if (now - lastRender < 11) return;
  const ms = lastRender ? now - lastRender : 16.7;
  lastRender = now;
  tick(now);
  const prof = Perf.sections;
  if (prof) secT = performance.now();
  renderer.info.reset();
  render(now / 1000);
  if (prof) { sec('render'); Perf.section('tick+render', performance.now() - now); Perf.section('interval', ms); }
  if (ms < 250) Perf.frame(ms);   // a longer gap means the window was hidden, not that the GPU is slow
}
// Browsers stop animation frames in hidden tabs. Keep the match logic (and line calls) running anyway.
setInterval(() => { const now = performance.now(); if (now - lastRaf > 120) tick(now); }, 33);

// Let the loading text paint between build steps (falls back to a timer when the tab is hidden).
const yieldFrame = () => new Promise((r) => { let done = false; const go = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(go); setTimeout(go, 60); });

async function boot() {
  try { await Promise.race([document.fonts.load('900 70px "Big Shoulders Display"'), new Promise((r) => setTimeout(r, 1500))]); } catch (e) { /* fall back to system fonts */ }
  const software = Perf.detectGpu();
  Perf.apply();
  status('Lighting the stadium…', 25); await yieldFrame();
  Env.init();
  status('Painting the court…', 45); await yieldFrame();
  World.init();
  Effects.init();
  World.onChange((kind) => Effects.setSurface(kind));
  World.setSurface(Settings.surface);
  status('Filling the stands…', 70); await yieldFrame();
  Stadium.build();
  BallKids.init(Stadium.kids);
  Env.onChange((tod) => { Stadium.setTimeOfDay(tod); Effects.setTimeOfDay(tod); Crowd.setTimeOfDay(tod); });
  Env.setTimeOfDay(Settings.tod || 'day');
  status('Warming up…', 92); await yieldFrame();
  UI.init();
  Game.init();
  if (software) UI.gpuWarning();
  Game.startAttract();
  booted = true;
  requestAnimationFrame(frame);
  $('loading').hidden = true;
  UI.go('menu');
  const q = new URLSearchParams(location.search).get('join');
  if (q && /^[A-Za-z0-9]{5}$/.test(q)) UI.openLobby(q.toUpperCase());
  window.PalmCourt = { Game, Net, Input, Settings, Clock, Perf, Tracker, Phone, Env, Stadium, World, Cam, Crowd, Replay, Effects, renderer, scene, camera };
}
boot().catch((e) => {
  console.error(e);
  status('The court failed to load: ' + (e && e.message ? e.message : e));
});
