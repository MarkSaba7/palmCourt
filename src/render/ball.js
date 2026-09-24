// The ball: felt material with seams, real and contact shadows, a motion streak, and the bounce-spot marker.
import * as THREE from 'three';
import { clamp, BALL_R } from '../core.js';
import { scene, camera } from './renderer.js';
import { canvasTex } from './textures.js';
import { World, addBallMark, clearBallMarks } from './court.js';

const VISUAL_R = BALL_R * 1.55;   // drawn a little larger than life so it reads at a distance
const TRAIL = 14;

export const BallView = (() => {
  const felt = canvasTex(512, 256, (x, W, H) => {
    x.fillStyle = '#d7f04c'; x.fillRect(0, 0, W, H);
    const img = x.getImageData(0, 0, W, H), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 30; d[i] += n; d[i + 1] += n; d[i + 2] += n * 0.4; }
    x.putImageData(img, 0, 0);
    x.strokeStyle = 'rgba(248,250,236,0.95)'; x.lineWidth = 7; x.lineCap = 'round'; x.beginPath();
    for (let i = 0; i <= W; i += 2) { const y = H / 2 + Math.sin((i / W) * Math.PI * 4) * H * 0.3; i ? x.lineTo(i, y) : x.moveTo(i, y); }
    x.stroke();
  });
  const mat = new THREE.MeshPhysicalMaterial({
    map: felt, roughness: 0.78, sheen: 1, sheenColor: new THREE.Color(0xf1ffb0), sheenRoughness: 0.45,
    emissive: new THREE.Color(0x2c3a00), emissiveIntensity: 0.4,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(VISUAL_R, 28, 18), mat);
  mesh.castShadow = true;
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
  return {
    mesh,
    update(b, visible, dt) {
      mesh.visible = blob.visible = visible;
      if (!visible) { trail.visible = false; hist.length = 0; return; }
      mesh.position.set(b.p.x, b.p.y, b.p.z);
      mesh.rotation.x += b.w.x * dt * 0.25; mesh.rotation.z += b.w.z * dt * 0.25;
      const h = Math.max(0, b.p.y - BALL_R), sz = 0.12 + h * 0.035;
      blob.position.set(b.p.x, 0.009, b.p.z); blob.scale.set(sz, sz, 1);
      blob.material.opacity = clamp(0.62 - h * 0.35, 0, 0.62);
      hist.unshift(b.p.x, b.p.y, b.p.z);
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
      for (let i = 0; i < TRAIL; i++) {
        const j = Math.min(Math.round((i * (m - 1)) / (TRAIL - 1)), n - 1), k = Math.min(j + 1, n - 1), jm = Math.max(0, j - 1);
        tmp.set(hist[j * 3], hist[j * 3 + 1], hist[j * 3 + 2]);
        tan.set(hist[jm * 3] - hist[k * 3], hist[jm * 3 + 1] - hist[k * 3 + 1], hist[jm * 3 + 2] - hist[k * 3 + 2]);
        if (tan.lengthSq() < 1e-8) tan.set(1, 0, 0);
        view.subVectors(camera.position, tmp);
        side.crossVectors(tan, view).normalize();
        const f = 1 - i / (TRAIL - 1), w = VISUAL_R * (0.25 + 0.75 * f);
        tPos.set([tmp.x + side.x * w, tmp.y + side.y * w, tmp.z + side.z * w, tmp.x - side.x * w, tmp.y - side.y * w, tmp.z - side.z * w], i * 6);
        const a = f * f * 0.42 * strength;
        tCol.set([0.86, 1, 0.45, a, 0.86, 1, 0.45, a], i * 8);
      }
      tGeo.attributes.position.needsUpdate = true; tGeo.attributes.color.needsUpdate = true;
    },
    marker(x, z, alpha) {
      marker.position.x = x; marker.position.z = z; marker.material.opacity = alpha;
      const sc = 1 + (1 - alpha) * 0.4; marker.scale.set(sc, sc, 1);
    },
    mark(x, z, vx, vz) { addBallMark(x, z, vx, vz, World.surface); },
    clearMarks() { clearBallMarks(); },
  };
})();
