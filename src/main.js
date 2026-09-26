// Palm Court: boot sequence and main loop.
import * as THREE from 'three';
import * as BGU from 'three/addons/utils/BufferGeometryUtils.js';
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
import { Profile } from './profile.js';
import { Progress } from './progress.js';
import * as Economy from './economy.js';

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
function frame(ts) {
  requestAnimationFrame(frame);
  // Pace by the frame's own timestamp (the display's refresh), not the moment this callback got to run: a callback
  // that starts late (a worker message, garbage collection) must not make the next refresh look too soon and skip it.
  const now = Number.isFinite(ts) ? ts : performance.now(), t0 = performance.now();
  lastRaf = t0;
  // On 120/144 Hz screens draw every other refresh: 60-75 fps is plenty and halves the graphics load (90-100 Hz
  // screens draw every refresh).
  if (now - lastRender < 9.5 && now >= lastRender) return;
  const ms = lastRender ? now - lastRender : 16.7;
  lastRender = now;
  tick(now);
  const prof = Perf.sections;
  if (prof) secT = performance.now();
  renderer.info.reset();
  render(now / 1000);
  lastRaf = performance.now();   // a slow frame must not look like a stopped loop to the fallback tick below
  if (prof) { sec('render'); Perf.section('tick+render', lastRaf - t0); Perf.section('interval', ms); }
  // A longer gap means the window was hidden, not that the GPU is slow. Between points (and in the menus) the
  // auto preset may step down if even the lowest resolution is too slow.
  if (ms < 250) Perf.frame(ms, Game.mode === 'attract' || Game.state === 'dead' || Game.state === 'over' || Clock.paused);
}
// Browsers stop animation frames in hidden tabs. Keep the match logic (and line calls) running anyway.
setInterval(() => { const now = performance.now(); if (now - lastRaf > 120) tick(now); }, 33);

// Static batching. The stadium's props (chairs, benches, bags, trunks, roof parts…) never move after it's built, yet
// each mesh costs a draw call in every pass, the sun's shadow map (redrawn every frame) included. Meshes that share a
// plain built-in material and the same shadow settings are merged, in place, into one: the same picture with far
// fewer draw calls. Anything special (custom shaders, depth materials, transparency, instancing, skinning,
// mirrored transforms, per-object callbacks) is left alone.
const NOOP = THREE.Object3D.prototype.onBeforeRender, NOCOMPILE = THREE.Material.prototype.onBeforeCompile;
// Plain coloured materials (no textures, no glow) that are equal in every setting are interchangeable: the props make
// a new one per chair or bench. Any other material, or one the owner keeps to change later, only batches with itself.
function materialKey(m, keep) {
  if (keep.has(m)) return m.uuid;
  const out = [m.type];
  for (const k of Object.keys(m).sort()) {
    if (k === 'uuid' || k === 'id' || k === 'name' || k === 'version' || k === 'userData' || k === '_listeners') continue;
    const v = m[k];
    if (v == null || typeof v !== 'object') out.push(k + '=' + v);
    else if (v.isColor) out.push(k + '=' + v.getHexString());
    else if (Array.isArray(v) || v.isVector2 || v.isVector3 || v.isEuler) out.push(k + '=' + (Array.isArray(v) ? v : v.toArray()).join(','));
    else if (k === 'defines') out.push(k + '=' + JSON.stringify(v));
    else return m.uuid;   // a texture or anything else by reference
  }
  if (m.emissive && m.emissive.getHex() !== 0) return m.uuid;
  return out.join(';');
}
function batchStatic(root, owner = {}) {
  const keep = new Set(Object.values(owner).filter((v) => v && v.isMaterial));
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert(), bins = new Map(), m = new THREE.Matrix4();
  root.traverseVisible((o) => {
    const mat = o.material, g = o.geometry;
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isBatchedMesh || !mat || Array.isArray(mat) || !mat.isMaterial) return;
    if (mat.isShaderMaterial || mat.transparent || mat.onBeforeCompile !== NOCOMPILE || mat.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey) return;
    if (o.customDepthMaterial || o.customDistanceMaterial || o.onBeforeRender !== NOOP || o.onAfterRender !== THREE.Object3D.prototype.onAfterRender || o.morphTargetInfluences || !o.frustumCulled) return;
    if (!g || !g.isBufferGeometry || Object.keys(g.morphAttributes).length || g.groups.length > 1 || g.drawRange.start !== 0 || g.drawRange.count !== Infinity) return;
    if (o.matrixWorld.determinant() <= 0) return;
    const attrs = Object.keys(g.attributes).sort().map((k) => { const a = g.attributes[k]; return a.isInterleavedBufferAttribute ? '!' : `${k}${a.itemSize}${a.normalized ? 'n' : ''}${a.array.constructor.name}`; }).join();
    if (attrs.includes('!')) return;
    const key = [materialKey(mat, keep), o.castShadow, o.receiveShadow, o.renderOrder, o.layers.mask, !!o.userData.noAO, !!g.index, attrs].join('|');
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push(o);
  });
  let merged = 0, removed = 0;
  for (const list of bins.values()) {
    if (list.length < 2) continue;
    const geos = list.map((o) => { const c = o.geometry.clone(); c.clearGroups(); return c.applyMatrix4(m.multiplyMatrices(toRoot, o.matrixWorld)); });
    const geo = BGU.mergeGeometries(geos);
    for (const c of geos) c.dispose();
    if (!geo) continue;
    const a = list[0], mesh = new THREE.Mesh(geo, a.material);
    mesh.name = 'batched'; mesh.castShadow = a.castShadow; mesh.receiveShadow = a.receiveShadow; mesh.renderOrder = a.renderOrder;
    mesh.layers.mask = a.layers.mask; mesh.userData.noAO = a.userData.noAO;
    for (const o of list) o.removeFromParent();
    root.add(mesh);
    merged++; removed += list.length;
  }
  // Nothing in there moves: skip recomputing its matrices every frame.
  root.traverse((o) => { o.updateMatrix(); o.matrixAutoUpdate = false; });
  root.updateMatrixWorld(true);
  return { merged, removed };
}

// Compile the shaders while the loading screen is up (in parallel where the browser can), rather than as a stall on
// the first frames of the menu, a rally or a replay. Materials of objects that are hidden until then are included.
async function warmShaders() {
  const wait = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
  try { await wait(renderer.compileAsync(scene, camera), 4000); } catch (e) { console.warn('Palm Court: shader warm-up skipped:', e); }
}

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
  try { if (Stadium.group) Perf.batched = batchStatic(Stadium.group, Stadium); } catch (e) { console.warn('Palm Court: static batching skipped:', e); }
  BallKids.init(Stadium.kids);
  Env.onChange((tod) => { Stadium.setTimeOfDay(tod); Effects.setTimeOfDay(tod); Crowd.setTimeOfDay(tod); });
  Env.setTimeOfDay(Settings.tod || 'day');
  status('Warming up…', 92); await yieldFrame();
  UI.init();
  Game.init();
  if (software) UI.gpuWarning();
  Game.startAttract();
  await warmShaders();
  booted = true;
  requestAnimationFrame(frame);
  $('loading').hidden = true;
  UI.go('menu');
  const q = new URLSearchParams(location.search).get('join');
  if (q && /^[A-Za-z0-9]{5}$/.test(q)) UI.openLobby(q.toUpperCase());
  window.PalmCourt = { Game, Net, Input, Settings, Clock, Perf, Tracker, Phone, Env, Stadium, World, Cam, Crowd, Replay, Effects, renderer, scene, camera, Profile, Progress, Economy };
}
boot().catch((e) => {
  console.error(e);
  status('The court failed to load: ' + (e && e.message ? e.message : e));
});
