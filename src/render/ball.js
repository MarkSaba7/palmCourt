// The ball: optic-yellow felt with the real seam curve (and a bump for felt and seam groove), a soft fuzz rim, a squash
// on the bounce frame, real and contact shadows, a motion streak, and the bounce-spot marker.
import * as THREE from 'three';
import { clamp, BALL_R, Settings } from '../core.js';
import { scene, camera } from './renderer.js';
import { canvasTex } from './textures.js';
import { World, addBallMark, clearBallMarks } from './court.js';

const VISUAL_R = BALL_R * 1.55;   // drawn a little larger than life so it reads at a distance
const MIN_PX = 1.6;               // ...and never smaller than this radius on screen (CSS px), for the far end of the court
const TRAIL = 14;

// The seam of a tennis ball: two lobes, x = a cos t + b cos 3t, z = a sin t - b sin 3t, y = 2 sqrt(ab) sin 2t, which
// lies exactly on the unit sphere when a + b = 1. y is the sphere's pole axis here, so the seam stays clear of the poles.
function seamPoints(n, a = 0.7) {
  const b = 1 - a, c = 2 * Math.sqrt(a * b), out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2, x = a * Math.cos(t) + b * Math.cos(3 * t), z = a * Math.sin(t) - b * Math.sin(3 * t), y = c * Math.sin(2 * t);
    out.push({ u: Math.atan2(z, -x) / (Math.PI * 2), v: Math.acos(clamp(y, -1, 1)) / Math.PI, s: Math.sqrt(Math.max(0.05, 1 - y * y)) });
  }
  return out;
}
// Paint the seam into a SphereGeometry-mapped canvas: dabs of a fixed size on the sphere (wider in u away from the
// equator), repeated across the u wrap.
function paintSeam(x, W, H, pts, rad, style) {
  x.fillStyle = style;
  for (const p of pts) {
    const ry = (rad / Math.PI) * H, rx = Math.min(W / 4, ry / p.s * (W / H) / 2), cx = (((p.u % 1) + 1) % 1) * W;
    for (const o of [0, -W, W]) { if (o && (cx + o + rx < 0 || cx + o - rx > W)) continue; x.beginPath(); x.ellipse(cx + o, p.v * H, rx, ry, 0, 0, Math.PI * 2); x.fill(); }
  }
}

export const BallView = (() => {
  const seam = seamPoints(900);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Felt: optic yellow, mottled at two scales, with stray fibres; the seam a pale rubber strip in a darker groove.
  const felt = canvasTex(512, 256, (x, W, H) => {
    x.fillStyle = '#d9f24e'; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 260; i++) { x.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,210' : '150,170,20'},${0.05 + rnd() * 0.05})`; x.beginPath(); x.arc(rnd() * W, rnd() * H, 6 + rnd() * 18, 0, Math.PI * 2); x.fill(); }
    const img = x.getImageData(0, 0, W, H), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (rnd() - 0.5) * 26; d[i] += n; d[i + 1] += n; d[i + 2] += n * 0.35; }
    x.putImageData(img, 0, 0);
    x.lineWidth = 1; x.lineCap = 'round';
    for (let i = 0; i < 900; i++) { const px = rnd() * W, py = rnd() * H, a = rnd() * Math.PI * 2, l = 2 + rnd() * 4; x.strokeStyle = `rgba(${rnd() < 0.5 ? '250,255,215' : '160,180,30'},0.35)`; x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l); x.stroke(); }
    paintSeam(x, W, H, seam, 0.07, 'rgba(120,135,40,0.9)');
    paintSeam(x, W, H, seam, 0.043, '#eef1dc');
    paintSeam(x, W, H, seam, 0.014, '#fbfcf2');
  });
  // Height for the bump: fine felt grain, the seam raised a touch in a groove.
  const bump = canvasTex(512, 256, (x, W, H) => {
    x.fillStyle = '#808080'; x.fillRect(0, 0, W, H);
    const img = x.getImageData(0, 0, W, H), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = 128 + (rnd() - 0.5) * 70; d[i] = d[i + 1] = d[i + 2] = n; }
    x.putImageData(img, 0, 0);
    paintSeam(x, W, H, seam, 0.07, '#3c3c3c');
    paintSeam(x, W, H, seam, 0.045, '#9a9a9a');
  }, { srgb: false });
  const mat = new THREE.MeshPhysicalMaterial({
    map: felt, bumpMap: bump, bumpScale: 1.2, roughness: 0.82, sheen: 1, sheenColor: new THREE.Color(0xf4ffb8), sheenRoughness: 0.35,
    emissive: new THREE.Color(0x2c3a00), emissiveIntensity: 0.4,
  });
  // Fuzz rim: the felt catches a little light right at the silhouette (keeps the ball off any background).
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      float fuzzRim = 1.0 - saturate(dot(normal, normalize(vViewPosition)));
      totalEmissiveRadiance += diffuseColor.rgb * (0.22 * fuzzRim * fuzzRim * fuzzRim);`);
  };
  // The drawn ball is a group: it squashes along world up on a bounce while the sphere inside spins freely.
  const mesh = new THREE.Group();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(VISUAL_R, 28, 18), mat);
  ball.castShadow = true;
  mesh.add(ball);
  // Soft contact shadow directly below, for depth when the ball is near the ground.
  const blobTex = canvasTex(64, 64, (x, W) => {
    const g = x.createRadialGradient(W / 2, W / 2, 0, W / 2, W / 2, W / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.8)'); g.addColorStop(0.5, 'rgba(0,0,0,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, W, W);
  });
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2;
  blob.renderOrder = 1;
  // Motion streak: a camera-facing ribbon through recent positions, fading toward the tail.
  const tPos = new Float32Array(TRAIL * 2 * 3), tCol = new Float32Array(TRAIL * 2 * 4), tIdx = [];
  for (let i = 0; i < TRAIL - 1; i++) { const a = i * 2; tIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const tGeo = new THREE.BufferGeometry();
  tGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3).setUsage(THREE.DynamicDrawUsage));
  tGeo.setAttribute('color', new THREE.BufferAttribute(tCol, 4).setUsage(THREE.DynamicDrawUsage));
  tGeo.setIndex(tIdx);
  const trail = new THREE.Mesh(tGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }));
  trail.frustumCulled = false;
  const hist = [];
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.15, 0.21, 48), new THREE.MeshBasicMaterial({ color: 0xd6f04a, transparent: true, opacity: 0, depthWrite: false }));
  marker.rotation.x = -Math.PI / 2; marker.position.y = 0.012;
  scene.add(mesh, blob, trail, marker);
  const tmp = new THREE.Vector3(), tan = new THREE.Vector3(), side = new THREE.Vector3(), view = new THREE.Vector3();
  let lastVy = 0, lastVz = 0, squash = 0;
  return {
    mesh,
    update(b, visible, dt) {
      mesh.visible = blob.visible = visible;
      if (!visible) { trail.visible = false; hist.length = 0; lastVy = lastVz = 0; squash = 0; return; }
      let x = b.p.x, y = b.p.y, z = b.p.z;
      // Bounce frame: the velocity has just turned up near the ground. Show the ball at the contact spot, squashed
      // (harder landings squash more), springing back over the next couple of frames.
      if (lastVy < -1 && b.v.y > 0 && y < BALL_R + 0.25 && b.v.z * lastVz >= 0) {   // (a low volley turns it round)
        squash = clamp(-lastVy * 0.018, 0.06, 0.2);
        const back = clamp((y - BALL_R) / Math.max(1, b.v.y), 0, 0.05);
        x -= b.v.x * back; z -= b.v.z * back; y = 0;
      } else squash *= Math.exp(-(dt || 0) / 0.022);
      lastVy = b.v.y; lastVz = b.v.z;
      // Never smaller than MIN_PX on screen; never sunk into the court (it's drawn larger than life).
      const dist = Math.hypot(camera.position.x - x, camera.position.y - y, camera.position.z - z);
      const px = (dist * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(200, innerHeight || 720);
      const s = Math.max(1, (px * MIN_PX) / VISUAL_R), sy = s * (1 - squash), sx = s * (1 + squash * 0.55);
      mesh.scale.set(sx, sy, sx);
      mesh.position.set(x, Math.max(y, VISUAL_R * sy + 0.001), z);
      ball.rotation.x += b.w.x * dt * 0.25; ball.rotation.z += b.w.z * dt * 0.25;
      const h = Math.max(0, b.p.y - BALL_R), sz = 0.12 + h * 0.035;
      blob.position.set(b.p.x, 0.009, b.p.z); blob.scale.set(sz, sz, 1);
      blob.material.opacity = clamp(0.62 - h * 0.35, 0, 0.62);
      const P = mesh.position;
      hist.unshift(P.x, P.y, P.z);
      if (hist.length > TRAIL * 3) hist.length = TRAIL * 3;
      const sp = Math.hypot(b.v.x, b.v.y, b.v.z), n = hist.length / 3;
      trail.visible = sp > 9 && n > 3;
      if (!trail.visible) return;
      const strength = clamp((sp - 9) / 18, 0, 1);
      // Keep the streak about as long as a camera shutter would smear it (~1/18 s of travel), not a fixed number of
      // frames: a 180 km/h serve would otherwise draw metres of line across the court.
      const maxLen = clamp(sp * 0.055, 0.35, 2.4);
      let m = 1, len = 0;
      while (m < n) { len += Math.hypot(hist[m * 3] - hist[m * 3 - 3], hist[m * 3 + 1] - hist[m * 3 - 2], hist[m * 3 + 2] - hist[m * 3 - 1]); if (len > maxLen) break; m++; }
      const cb = Settings.cbSafe;   // colour-blind-safe: a white streak reads on every court
      for (let i = 0; i < TRAIL; i++) {
        const j = Math.min(Math.round((i * (m - 1)) / (TRAIL - 1)), n - 1), k = Math.min(j + 1, n - 1), jm = Math.max(0, j - 1);
        tmp.set(hist[j * 3], hist[j * 3 + 1], hist[j * 3 + 2]);
        tan.set(hist[jm * 3] - hist[k * 3], hist[jm * 3 + 1] - hist[k * 3 + 1], hist[jm * 3 + 2] - hist[k * 3 + 2]);
        if (tan.lengthSq() < 1e-8) tan.set(1, 0, 0);
        view.subVectors(camera.position, tmp);
        side.crossVectors(tan, view).normalize();
        const f = 1 - i / (TRAIL - 1), w = VISUAL_R * s * (0.25 + 0.75 * f);   // as wide as the ball is drawn
        tPos.set([tmp.x + side.x * w, tmp.y + side.y * w, tmp.z + side.z * w, tmp.x - side.x * w, tmp.y - side.y * w, tmp.z - side.z * w], i * 6);
        const a = f * f * 0.42 * strength * (cb ? 1.5 : 1);
        tCol.set(cb ? [1, 1, 1, a, 1, 1, 1, a] : [0.86, 1, 0.45, a, 0.86, 1, 0.45, a], i * 8);
      }
      tGeo.attributes.position.needsUpdate = true; tGeo.attributes.color.needsUpdate = true;
    },
    marker(x, z, alpha) {
      marker.position.x = x; marker.position.z = z; marker.material.opacity = alpha;
      marker.material.color.setHex(Settings.cbSafe ? 0xffffff : 0xd6f04a);
      const sc = 1 + (1 - alpha) * 0.4; marker.scale.set(sc, sc, 1);
    },
    mark(x, z, vx, vz) { addBallMark(x, z, vx, vz, World.surface); },
    clearMarks() { clearBallMarks(); },
  };
})();
