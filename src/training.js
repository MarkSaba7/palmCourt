// Palm Court: Training and the first-run tutorial. The drills (target practice, serve speed, rally streak) give the
// grind a gentle on-ramp and teach the controls, the webcam ones above all. They run on the game's own ball, serve and
// swing machinery through the Game.drill hooks in game.js (a drill feeds its balls, and takes over the rulings so
// nothing is scored); zones, scoring, grades and the coaching text are src/drills.js. Small rewards, capped per day,
// through Progress.applyTraining; personal bests and the tutorial's completion live on the Profile. Screens, HUD and
// styles are created here, so index.html needs no markup for them.
import * as THREE from 'three';
import { clamp, rand, RPM, solveShot, Clock, Settings } from './core.js';
import { Sound } from './match.js';
import { scene, Crowd, Env } from './render/world.js';
import { Game } from './game.js';
import { UI, $, STEPS } from './ui.js';
import { Input } from './input.js';
import { Bus } from './events.js';
import { Profile } from './profile.js';
import { Progress } from './progress.js';
import { Pad } from './pad.js';
import { proName } from './pros.js';
import { fmtFuzz, fmtXP, TRAINING } from './economy.js';
import { DRILLS, TUTORIAL, TUTORIAL_STEPS, drillById, gradeFor, ZONES, ZONE_ORDER, zoneRect, judgeShot, targetPoints, judgeServe, servePoints, serviceRect, CLEAN, rallyTier, RALLY_TIERS, feederLevel, feederPersona, coachHint, strokeArrow } from './drills.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = (n) => Math.round(n || 0).toLocaleString('en-US');
const touch = () => matchMedia('(pointer: coarse)').matches;
const CONTROLS = [
  ['mouse', 'Mouse & keyboard', 'No camera needed. Click, tap or press Space to swing.'],
  ['hand', 'Hand cam', 'Swing your hand at the webcam, like a racket.'],
  ['paddle', 'Paddle cam', 'Swing a brightly coloured ping-pong paddle at the webcam.'],
  ['phone', 'Phone racket', 'Your phone is the racket: scan a code to pair it.'],
  ['pad', 'Controller', 'PlayStation, Xbox or Switch: hold a shot button, let go as the ball arrives; the stick aims.'],
];
const CTL_NAME = { mouse: 'Mouse / keys', hand: 'Hand cam', paddle: 'Paddle cam', phone: 'Phone', pad: 'Controller' };
const PHONE_STEPS = '<li><b>Hold your phone like a racket handle,</b> screen facing up, and swing it as you would a racket.</li><li><b>Tap or lift the phone</b> to toss when you serve.</li><li><b>Keep the game tab in front</b> on the computer; the phone page must stay open too.</li>';

const CSS = `
.tr-slab { width: min(900px, 100%); }
.tr-head { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: flex-end; justify-content: space-between; }
.tr-ctl { display: grid; gap: 6px; justify-items: end; }
.tr-ctl > span { font: 700 11px/1 var(--body); letter-spacing: .14em; text-transform: uppercase; color: var(--mist); }
.tr-ctl .opts { min-width: min(360px, 80vw); }
.tr-drills { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }
.tr-card { border: 1px solid var(--edge); border-top: 3px solid var(--optic); background: rgba(242,245,238,.04); padding: 12px 14px 14px; display: grid; gap: 6px; align-content: start; }
.tr-card h3 { margin: 0; font: 900 28px/.95 var(--display); text-transform: uppercase; }
.tr-card p { margin: 0; font-size: 13px; color: var(--mist); }
.tr-card .tr-meta { font: 700 11px/1.2 var(--body); letter-spacing: .12em; text-transform: uppercase; color: var(--optic); }
.tr-card .tr-best { color: var(--chalk); }
.tr-card .tr-best b { color: var(--optic); }
.tr-card .btn { margin-top: 6px; justify-self: start; }
.tr-foot { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; }
.tr-foot .fine { max-width: 60ch; }
/* results */
.tr-over { width: min(560px, 100%); }
.tr-result { display: grid; grid-template-columns: auto 1fr; gap: 16px; align-items: center; }
.tr-grade { width: 88px; height: 88px; display: grid; place-items: center; border: 2px solid var(--optic); color: var(--optic); font: 900 64px/1 var(--display); }
.tr-grade.g-D, .tr-grade.g-C { border-color: var(--edge); color: var(--chalk); }
.tr-result h3 { margin: 0; font: 900 44px/.9 var(--display); text-transform: uppercase; }
.tr-result p { margin: 4px 0 0; color: var(--mist); font-size: 14px; }
.tr-pb { color: var(--good) !important; font-weight: 700; }
.tr-stats { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 18px; font-size: 14px; }
.tr-stats li { display: flex; justify-content: space-between; gap: 10px; border-top: 1px solid var(--line); padding-top: 6px; color: var(--mist); }
.tr-stats b { color: var(--chalk); font-variant-numeric: tabular-nums; }
.tr-rw { margin: 0; padding: 10px 12px; list-style: none; display: grid; gap: 4px; font-size: 13px; background: rgba(242,245,238,.04); border: 1px solid var(--edge); }
.tr-rw li { display: grid; grid-template-columns: 1fr auto auto; gap: 14px; color: var(--mist); }
.tr-rw li span { font-variant-numeric: tabular-nums; text-align: right; min-width: 5.5em; }
.tr-rw li.tot { color: var(--chalk); font-weight: 700; border-top: 1px solid var(--line); padding-top: 4px; }
.tr-rw li.tot span:first-of-type { color: var(--optic); }
.tr-tip { margin: 0; font-size: 14px; }
.tr-tip b { color: var(--optic); }
/* in-drill HUD */
.tr-hud { position: absolute; inset: 0; pointer-events: none; }
.tr-panel { position: absolute; top: calc(var(--hp) + env(safe-area-inset-top, 0px)); left: calc(var(--hp) + env(safe-area-inset-left, 0px)); min-width: 190px; padding: 10px 14px 12px; background: var(--scrim); border: 1px solid var(--edge); border-left: 3px solid var(--optic); display: grid; gap: 4px; }
.tr-panel .tr-name { margin: 0; font: 700 11px/1 var(--body); letter-spacing: .14em; text-transform: uppercase; color: var(--optic); }
.tr-big { display: flex; align-items: baseline; gap: 8px; }
.tr-big b { font: 900 46px/.9 var(--display); font-variant-numeric: tabular-nums; }
.tr-big small { font: 700 12px/1 var(--body); letter-spacing: .1em; text-transform: uppercase; color: var(--mist); }
.tr-panel .tr-sub { margin: 0; font-size: 13px; color: var(--mist); }
.tr-bar { height: 3px; background: var(--line); overflow: hidden; }
.tr-bar i { display: block; height: 100%; width: var(--p, 0%); background: var(--optic); transition: width .3s; }
.tr-coach { position: absolute; top: calc(var(--hp) + env(safe-area-inset-top, 0px)); left: 50%; transform: translateX(-50%); width: max-content; max-width: min(560px, calc(100vw - 2 * var(--hp) - 470px));
  display: grid; grid-template-columns: auto 1fr; gap: 12px; align-items: center; padding: 9px 16px 10px 12px; background: var(--scrim); border: 1px solid var(--edge); transition: background .15s, border-color .15s; }
.tr-coach:not(:has(.tr-arrow:empty)) { padding-left: 10px; }
.tr-arrow { font: 900 40px/1 var(--display); color: var(--optic); min-width: 1ch; text-align: center; }
.tr-arrow:empty { display: none; }
.tr-coach b { display: block; font: 900 24px/1 var(--display); text-transform: uppercase; letter-spacing: .02em; }
.tr-coach span { display: block; font-size: 14px; line-height: 1.3; color: var(--chalk); opacity: .86; }
.tr-coach[data-tone=now] { background: var(--optic); border-color: var(--optic); color: var(--optic-ink); }
.tr-coach[data-tone=now] :is(span, .tr-arrow) { color: var(--optic-ink); }
.tr-coach[data-tone=warn] { border-color: var(--coral); }
.tr-coach[data-tone=warn] b { color: var(--coral); }
.tr-coach[data-tone=good] { border-color: var(--good); }
.tr-coach[data-tone=good] b { color: var(--good); }
html.drilling #scoreboard, html.drilling #pauseScore { display: none !important; }
@media (max-width: 1040px) { .tr-coach { top: calc(var(--hp) + 100px + env(safe-area-inset-top, 0px)); max-width: calc(100vw - 2 * var(--hp)); } }
@media (max-width: 560px) { .tr-panel { min-width: 0; padding: 7px 10px 8px; } .tr-big b { font-size: 34px; } .tr-coach b { font-size: 20px; } .tr-coach span { font-size: 13px; } .tr-arrow { font-size: 32px; } }
/* tutorial */
.tut-slab { width: min(760px, 100%); }
.tut-picks { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 8px; }
.tut-pick { display: grid; gap: 4px; min-height: 86px; align-content: start; }
.tut-pick b { font: 900 24px/1 var(--display); text-transform: uppercase; }
.tut-pick span { font-size: 13px; font-weight: 500; color: var(--mist); }
.tut-pick.on { border-color: var(--optic); box-shadow: inset 0 0 0 1px var(--optic); }
.tut-steps { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; counter-reset: tut; }
.tut-steps li { border: 1px solid var(--edge); background: rgba(242,245,238,.04); padding: 10px 12px 12px; display: grid; gap: 4px; counter-increment: tut; }
.tut-steps li::before { content: counter(tut); font: 900 30px/1 var(--display); color: var(--optic); }
.tut-steps b { font: 900 22px/1 var(--display); text-transform: uppercase; }
.tut-steps span { font-size: 13px; color: var(--mist); }
.tut-tips { margin: 0; padding-left: 18px; display: grid; gap: 5px; color: var(--mist); font-size: 14px; }
.tut-tips b { color: var(--chalk); font-weight: 600; }
@media (max-width: 620px) { .tut-steps { grid-template-columns: 1fr; } }
/* first-run card on the menu */
.tut-card { position: absolute; right: max(20px, 4vw); top: 50%; transform: translateY(-50%); width: min(360px, calc(100vw - 40px)); z-index: 1; display: grid; gap: 10px; padding: 18px 18px 16px;
  background: var(--panel); border: 1px solid var(--edge); border-top: 3px solid var(--optic); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
.tut-card h3 { margin: 0; font: 900 34px/.92 var(--display); text-transform: uppercase; }
.tut-card p { margin: 0; color: var(--mist); font-size: 14px; }
/* narrow screens: pinned to the bottom while the menu scrolls, then below it, so it never hides the end of the menu */
@media (max-width: 900px) { #menu { flex-wrap: wrap; } .tut-card { position: sticky; top: auto; bottom: 12px; right: auto; flex: 0 0 100%; max-width: 460px; width: auto; margin-top: 12px; transform: none; } }
`;

const HTML = `
<main id="training" class="screen center" hidden aria-labelledby="trTitle">
  <section class="slab wide tr-slab">
    <header class="tr-head"><div><p class="eyebrow">Warm up · learn the controls</p><h2 id="trTitle">Training</h2></div>
      <div class="tr-ctl"><span id="trCtlLbl">Swing with</span><div class="opts" role="radiogroup" aria-labelledby="trCtlLbl" id="trCtl">${CONTROLS.map(([v, t]) => `<label><input type="radio" name="tr-control" value="${v}">${CTL_NAME[v] || t}</label>`).join('')}</div><button type="button" class="btn small ghost" id="btnTrCheck" hidden>Camera check</button></div></header>
    <div class="tr-drills" id="trDrills"></div>
    <div class="tr-foot"><p class="fine" id="trCap"></p><div class="actions row"><button type="button" id="btnTrBack" class="btn">Back</button><button type="button" id="btnTrTut" class="btn ghost">Replay the tutorial</button></div></div>
  </section>
</main>
<main id="drillOver" class="screen center" hidden aria-labelledby="doTitle">
  <section class="slab tr-over">
    <header><p class="eyebrow" id="doEyebrow">Training</p><h2 id="doTitle">Well played</h2></header>
    <div class="tr-result"><div class="tr-grade" id="doGrade">A</div><div><h3 id="doHead"></h3><p id="doSub"></p><p class="tr-pb" id="doPb" hidden></p></div></div>
    <ul class="tr-stats" id="doStats"></ul>
    <p class="tr-tip" id="doTip"></p>
    <ol class="tr-rw" id="doRw" aria-label="Rewards"></ol>
    <div class="actions row" id="doActs"></div>
  </section>
</main>
<main id="tutorial" class="screen center" hidden aria-labelledby="tutTitle">
  <section class="slab wide tut-slab" id="tutBody"></section>
</main>`;

// ---- the court props: glowing target zones and a ball machine (built on first use) ----
const Props = {
  zones: [], machine: null,
  zone(i) {
    if (this.zones[i]) return this.zones[i];
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(214,240,74,0.30)'; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(240,255,150,1)'; g.lineWidth = 5; g.strokeRect(2.5, 2.5, 123, 123);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    m.rotation.x = -Math.PI / 2; m.position.y = 0.012; m.renderOrder = 3; m.userData.noAO = true; m.visible = false;
    scene.add(m);
    return (this.zones[i] = m);
  },
  // Light a zone over the court rectangle r ({x0, x1, z0, z1}), or put it out (r = null).
  show(i, r) {
    const m = this.zone(i);
    m.visible = !!r;
    if (!r) return;
    m.scale.set(Math.max(0.1, r.x1 - r.x0), Math.max(0.1, r.z1 - r.z0), 1);
    m.position.set((r.x0 + r.x1) / 2, 0.012, (r.z0 + r.z1) / 2);
    m.material.color.set(0xffffff); m.userData.flash = 0;
  },
  flash(i, good) { const m = this.zones[i]; if (m && m.visible) { m.userData.flash = 1; m.material.color.set(good ? 0x9dffc4 : 0xff8a70); } },
  tick(t, dt) {
    for (const m of this.zones) {
      if (!m.visible) continue;
      const f = (m.userData.flash = Math.max(0, (m.userData.flash || 0) - dt * 1.6));
      m.material.opacity = f > 0 ? 0.7 + 0.6 * f : 0.62 + 0.3 * Math.sin(t * 4.2);
      if (!f) m.material.color.set(0xffffff);
    }
  },
  // A ball machine: a squat box on wheels with a basket of balls and a barrel aimed at the player.
  build() {
    if (this.machine) return this.machine;
    const grp = new THREE.Group(), std = (color, rough = 0.55, metal = 0.1) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.42, 0.72), std(0x1f3b5c));
    body.position.y = 0.33; grp.add(body);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.05, 0.74), std(0xd6f04a, 0.5));
    trim.position.y = 0.52; grp.add(trim);
    const basket = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.24, 0.28, 4, 1, true), std(0x2b2f33, 0.7, 0.3));
    basket.material.side = THREE.DoubleSide; basket.rotation.y = Math.PI / 4; basket.position.set(0, 0.69, -0.06); grp.add(basket);
    const balls = new THREE.InstancedMesh(new THREE.SphereGeometry(0.034, 10, 8), std(0xd6f04a, 0.8, 0), 18), o = new THREE.Object3D();
    for (let i = 0; i < 18; i++) { const a = i * 2.4, r = 0.05 + 0.15 * Math.sqrt(i / 18); o.position.set(Math.cos(a) * r, 0.72 + (i % 3) * 0.035, -0.06 + Math.sin(a) * r); o.updateMatrix(); balls.setMatrixAt(i, o.matrix); }
    grp.add(balls);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.36, 14), std(0x9aa3ab, 0.35, 0.6));
    barrel.rotation.x = Math.PI / 2 - 0.35; barrel.position.set(0, 0.62, 0.36); grp.add(barrel);
    for (const s of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.06, 16), std(0x16181a, 0.8));
      w.rotation.z = Math.PI / 2; w.position.set(s * 0.31, 0.11, -0.22); grp.add(w);
    }
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.06), std(0x16181a, 0.8));
    leg.position.set(0, 0.06, 0.26); grp.add(leg);
    grp.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    grp.visible = false;
    scene.add(grp);
    return (this.machine = grp);
  },
  hideAll() { for (const m of this.zones) m.visible = false; if (this.machine) this.machine.visible = false; },
};
const MACHINE = { x: 0, z: -12.7 }, MOUTH = { x: 0, y: 0.78, z: -12.25 };

// ---- one run of a drill: the object the Game.drill hooks call ----
class Run {
  constructor(def) {
    this.def = def; this.id = def.id; this.tut = def.id === 'tutorial';
    this.machine = def.id === 'target' || this.tut;
    this.t0 = 0; this.n = 0; this.score = 0; this.good = 0; this.clean = 0; this.streak = 0; this.bestStreak = 0; this.ins = 0; this.fastest = 0; this.zoneHits = 0;
    this.court = 'deuce'; this.over = false; this.endAt = 0; this.feedAt = 0; this.swingAt = 0; this.swung = false;
    this.judged = -1; this.hitRally = -1; this.hitClean = false; this.hitTau = null; this.lastSwing = null; this.serveKmh = 0;
    this.feedback = null; this.fbAt = -9; this.tally = { early: 0, late: 0, miss: 0, out: 0, net: 0, wrong: 0 };
    this.step = 0; this.stepGood = 0; this.stepTries = 0; this.stepLog = TUTORIAL_STEPS.map(() => ({ good: 0, tries: 0 }));
    this.tier = 0; this.feedSide = 1; this.stroke = 'fh'; this.zoneKey = null; this.rect = null; this.hudT = 0;
  }
  stepDef() { return this.tut ? TUTORIAL_STEPS[Math.min(this.step, TUTORIAL_STEPS.length - 1)] : null; }
  serving() { return this.id === 'serve' || (this.tut && this.stepDef().id === 'serve'); }
  me() { return Game.players[0]; }
  op() { return Game.players[1]; }
  begin() {
    this.t0 = Clock.now();
    const op = this.op();
    op.avatar.root.visible = !this.machine && this.id !== 'serve';
    Props.build().visible = this.machine;
    Props.machine.position.set(MACHINE.x, 0, MACHINE.z);
    if (this.id === 'rally') this.setTier(0);
    Training.render(true);
  }
  setTier(t) {
    const op = this.op();
    this.tier = t;
    op.level = feederLevel(t); op.persona = feederPersona(t);
  }

  // Game hook: a new point was set up (startPoint). A served drill keeps the serve; a fed one waits for its feed.
  point() {
    const G = Game, me = this.me(), op = this.op(), now = Clock.now();
    if (this.over || this.endAt) { G.state = 'feed'; this.feedAt = Infinity; return; }   // done: no more balls
    this.judged = -1; this.hitRally = -1; this.lastSwing = null; this.swung = false;
    if (this.serving()) {
      // Every serve is a first serve from alternating courts; Match(first = 0) keeps the player serving.
      if (!Object.prototype.hasOwnProperty.call(G.match, 'court')) Object.defineProperty(G.match, 'court', { get: () => this.court, configurable: true });
      G.match.serveNo = 1;
      op.avatar.root.visible = false;
      this.zoneKey = null; this.rect = serviceRect(this.court, 1);
      Props.show(0, this.rect);
      if (Props.machine) Props.machine.visible = false;
    } else {
      G.state = 'feed';   // (not a game state of its own: nothing happens in it until launch() puts the ball in play)
      me.x = me.tx = 0; me.z = me.tz = 12.3; me.vx = me.vz = 0; me.avatar.idle(false);
      op.x = op.tx = 0; op.z = op.tz = -12.4; op.vx = op.vz = 0;
      if (this.machine) { op.avatar.root.visible = false; Props.build().visible = true; }
      G.ball.visible = false;
      const first = this.n === 0 && this.good === 0;
      this.feedAt = now + (first ? 1.3 : 0.6);
      this.swingAt = this.machine ? 0 : this.feedAt - 0.32;
      const hs = me.handed === 'L' ? -1 : 1;
      if (this.tut) this.stroke = this.stepDef().stroke || 'fh';
      else if (this.id === 'target') this.stroke = this.n % 2 ? 'bh' : 'fh';
      else this.stroke = Math.random() < 0.5 ? 'fh' : 'bh';
      this.feedSide = this.stroke === 'fh' ? hs : -hs;
      this.zoneKey = this.id === 'target' ? ZONE_ORDER[this.n % ZONE_ORDER.length] : null;
      this.rect = this.zoneKey ? zoneRect(this.zoneKey, this.feedSide, 1) : null;
      Props.show(0, this.rect);
    }
    UI.prompt();
  }
  // Put a ball in play from the machine (or the feeder's racket) to the player's forehand or backhand side, with the
  // game's own shot solver and hit handling: from here it is an ordinary rally ball.
  launch() {
    const G = Game, b = G.ball, op = this.op(), now = Clock.now();
    const from = this.machine ? { ...MOUTH } : { x: op.x + 0.7 * (op.handed === 'L' ? -1 : 1) * op.side, y: 0.95, z: op.z - 0.35 * op.side };   // the feeder's forehand side
    const tut = this.tut, side = this.feedSide;
    const tx = this.id === 'rally' ? rand(-1.6, 1.6) : side * (tut ? 1.9 : rand(1.4, 2.6)), tz = tut ? 8.3 : rand(7.4, 9.2);
    const kmh = tut ? 50 : this.id === 'rally' ? 60 : rand(56, 68), rpm = 1300;
    G.state = 'rally';
    b.p = from; b.v = { x: 0, y: 0, z: 0 }; b.w = { x: 0, y: 0, z: 0 }; b.simT = now; b.active = true; b.visible = true; b.netDone = false; b.rolling = false;
    G.pending = null; G.hist.length = 0;
    const sol = solveShot(b.p, tx, tz, kmh / 3.6, rpm * RPM, { minNet: 0.45 });
    G.applyHit(op, { sol, rpm, kind: 'Feed', q: 1, power: 0.3 }, {});
  }

  // Game hook: every frame the game runs.
  update(now, dt) {
    const G = Game, b = G.ball;
    Props.tick(now, dt);
    if (this.over) return;
    if (this.endAt) { if (now >= this.endAt) this.finish(); return; }
    if (G.state === 'feed') {
      if (this.swingAt && !this.swung && now >= this.swingAt) { this.swung = true; this.op().avatar.swing('fh', this.feedAt); }
      if (now >= this.feedAt) this.launch();
    }
    // The player's shot at its first bounce: in (a zone, or the court) is judged here; out and net come as rulings.
    if (G.state === 'rally' && b.lastHitter === 0 && this.judged !== b.rally && G.bounceLog.length) {
      if (b.serve) this.serveResult(judgeServe(G.bounceLog[0], this.court, 1));
      else this.shotResult(judgeShot(G.bounceLog[0], 1, this.rect));
    }
    const el = now - this.t0;
    if ((this.def.kind === 'time' && el >= this.def.secs) || (this.def.maxSecs && el >= this.def.maxSecs)) this.finish();
    if (now - this.hudT > 0.1) { this.hudT = now; Training.render(); }
  }

  // Game hook: a ruling (point, fault or let). The drill makes its own call and moves on; returns true (handled).
  ruling(kind, w, reason) {
    const G = Game, b = G.ball;
    if (this.over || this.endAt) { G.enterDead(60, 'drill'); return true; }
    if (this.serving() && (b.serve || kind !== 'point')) {
      if (kind === 'let') { this.say('Let', 'Serve again'); G.enterDead(1.2, 'drill'); return true; }
      if (this.judged !== b.rally) this.serveResult(kind === 'fault' ? (reason === 'net' ? 'net' : 'out') : judgeServe(G.bounceLog[0], this.court, 1));
      return true;
    }
    if (b.lastHitter === 0) {
      // The player's own shot decided it: into the net or out (a ball in the court was judged at its bounce), or the
      // feeder couldn't get it back.
      if (this.judged !== b.rally) this.shotResult(judgeShot(G.bounceLog[0] || null, 1, this.rect));
      else if (this.id === 'rally') { this.say('Winner', 'The streak goes on'); G.enterDead(1.1, 'drill'); }
      return true;
    }
    // The fed ball: the player didn't get it back (w = 1), or the feeder missed (w = 0).
    if (w === 1) this.missed();
    else { this.say(reason === 'net' ? 'Net' : 'Out', 'Feeder error · the streak goes on'); G.enterDead(1.1, 'drill'); }
    return true;
  }

  // ---- results of each ball ----
  onHit(e) {
    if (this.over) return;
    if (e.idx === 0 && e.local && e.human) {
      if (e.serve) { this.serveKmh = e.kmh || 0; return; }
      this.hitRally = e.rally; this.hitTau = e.tau; this.hitClean = e.tau != null && Math.abs(e.tau) < CLEAN;
      const a = e.tau == null ? 0 : Math.abs(e.tau);
      this.note(this.hitClean ? 'clean' : a > 1 ? (e.tau < 0 ? 'early' : 'late') : 'good', false);
    } else if (e.idx === 1 && this.hitRally === e.rally - 1 && this.judged !== this.hitRally) {
      this.judged = this.hitRally;   // volleyed back before it bounced: it was going in
      this.count('in');
    }
  }
  shotResult(res) {
    const G = Game;
    this.judged = G.ball.rally;
    this.count(res);
    if (this.id === 'rally') { if (res === 'out' || res === 'net') G.enterDead(1.4, 'drill'); }
    else G.enterDead(res === 'zone' ? 1.1 : 0.9, 'drill');
  }
  count(res) {
    const ok = res === 'in' || res === 'zone', clean = ok && this.hitClean, before = this.streak;
    this.n++;
    if (res === 'zone') this.zoneHits++;
    if (ok) { this.good++; this.streak++; this.bestStreak = Math.max(this.bestStreak, this.streak); if (clean) this.clean++; } else this.streak = 0;
    if (res === 'out' || res === 'net') this.tally[res]++;
    if (this.id === 'target') {
      const pts = targetPoints(res, clean);
      this.score += pts;
      if (res === 'zone') { this.say('On target', `+${pts}${clean ? ' · clean timing' : ''}`); Crowd.cheer(0.35); }
      Props.flash(0, ok);
    }
    if (this.id === 'rally') {
      if (ok) {
        const t = rallyTier(this.good);
        if (t > this.tier) { this.setTier(t); this.say(RALLY_TIERS[t].label, `The feeder speeds up · streak ${this.streak}`); }
        else if (this.streak > 0 && this.streak % 5 === 0) { this.say(`${this.streak} in a row`, clean ? 'Clean timing' : 'Keep it going'); Crowd.cheer(0.3); }
      } else if (before > 0) this.say(res === 'net' ? 'Net' : res === 'out' ? 'Out' : 'Missed', `Streak ended at ${before}`);
    }
    if (this.tut) this.tutStep(ok);
    this.note(ok ? (clean ? 'clean' : res === 'zone' ? 'zone' : 'good') : res);
    if (this.def.kind === 'balls' && this.n >= this.def.balls) this.endAt = Clock.now() + 1.3;
  }
  // The ball got past the player: say why (no swing, early, late, the wrong way), from their last swing at it.
  missed() {
    const s = this.lastSwing && this.lastSwing.rally === Game.ball.rally ? this.lastSwing : null;
    let why = 'miss';
    if (s) why = s.wrong ? 'wrong' : s.dt < -0.25 ? 'early' : s.dt > 0.12 ? 'late' : 'miss';
    this.tally[why] = (this.tally[why] || 0) + 1;
    this.hitClean = false;
    this.judged = Game.ball.rally;
    this.count('miss');
    this.note(why);
    Game.enterDead(1.2, 'drill');
  }
  serveResult(res) {
    const kmh = Math.round(this.serveKmh || 0);
    this.judged = Game.ball.rally;
    this.n++;
    if (res === 'in') { this.ins++; this.good++; this.fastest = Math.max(this.fastest, kmh); this.score += servePoints(res, kmh); }
    else this.tally[res] = (this.tally[res] || 0) + 1;
    Props.flash(0, res === 'in');
    if (res === 'in') { this.say(`${kmh} km/h`, this.id === 'serve' ? `In · +${servePoints(res, kmh)}` : 'In'); if (kmh >= 170) Crowd.cheer(0.3); }
    else this.say(res === 'net' ? 'Net' : 'Out', `${kmh} km/h`);
    this.note(res === 'in' ? 'in' : res);
    this.court = this.court === 'deuce' ? 'ad' : 'deuce';
    if (this.tut) this.tutStep(res === 'in');
    if (this.def.kind === 'balls' && this.n >= this.def.balls) this.endAt = Clock.now() + 1.3;
    Game.enterDead(1.4, 'drill');
  }
  // Tutorial: count this ball for the current step; move on after enough good ones (or enough tries).
  tutStep(ok) {
    const st = this.stepDef(), log = this.stepLog[this.step];
    log.tries++; if (ok) log.good++;
    if (log.good < st.goal && log.tries < st.max) return;
    this.step++;
    if (this.step >= TUTORIAL_STEPS.length) { this.endAt = Clock.now() + 1.4; this.say('Nicely done', 'That’s the basics'); return; }
    const nx = TUTORIAL_STEPS[this.step];
    this.say(`Step ${this.step + 1} of ${TUTORIAL_STEPS.length}`, nx.title);
    this.feedback = null;
  }
  note(f, sticky = true) { this.feedback = f; this.fbAt = Clock.now(); this.fbSticky = sticky; }
  say(big, small) { UI.callout(big, small); }

  // The live hint for the control in use.
  hint() {
    const G = Game, me = this.me(), b = G.ball, now = Clock.now(), st = G.state;
    const ctx = { control: Settings.control, pad: Pad.active, padScheme: Settings.padScheme, touch: touch(), glyph: Pad.glyph('a'), glyphs: { a: Pad.glyph('a'), b: Pad.glyph('b'), x: Pad.glyph('x'), y: Pad.glyph('y') }, handed: me.handed, stroke: this.stroke, zone: this.zoneKey, feedback: null, phase: 'ready', serve: this.serving() };
    const fresh = this.feedback && now - this.fbAt < (this.fbSticky ? 2.6 : 1.2) ? this.feedback : null;
    if (this.serving() && (st === 'serve' || st === 'toss')) ctx.phase = st;
    else if (st === 'rally' && me.plan && b.lastHitter !== 0 && me.hitFor !== b.rally) {
      ctx.stroke = me.plan.stroke; ctx.phase = me.plan.t - now < 0.25 ? 'now' : 'incoming';
      if (ctx.phase === 'incoming' && now - this.fbAt < 1.0) ctx.feedback = fresh;
    } else ctx.feedback = fresh;
    return coachHint(ctx);
  }
  // The drill's line for the results and the Profile.
  summary() {
    const def = this.def, grade = this.tut ? '' : gradeFor(this.id, this.id === 'rally' ? this.bestStreak : this.score);
    const pb = this.id === 'serve' ? this.fastest : this.id === 'rally' ? this.bestStreak : this.tut ? 1 : this.score;
    return { mode: 'training', drill: this.id, name: def.name, grade, score: this.id === 'rally' ? this.bestStreak : this.score, pb, balls: this.n, good: this.good, clean: this.clean, streak: this.bestStreak, fastestServe: this.fastest, inServes: this.ins, tier: this.tier, durationS: Math.round(Clock.now() - this.t0), control: Settings.control };
  }
  finish() {
    if (this.over) return;
    this.over = true;
    const G = Game;
    G.state = 'over'; G.pending = null;
    for (const p of G.players) { p.plan = null; p.avatar.prep = 0; }
    Props.hideAll();
    Training.finished(this);
  }
}

// ---- the module: screens, menu hooks, first-run offer ----
export const Training = {
  run: null, last: null, returnTo: null, lastScreen: null, offered: false,
  init() {
    if ($('training')) return;
    const css = document.createElement('style');
    css.id = 'trainingCss'; css.textContent = CSS;
    document.head.append(css);
    const box = document.createElement('div');
    box.innerHTML = HTML;
    const at = $('hud');
    for (const el of [...box.children]) at ? at.before(el) : document.body.append(el);
    // In-drill HUD: a score panel where the scoreboard goes, and the coach's hint at the top.
    $('hud').insertAdjacentHTML('beforeend', `<div class="tr-hud" id="trHud" hidden><div class="tr-panel"><p class="tr-name" id="trHudName"></p><div class="tr-big"><b id="trHudBig">0</b><small id="trHudUnit"></small></div><p class="tr-sub" id="trHudSub"></p><div class="tr-bar"><i id="trHudBar"></i></div></div>
      <div class="tr-coach" id="trCoach" aria-live="polite"><span class="tr-arrow" id="trArrow"></span><div><b id="trCoachHead"></b><span id="trCoachText"></span></div></div></div>`);
    // Menu: Training, right after Practice.
    const b = document.createElement('button');
    b.id = 'btnTraining'; b.className = 'btn'; b.textContent = 'Training';
    b.onclick = () => this.open();
    if ($('btnPractice')) $('btnPractice').after(b);
    // Help: the menu's How to play, and Settings > Controls, can replay the tutorial.
    const how = document.querySelector('#menu details.howto ul');
    if (how) how.insertAdjacentHTML('beforeend', '<li><b>New here?</b> <button type="button" class="linkish" id="btnHowTut">Take the tutorial</button>, or warm up in <b>Training</b>.</li>');
    if ($('btnHowTut')) $('btnHowTut').onclick = () => this.openTutorial();
    const check = $('optCheck') && $('optCheck').closest('.opt-row');
    if (check) {
      check.insertAdjacentHTML('afterend', '<div class="opt-row"><span class="lbl">Tutorial</span><div><button type="button" class="btn small" id="optTutorial">Replay the tutorial</button></div><span class="hint" id="optTutHint">Controls, camera check and a guided rally. From the main menu.</span></div>');
      $('optTutorial').onclick = () => { if (!this.inMatch()) this.openTutorial(); };
    }
    $('btnTrBack').onclick = () => UI.go('menu');
    $('btnTrTut').onclick = () => this.openTutorial();
    $('btnTrCheck').onclick = () => { this.returnTo = 'training'; UI.openControls('menu'); };
    $('trCtl').addEventListener('change', (e) => { if (e.target.name === 'tr-control') { UI.setControl(e.target.value); UI.menuNote(''); this.renderHub(); } });
    Bus.on('screen', ({ screen }) => this.onScreen(screen));
    Bus.on('match:start', ({ cfg }) => { if (!cfg.drill) this.stop(); });
    Bus.on('hit', (e) => { if (this.run) this.run.onHit(e); });
    Input.on((ev) => this.onInput(ev));   // after Game.onInput (main.js inits Training after Game): tEff is set
    Profile.ready.then(() => this.maybeOffer());
  },
  inMatch() { return (Game.mode === 'cpu' || Game.mode === 'online') && !(this.run && this.run.over); },

  // ---- starting and stopping a drill ----
  async start(id) {
    const def = drillById(id);
    if (!def) return;
    Sound.init();
    Clock.resume();   // (from a results screen reached while paused)
    this.returnTo = UI.screen === 'tutorial' ? 'tutorial' : 'training';
    const ok = await UI.ensureControls(() => this.start(id));   // camera on, or the phone paired, as for a match
    if (!ok) return;
    this.returnTo = null;
    const run = new Run(def);
    this.run = run;
    Env.setTimeOfDay(Settings.tod || 'day');
    Game.startMatch({
      mode: 'cpu', localIdx: 0, names: [proName(Settings.playAs, Settings.name || 'You'), id === 'rally' ? 'Feeder' : 'Ball machine'], handed: [Settings.handed, 'R'],
      ctl: ['human', id === 'rally' ? 'cpu' : 'drill'], surface: Settings.surface, format: 'short', first: 0, level: 'club', pros: [Settings.playAs, 'custom'],
      drill: run, training: id,
    });
    run.begin();
    document.documentElement.classList.add('drilling');
    $('trHud').hidden = false;
    UI.go(null);
  },
  // Back to normal play (any match that isn't a drill clears it).
  stop() {
    const r = this.run;
    this.run = null;
    document.documentElement.classList.remove('drilling');
    if ($('trHud')) $('trHud').hidden = true;
    Props.hideAll();
    if (r && Game.players[1]) Game.players[1].avatar.root.visible = true;
  },
  finished(run) {
    let res = null;
    const s = run.summary();
    try { if (Profile.loaded) res = Progress.applyTraining(s); } catch (e) { console.error('[training] reward failed', e); }
    if (run.tut) this.markTutorial('done');
    this.last = { run, s, res };
    $('trHud').hidden = true;
    setTimeout(() => { if (this.run === run) { Clock.resume(); this.renderOver(); UI.go('drillOver'); } }, 900);
  },

  // ---- per frame (from the drill's update) ----
  render(force) {
    const r = this.run;
    if (!r || (!force && UI.screen !== null)) return;
    const def = r.def, now = Clock.now(), best = Progress.best(r.id);
    let big = r.score, unit = 'pts', sub = '', p = 0;
    if (r.id === 'target') { sub = `Ball ${Math.min(r.n + 1, def.balls)} / ${def.balls} · streak ${r.streak}${best ? ` · best ${best.v}` : ''}`; p = r.n / def.balls; }
    else if (r.id === 'serve') { sub = `Serve ${Math.min(r.n + 1, def.balls)} / ${def.balls} · ${r.ins} in${r.fastest ? ` · top ${r.fastest} km/h` : ''}`; p = r.n / def.balls; }
    else if (r.id === 'rally') {
      big = r.streak; unit = 'in a row';
      const left = Math.max(0, def.secs - (now - r.t0));
      sub = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')} · best ${r.bestStreak}${best ? ` (PB ${best.v})` : ''} · ${RALLY_TIERS[r.tier].label}`;
      p = 1 - left / def.secs;
    } else {
      const st = r.stepDef(), log = r.stepLog[Math.min(r.step, TUTORIAL_STEPS.length - 1)];
      big = `${Math.min(r.step + 1, TUTORIAL_STEPS.length)}/${TUTORIAL_STEPS.length}`; unit = st.title;
      sub = `${log.good} of ${st.goal} good${st.id === 'serve' ? ' serves' : ' shots'}`; p = (r.step + Math.min(1, log.good / st.goal)) / TUTORIAL_STEPS.length;
    }
    $('trHudName').textContent = r.tut ? 'Tutorial · guided rally' : `Training · ${def.name}`;
    $('trHudBig').textContent = big; $('trHudUnit').textContent = unit; $('trHudSub').textContent = sub;
    $('trHudBar').style.setProperty('--p', `${clamp(p, 0, 1) * 100}%`);
    const h = r.over ? null : r.hint(), c = $('trCoach');
    c.hidden = !h;
    if (h && (h.head !== this.hHead || h.text !== this.hText || h.tone !== this.hTone || h.arrow !== this.hArrow)) {
      this.hHead = h.head; this.hText = h.text; this.hTone = h.tone; this.hArrow = h.arrow;
      $('trArrow').textContent = h.arrow; $('trCoachHead').textContent = h.head; $('trCoachText').textContent = h.text;
      c.dataset.tone = h.tone || '';
    }
  },
  // Swings at an incoming ball, for the hint when it gets past (the game has already judged it; this only listens).
  onInput(ev) {
    const r = this.run;
    if (!r || r.over || ev.type !== 'swing' || !ev.swing) return;
    const G = Game, me = G.me(), b = G.ball, plan = me && me.plan;
    if (G.state !== 'rally' || !plan || b.lastHitter === 0) return;
    const sw = ev.swing, t = sw.tEff ?? sw.t0, dt = t - plan.t;
    if (dt < -0.6) return;   // a wind-up well before the ball
    r.lastSwing = { rally: b.rally, dt, wrong: !!sw.dir && sw.dir !== plan.stroke && Math.abs(dt) < 0.3 };
  },

  // ---- screens ----
  onScreen(screen) {
    const last = this.lastScreen;
    this.lastScreen = screen;
    // Back from the camera check or phone pairing that a drill or the tutorial opened: carry on there.
    if (this.returnTo && screen === 'menu' && (last === 'setup' || last === 'phone')) {
      const to = this.returnTo;
      this.returnTo = null;
      queueMicrotask(() => (to === 'tutorial' ? this.openTutorial('rally') : this.open()));
      return;
    }
    if (screen !== 'setup' && screen !== 'phone' && screen !== null) this.returnTo = null;
    if (screen === 'drillOver' || screen === 'training' || screen === 'tutorial') queueMicrotask(() => { if (UI.screen === screen) $('hud').hidden = true; });   // (UI.go sets the HUD after this)
    if (screen === 'options' && $('optTutorial')) { const m = this.inMatch(); $('optTutorial').disabled = m; $('optTutHint').textContent = m ? 'Available from the main menu.' : 'Controls, camera check and a guided rally.'; }
    if (screen === 'menu' && this.run && !Game.cfg?.drill) this.stop();
  },
  open() {
    if (this.inMatch()) return;
    this.renderHub();
    UI.go('training');
    const b = document.querySelector('#trDrills .btn.primary');
    if (b) b.focus({ preventScroll: true });
  },
  renderHub() {
    const T = Profile.loaded ? Progress.training() : { best: {}, day: { xp: 0, fuzz: 0 } };
    $('trDrills').innerHTML = DRILLS.map((d) => {
      const b = T.best[d.id], len = d.kind === 'time' ? `${d.secs} seconds` : `${d.balls} ${d.id === 'serve' ? 'serves' : 'balls'} · about a minute`;
      const best = b ? `Best: <b>${nf(b.v)} ${esc(d.unit)}</b>${b.grade ? ` · grade ${esc(b.grade)}` : ''}` : 'No best yet';
      return `<article class="tr-card"><p class="tr-meta">${len}</p><h3>${esc(d.name)}</h3><p>${esc(d.blurb)}</p><p class="tr-best">${best}</p><button type="button" class="btn primary small" data-drill="${d.id}">Start</button></article>`;
    }).join('');
    for (const btn of $('trDrills').querySelectorAll('[data-drill]')) btn.onclick = () => this.start(btn.dataset.drill);
    for (const r of $('trCtl').querySelectorAll('input')) r.checked = r.value === Settings.control;
    const cam = Settings.control === 'hand' || Settings.control === 'paddle';
    $('btnTrCheck').hidden = Settings.control === 'mouse';
    $('btnTrCheck').textContent = Settings.control === 'phone' ? 'Connect phone' : Settings.control === 'pad' ? 'Test controller' : 'Camera check';
    // Both caps: Fuzz usually runs out before XP does.
    const [capX, capF] = TRAINING.daily, xp = Math.min(capX, T.day.xp || 0), fuzz = Math.min(capF, T.day.fuzz || 0);
    const full = xp >= capX && fuzz >= capF ? ' (done for today: matches still pay in full)' : fuzz >= capF ? ' (Fuzz done for today: drills still pay XP, matches pay in full)' : xp >= capX ? ' (XP done for today: drills still pay Fuzz, matches pay in full)' : '';
    $('trCap').textContent = `Drills pay a little XP and Fuzz, capped each day. Today: ${nf(xp)}/${fmtXP(capX)} · ${nf(fuzz)}/${fmtFuzz(capF)}${full}.${cam ? ' Hint: run the camera check first for smoother swings.' : ''}`;
  },
  renderOver() {
    const L = this.last, r = L.run, s = L.s, res = L.res, def = r.def, tut = r.tut;
    $('doEyebrow').textContent = tut ? 'Tutorial complete' : 'Training';
    $('doTitle').textContent = tut ? 'You’re ready' : def.name;
    const g = $('doGrade');
    g.textContent = tut ? '✓' : s.grade; g.className = `tr-grade g-${tut ? 'S' : s.grade}`;
    const head = tut ? 'The basics, done' : r.id === 'serve' ? (r.fastest ? `${r.fastest} km/h` : 'No serve in') : r.id === 'rally' ? `${r.bestStreak} in a row` : `${nf(r.score)} points`;
    $('doHead').textContent = head;
    $('doSub').textContent = tut ? 'Forehand, backhand and serve.' : r.id === 'serve' ? `Fastest serve in · ${r.ins} of ${r.n} in` : r.id === 'rally' ? `Best streak · ${r.good} good returns` : `${r.good} of ${r.n} in the court`;
    const pb = res && res.best, pbEl = $('doPb');
    pbEl.hidden = tut || !pb || !pb.isNew;
    if (pb && pb.isNew) pbEl.textContent = pb.prev ? `New personal best (was ${nf(pb.prev.v)} ${def.unit})` : 'Personal best set';
    const stats = tut ? r.stepLog.map((l, i) => [TUTORIAL_STEPS[i].title, `${l.good} / ${l.tries}`])
      : r.id === 'target' ? [['On target', `${r.zoneHits} / ${r.n}`], ['In the court', `${r.good} / ${r.n}`], ['Clean timing', r.clean], ['Best streak', r.bestStreak]]
        : r.id === 'serve' ? [['Serves in', `${r.ins} / ${r.n}`], ['Score', r.score], ['Fastest in', r.fastest ? `${r.fastest} km/h` : '–'], ['Grade', s.grade]]
          : [['Good returns', r.good], ['Clean timing', r.clean], ['Feeder reached', RALLY_TIERS[r.tier].label], ['Grade', s.grade]];
    $('doStats').innerHTML = stats.map(([k, v]) => `<li>${esc(k)} <b>${esc(v)}</b></li>`).join('');
    $('doTip').innerHTML = this.tip(r);
    const rw = $('doRw');
    if (res) {
      rw.hidden = false;
      rw.innerHTML = res.lines.map((l) => `<li>${esc(l.label)}<span>${l.xp >= 0 ? '+' : '−'}${nf(Math.abs(l.xp))} XP</span><span>${l.fuzz >= 0 ? '+' : '−'}${nf(Math.abs(l.fuzz))} Fuzz</span></li>`).join('')
        + `<li class="tot">Total${res.levelTo > res.levelFrom ? ` · level ${res.levelTo}!` : ''}<span>+${nf(res.xp)} XP</span><span>+${nf(res.fuzz)} Fuzz</span></li>`;
    } else rw.hidden = true;
    const acts = $('doActs');
    acts.innerHTML = tut
      ? '<button type="button" class="btn primary" id="btnDoMatch">Play your first match</button><button type="button" class="btn" id="btnDoTrain">Training drills</button><button type="button" class="btn ghost" id="btnDoMenu" data-back>Main menu</button>'
      : '<button type="button" class="btn primary" id="btnDoAgain">Go again</button><button type="button" class="btn" id="btnDoTrain">Training</button><button type="button" class="btn ghost" id="btnDoMenu" data-back>Main menu</button>';
    if ($('btnDoAgain')) $('btnDoAgain').onclick = () => this.start(r.id);
    if ($('btnDoMatch')) $('btnDoMatch').onclick = () => { this.stop(); UI.startCpu({ level: 'rookie' }); };
    $('btnDoTrain').onclick = () => { UI.quit(); this.open(); };
    $('btnDoMenu').onclick = () => UI.quit();
    setTimeout(() => { const b = acts.querySelector('.btn.primary'); if (b && UI.screen === 'drillOver') b.focus({ preventScroll: true }); }, 0);
  },
  // One line of coaching from how the drill went.
  tip(r) {
    const t = r.tally, cam = Settings.control === 'hand' || Settings.control === 'paddle';
    const worst = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
    if (!worst || worst[1] < 2) return r.good ? '<b>Tip:</b> timing aims your shot. Swing early to pull it cross-court, late to go down the line.' : '';
    const k = worst[0];
    if (k === 'late') return `<b>Tip:</b> most misses were late. Start your swing as the ball bounces on your side${cam ? ', or lower Timing offset in Settings if your swings always land late' : ''}.`;
    if (k === 'early') return `<b>Tip:</b> most misses were early. Let the ball come to you, then swing${cam ? ' (raise Timing offset in Settings if your swings always land early)' : ''}.`;
    if (k === 'wrong') return '<b>Tip:</b> swing across your body: a forehand one way, a backhand the other. The arrow at the top shows which.';
    if (k === 'miss') return `<b>Tip:</b> your player runs to the ball, so you only swing: ${cam ? 'a clear swing across your body' : Settings.control === 'pad' && Settings.padScheme !== 'flick' ? 'hold a shot button and let go' : 'one click or key press'} as it reaches you.`;
    if (k === 'net') return '<b>Tip:</b> lots of balls in the net: swing low to high to lift them.';
    if (k === 'out') return '<b>Tip:</b> lots of balls out: a smoother, slower swing keeps them in.';
    return '';
  },

  // ---- first-run tutorial ----
  // Offered once, on the first launch of a fresh profile (never to someone who has already played), as a card on the
  // menu that doesn't block anything. ?tutorial=1 offers it anyway, ?tutorial=0 never.
  maybeOffer() {
    let q;
    try { q = new URLSearchParams(location.search); } catch (e) { q = new URLSearchParams(); }
    if (q.get('join') || q.get('tutorial') === '0') return;
    const played = Profile.stats.matches > 0 || Profile.history.length > 0 || Object.keys(Progress.training().runs).length > 0;
    if (q.get('tutorial') !== '1' && (Profile.data.tutorial || played)) return;
    Profile.data.tutorial = { ...(Profile.data.tutorial || {}), offered: Date.now() };
    Profile.changed();
    this.offered = true;
    const menu = $('menu');
    if (!menu || $('tutCard')) return;
    menu.insertAdjacentHTML('beforeend', `<aside class="tut-card" id="tutCard" aria-labelledby="tutCardT"><p class="eyebrow">First time here?</p><h3 id="tutCardT">Learn to play in two minutes</h3>
      <p>Pick your controls, check your camera, then a guided rally: forehand, backhand and serve.</p><div class="actions row"><button type="button" class="btn primary" id="btnTutGo">Start the tutorial</button><button type="button" class="btn ghost" id="btnTutSkip">Skip</button></div></aside>`);
    $('btnTutGo').onclick = () => this.openTutorial();
    $('btnTutSkip').onclick = () => { this.markTutorial('skipped'); this.hideCard(); UI.menuNote('You can take the tutorial any time: Training, or Settings › Controls.'); };
  },
  hideCard() { const c = $('tutCard'); if (c) c.remove(); },
  markTutorial(k) {
    if (!Profile.loaded) return;
    Profile.data.tutorial = { ...(Profile.data.tutorial || {}), [k]: Date.now() };
    Profile.changed();
  },
  tutorialDone() { return !!(Profile.data.tutorial && Profile.data.tutorial.done); },
  openTutorial(step = 'controls') {
    if (this.inMatch()) return;
    this.hideCard();
    this.tutStep = step;
    this.renderTutorial();
    UI.go('tutorial');
    const b = document.querySelector('#tutBody .btn.primary, #tutBody .tut-pick.on, #tutBody .tut-pick');
    if (b) b.focus({ preventScroll: true });
  },
  renderTutorial() {
    const body = $('tutBody'), step = this.tutStep, ctl = Settings.control;
    const head = (eyebrow, title) => `<header><p class="eyebrow">${eyebrow}</p><h2 id="tutTitle">${title}</h2></header>`;
    if (step === 'controls') {
      body.innerHTML = `${head('Tutorial · 1 of 3', 'How do you want to play?')}
        <div class="tut-picks">${CONTROLS.map(([v, t, d]) => `<button type="button" class="btn tut-pick${v === ctl ? ' on' : ''}" data-ctl="${v}"><b>${esc(t)}</b><span>${esc(d)}</span></button>`).join('')}</div>
        <p class="fine">A game controller works with any of these: just press a button on it. You can change controls any time in Settings.</p>
        <div class="actions row"><button type="button" class="btn ghost" id="btnTutBack" data-back>Not now</button></div>`;
      for (const b of body.querySelectorAll('[data-ctl]')) b.onclick = () => this.pickControl(b.dataset.ctl);
    } else if (step === 'camera' || step === 'phone') {
      const phone = step === 'phone';
      body.innerHTML = `${head('Tutorial · 2 of 3', phone ? 'Pair your phone' : 'Camera check')}
        <ul class="tut-tips">${phone ? PHONE_STEPS : STEPS[ctl] || ''}</ul>
        <p class="fine">${phone ? 'Scan the code with your phone, then press Done.' : 'Allow the camera when your browser asks. The check walks you through light, framing and a few practice swings; press Done at the end.'}</p>
        <div class="actions row"><button type="button" class="btn primary" id="btnTutCheck">${phone ? 'Connect phone' : 'Open the camera check'}</button><button type="button" class="btn" id="btnTutMouse">Use the mouse instead</button><button type="button" class="btn ghost" id="btnTutBack" data-back>Back</button></div>`;
      $('btnTutCheck').onclick = () => { this.returnTo = 'tutorial'; UI.openControls('menu'); };
      $('btnTutMouse').onclick = () => { UI.setControl('mouse'); this.openTutorial('rally'); };
    } else {
      const mode = Pad.active || ctl === 'pad' ? 'pad' : ctl, cam = ctl === 'hand' || ctl === 'paddle', hs = Settings.handed, btns = Settings.padScheme !== 'flick', G = (k) => `<b>${esc(Pad.glyph(k))}</b>`;
      const how = (stroke) => cam ? `Swing across your body <b>${strokeArrow(stroke, hs)}</b> as the ball reaches you.` : ctl === 'phone' ? `Swing your phone <b>${strokeArrow(stroke, hs)}</b> as the ball reaches you.` : mode === 'pad' ? (btns ? `Hold ${G('b')} (topspin) or ${G('a')} (flat) and let go as the ball reaches you. The left stick aims.` : `Press ${G('a')} as the ball reaches you.`) : `${touch() ? 'Tap' : 'Click'} as the ball reaches you.`;
      const serve = cam ? 'Raise your hand above the toss line to toss, then swing down through the ball.' : ctl === 'phone' ? 'Tap or lift your phone to toss, then swing.' : mode === 'pad' ? (btns ? `Press ${G('a')} to toss, hold it, and let go at the top of the toss.` : `${G('a')} to toss, ${G('a')} again to hit.`) : `${touch() ? 'Tap' : 'Click'} to toss, then again as the ball drops.`;
      const side = (stroke) => ((stroke === 'fh') === (hs !== 'L') ? 'right' : 'left');
      body.innerHTML = `${head(`Tutorial · ${cam || ctl === 'phone' ? '3' : '2'} of ${cam || ctl === 'phone' ? '3' : '2'}`, 'A guided rally')}
        <p class="tag" style="max-width:none">The ball machine feeds you a few balls. Your player runs to the ball: <b>you only swing</b>. The hint at the top of the screen tells you what to do, and when.</p>
        <ol class="tut-steps"><li><b>Forehand</b><span>Balls to your ${side('fh')}. ${how('fh')}</span></li><li><b>Backhand</b><span>Balls to your ${side('bh')}. ${how('bh')}</span></li><li><b>Serve</b><span>${serve}</span></li></ol>
        <p class="fine">Playing with: <b>${esc(CTL_NAME[ctl] || ctl)}</b>${Pad.active ? ' · controller' : ''}. Press Esc (or the controller's Start) to pause.</p>
        <div class="actions row"><button type="button" class="btn primary" id="btnTutStart">Start the rally</button><button type="button" class="btn" id="btnTutCtl">Change controls</button><button type="button" class="btn ghost" id="btnTutBack" data-back>Not now</button></div>`;
      $('btnTutStart').onclick = () => this.start('tutorial');
      $('btnTutCtl').onclick = () => this.openTutorial('controls');
    }
    const back = $('btnTutBack');
    if (back) back.onclick = () => (step === 'camera' || step === 'phone' ? this.openTutorial('controls') : UI.go('menu'));
  },
  pickControl(v) {
    UI.setControl(v);
    UI.menuNote('');
    this.openTutorial(v === 'hand' || v === 'paddle' ? 'camera' : v === 'phone' ? 'phone' : 'rally');
  },
};

export { Run, Props };
