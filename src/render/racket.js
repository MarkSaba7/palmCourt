// Tennis racket: 27 inch frame with a real beam, throat, octagonal grip, see-through strings and a dampener.
// Built along local -y from the butt cap (y = +0.075) so it can hang off a hand bone.
import * as THREE from 'three';
import { canvasTex } from './textures.js';

let stringTex = null, gripTex = null;
function textures() {
  if (stringTex) return;
  stringTex = canvasTex(256, 320, (x, W, H) => {
    x.clearRect(0, 0, W, H);
    x.strokeStyle = 'rgba(255,255,255,1)'; x.lineWidth = 2.4;
    for (let i = 0; i < 16; i++) { const px = ((i + 0.5) / 16) * W; x.beginPath(); x.moveTo(px, 0); x.lineTo(px, H); x.stroke(); }
    for (let j = 0; j < 19; j++) { const py = ((j + 0.5) / 19) * H; x.beginPath(); x.moveTo(0, py); x.lineTo(W, py); x.stroke(); }
  }, { srgb: false });
  gripTex = canvasTex(64, 256, (x, W, H) => {
    x.fillStyle = '#f2f2ec'; x.fillRect(0, 0, W, H);
    x.strokeStyle = 'rgba(0,0,0,0.18)'; x.lineWidth = 3;
    for (let y = -W; y < H + W; y += 18) { x.beginPath(); x.moveTo(0, y); x.lineTo(W, y + W * 0.6); x.stroke(); }
  });
}

export function makeRacket({ frame = 0x1b2026, accent = 0xd6f04a, strings = 0xf4f2e6, grip = null } = {}) {
  textures();
  const g = new THREE.Group();
  const frameMat = new THREE.MeshPhysicalMaterial({ color: frame, roughness: 0.32, metalness: 0.1, clearcoat: 0.8, clearcoatRoughness: 0.25 });
  const accentMat = new THREE.MeshPhysicalMaterial({ color: accent, roughness: 0.35, clearcoat: 0.6 });
  const HEAD_Y = -0.46, RX = 0.124, RY = 0.162;
  // Frame hoop: an ellipse swept with a deep, narrow beam.
  const hoopPts = [];
  for (let i = 0; i < 64; i++) { const a = (i / 64) * Math.PI * 2; hoopPts.push(new THREE.Vector3(Math.cos(a) * RX, HEAD_Y + Math.sin(a) * RY, 0)); }
  const hoopGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(hoopPts, true), 96, 0.0095, 8, true);
  hoopGeo.scale(1, 1, 1.9);
  const hoop = new THREE.Mesh(hoopGeo, frameMat); hoop.castShadow = true;
  g.add(hoop);
  // Accent stripe on the outer top of the hoop.
  const stripePts = [];
  for (let i = 0; i <= 24; i++) { const a = Math.PI * (0.18 + 0.64 * (i / 24)); stripePts.push(new THREE.Vector3(Math.cos(a) * (RX + 0.006), HEAD_Y + Math.sin(a) * (RY + 0.006), 0)); }
  const stripe = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(stripePts), 40, 0.0055, 6, false), accentMat);
  stripe.geometry.scale(1, 1, 2.2);
  g.add(stripe);
  // Throat: two arms from the shaft into the bottom of the hoop, and a bridge.
  for (const s of [-1, 1]) {
    const pts = [new THREE.Vector3(s * 0.012, -0.205, 0), new THREE.Vector3(s * 0.04, -0.25, 0), new THREE.Vector3(s * 0.078, HEAD_Y + RY * -0.78 + 0.0, 0)];
    const arm = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.0085, 8, false), frameMat);
    arm.geometry.scale(1, 1, 1.8); arm.castShadow = true;
    g.add(arm);
  }
  const bridgePts = [];
  for (let i = 0; i <= 12; i++) { const a = -Math.PI / 2 + (i / 12 - 0.5) * 0.9; bridgePts.push(new THREE.Vector3(Math.cos(a) * RX * 0.93, HEAD_Y + Math.sin(a) * RY * 0.93, 0)); }
  const bridge = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(bridgePts), 14, 0.0075, 6, false), frameMat);
  bridge.geometry.scale(1, 1, 1.6);
  g.add(bridge);
  // Shaft and octagonal handle with grip tape.
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0115, 0.0135, 0.06, 8), frameMat);
  shaft.position.y = -0.18;
  g.add(shaft);
  const gripMat = grip ? new THREE.MeshStandardMaterial({ color: grip, roughness: 0.9 }) : new THREE.MeshStandardMaterial({ map: gripTex, roughness: 0.9 });
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.0165, 0.0165, 0.235, 8), gripMat);
  handle.position.y = -0.04; handle.castShadow = true;
  g.add(handle);
  const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.0185, 0.0175, 0.018, 8), accentMat);
  butt.position.y = 0.083;
  g.add(butt);
  // Strings: an alpha-mapped disc inside the hoop.
  const strGeo = new THREE.CircleGeometry(1, 40);
  strGeo.scale(RX * 0.97, RY * 0.97, 1);
  const strMat = new THREE.MeshStandardMaterial({ color: strings, roughness: 0.6, alphaMap: stringTex, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide });
  const str = new THREE.Mesh(strGeo, strMat);
  str.position.y = HEAD_Y;
  g.add(str);
  const damp = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.014, 0.012), accentMat);
  damp.position.set(0, HEAD_Y - RY * 0.84, 0);
  g.add(damp);
  g.userData.headCenter = new THREE.Vector3(0, HEAD_Y, 0);
  return g;
}
