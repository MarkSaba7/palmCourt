// The stadium: a two-tier bowl with seats and spectators, LED boards, a roof ring with floodlights, big screens,
// officials and ball kids, corner palms and a city skyline beyond the roof.
import * as THREE from 'three';
import * as BGU from 'three/addons/utils/BufferGeometryUtils.js';
import { rand } from '../core.js';
import { scene, Perf } from './renderer.js';
import { canvasTex } from './textures.js';
import { Crowd } from './crowd.js';
import { Figure, STILL } from './avatar.js';
import { SKIN_TONES, HAIR_COLORS } from './character.js';

// Rounded-rectangle path around the court: straight sides keep their length as it grows, so rows line up.
function rrPath(hx, hz, rc) {
  const sx = hx - rc, sz = hz - rc, arc = Math.PI / 2;
  const L = [2 * sz, arc * rc, 2 * sx, arc * rc, 2 * sz, arc * rc, 2 * sx, arc * rc], tot = L.reduce((a, b) => a + b, 0);
  const cum = [0]; for (const l of L) cum.push(cum[cum.length - 1] + l / tot);
  return (d, u) => {
    u -= Math.floor(u);
    let k = 0; while (k < 7 && u > cum[k + 1]) k++;
    const t = (u - cum[k]) / (cum[k + 1] - cum[k]), r = rc + d;
    switch (k) {
      case 0: return { x: hx + d, z: -sz + 2 * sz * t, nx: 1, nz: 0 };
      case 1: { const a = arc * t; return { x: sx + r * Math.cos(a), z: sz + r * Math.sin(a), nx: Math.cos(a), nz: Math.sin(a) }; }
      case 2: return { x: sx - 2 * sx * t, z: hz + d, nx: 0, nz: 1 };
      case 3: { const a = arc * (1 + t); return { x: -sx + r * Math.cos(a), z: sz + r * Math.sin(a), nx: Math.cos(a), nz: Math.sin(a) }; }
      case 4: return { x: -hx - d, z: sz - 2 * sz * t, nx: -1, nz: 0 };
      case 5: { const a = arc * (2 + t); return { x: -sx + r * Math.cos(a), z: -sz + r * Math.sin(a), nx: Math.cos(a), nz: Math.sin(a) }; }
      case 6: return { x: -sx + 2 * sx * t, z: -hz - d, nx: 0, nz: -1 };
      default: { const a = arc * (3 + t); return { x: sx + r * Math.cos(a), z: -sz + r * Math.sin(a), nx: Math.cos(a), nz: Math.sin(a) }; }
    }
  };
}
const PATH = rrPath(14, 24, 4.5);     // front edge of the first row of seats
const SAMPLES = 280;

// Non-indexed geometry builder with flat quads.
class Quads {
  constructor() { this.p = []; this.n = []; this.uv = []; }
  quad(a, b, c, d, want, uvs) {
    const ab = new THREE.Vector3().subVectors(b, a), ac = new THREE.Vector3().subVectors(c, a), nrm = ab.cross(ac).normalize();
    const flip = want && nrm.dot(want) < 0;
    const order = flip ? [a, c, b, a, d, c] : [a, b, c, a, c, d];
    const nn = flip ? nrm.negate() : nrm;
    const uo = uvs ? (flip ? [uvs[0], uvs[2], uvs[1], uvs[0], uvs[3], uvs[2]] : [uvs[0], uvs[1], uvs[2], uvs[0], uvs[2], uvs[3]]) : null;
    order.forEach((v, i) => { this.p.push(v.x, v.y, v.z); this.n.push(nn.x, nn.y, nn.z); if (uo) this.uv.push(uo[i][0], uo[i][1]); else this.uv.push(0, 0); });
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    return g;
  }
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

// One tier of stepped rows. Returns the geometry and the seat spots.
function tier({ rows, d0, depth, rise, y0, fill, seatColor, base = 0 }) {
  const q = new Quads(), seats = [];
  for (let r = 0; r < rows; r++) {
    const din = d0 + r * depth, dout = din + depth, y = y0 + r * rise, y1 = r === 0 ? base : y - rise;
    for (let i = 0; i < SAMPLES; i++) {
      const u0 = i / SAMPLES, u1 = (i + 1) / SAMPLES, A = PATH(din, u0), Bq = PATH(din, u1), C = PATH(dout, u1), D = PATH(dout, u0);
      q.quad(V(A.x, y, A.z), V(Bq.x, y, Bq.z), V(C.x, y, C.z), V(D.x, y, D.z), UP);
      q.quad(V(A.x, Math.max(0, y1), A.z), V(Bq.x, Math.max(0, y1), Bq.z), V(Bq.x, y, Bq.z), V(A.x, y, A.z), V(-(A.nx + Bq.nx) / 2, 0, -(A.nz + Bq.nz) / 2));
    }
    // seats every 0.52 m along the row, with an aisle every 24 seats
    const pts = [];
    let acc = 0, prev = PATH(din + 0.42, 0);
    for (let k = 1; k <= 4000; k++) {
      const p = PATH(din + 0.42, k / 4000);
      acc += Math.hypot(p.x - prev.x, p.z - prev.z); prev = p;
      if (acc >= 0.52) { acc = 0; pts.push(p); }
    }
    pts.forEach((p, k) => {
      if (k % 26 === 24 || k % 26 === 25) return;
      seats.push({ x: p.x, y, z: p.z, ry: Math.atan2(p.nx, p.nz), fill, color: seatColor });
    });
  }
  return { geo: q.geometry(), seats };
}

// Vertical band along the path (walls, fascia, boards). uScale maps arc length to texture u.
function band(d, y0, y1, facing = -1) {
  const q = new Quads();
  let s = 0, prev = PATH(d, 0);
  for (let i = 0; i < SAMPLES * 2; i++) {
    const A = PATH(d, i / (SAMPLES * 2)), Bq = PATH(d, (i + 1) / (SAMPLES * 2));
    const len = Math.hypot(Bq.x - A.x, Bq.z - A.z);
    q.quad(V(A.x, y0, A.z), V(Bq.x, y0, Bq.z), V(Bq.x, y1, Bq.z), V(A.x, y1, A.z), V(facing * A.nx, 0, facing * A.nz), [[s, 0], [s + len, 0], [s + len, 1], [s, 1]]);
    s += len; prev = A;
  }
  return { geo: q.geometry(), length: s };
}
// Flat ring between two offsets at height y (floors, roof).
function ring(d0, d1, y0, y1, want = UP) {
  const q = new Quads();
  for (let i = 0; i < SAMPLES; i++) {
    const u0 = i / SAMPLES, u1 = (i + 1) / SAMPLES, A = PATH(d0, u0), Bq = PATH(d0, u1), C = PATH(d1, u1), D = PATH(d1, u0);
    q.quad(V(A.x, y0, A.z), V(Bq.x, y0, Bq.z), V(C.x, y1, C.z), V(D.x, y1, D.z), want);
  }
  return q.geometry();
}

const ADS = ['PALM COURT', 'OPTIC BALL CO.', 'SWING YOUR PHONE', 'BASELINE WATER', 'TOPSPIN AIR', 'DEUCE COFFEE', 'NETCORD', 'LOVE ALL', 'SLICE & DICE', 'SECOND SERVE SODA'];

export const Stadium = {
  ledTex: null, fasciaTex: null, board: null, boardTex: null, figures: [], kids: [], lights: [], windowsMat: null, lampMat: null,
  build() {
    const cfg = Perf.cfg();
    const g = new THREE.Group();
    const concrete = new THREE.MeshStandardMaterial({ color: 0x8d949a, roughness: 0.92 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b2229, roughness: 0.8 });
    // Floor around the court (walkways between boards and stands).
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(140, 160), new THREE.MeshStandardMaterial({ color: 0x2c3338, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.01; floor.receiveShadow = true;
    g.add(floor);
    // Lower and upper tiers.
    const lower = tier({ rows: 18, d0: 0, depth: 0.85, rise: 0.42, y0: 1.25, fill: 0.9, seatColor: 0x1d5a4b });
    const lowTop = 1.25 + 17 * 0.42, lowEnd = 18 * 0.85;
    const concD0 = lowEnd, concD1 = lowEnd + 2.6, fasciaH = 1.3;
    const upper = tier({ rows: 15, d0: concD1, depth: 0.82, rise: 0.56, y0: lowTop + fasciaH + 0.56, fill: 0.72, seatColor: 0x1f3553, base: lowTop + fasciaH });
    const upTop = lowTop + fasciaH + 0.56 + 14 * 0.56, upEnd = concD1 + 15 * 0.82;
    for (const t of [lower, upper]) { const m = new THREE.Mesh(t.geo, concrete); m.receiveShadow = true; m.castShadow = t === lower; g.add(m); }
    const conc = new THREE.Mesh(ring(concD0, concD1, lowTop, lowTop), concrete); conc.receiveShadow = true; g.add(conc);
    // Fascia (front of the upper tier) with a scrolling LED ribbon.
    this.fasciaTex = this.ledTexture(4096, 128, 0.7, true);
    const fas = band(concD1, lowTop, lowTop + fasciaH, -1);
    this.fasciaTex.repeat.set(fas.length / 64, 1);
    const fasMat = new THREE.MeshStandardMaterial({ color: 0x0a0d10, emissive: 0xffffff, emissiveMap: this.fasciaTex, emissiveIntensity: 0.9, roughness: 0.5 });
    g.add(new THREE.Mesh(fas.geo, fasMat));
    // Rail on top of the lower tier's back edge.
    const rail = new THREE.Mesh(band(concD0 - 0.02, lowTop, lowTop + 0.9, -1).geo, new THREE.MeshStandardMaterial({ color: 0x9fb3c2, roughness: 0.2, metalness: 0.2, transparent: true, opacity: 0.35 }));
    g.add(rail);
    // Back wall and roof ring with floodlights along its inner edge.
    const back = new THREE.Mesh(band(upEnd, upTop - 0.6, upTop + 4.2, -1).geo, dark); g.add(back);
    const roofY = upTop + 4.2, roofIn = concD1 + 3.5;
    const roofUnder = new THREE.Mesh(ring(roofIn, upEnd + 0.6, roofY - 0.2, roofY + 0.6, V(0, -1, 0)), new THREE.MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.8, side: THREE.DoubleSide }));
    roofUnder.receiveShadow = true;
    g.add(roofUnder);
    const beam = new THREE.Mesh(band(roofIn, roofY - 1.1, roofY - 0.2, -1).geo, new THREE.MeshStandardMaterial({ color: 0x3a444d, roughness: 0.5, metalness: 0.4 }));
    g.add(beam);
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6e8, emissiveIntensity: 0.2, roughness: 0.3 });
    const lampGeo = new THREE.BoxGeometry(2.4, 0.5, 0.25), lamps = [];
    for (let i = 0; i < 44; i++) {
      const p = PATH(roofIn - 0.2, i / 44);
      const m = new THREE.Matrix4().compose(V(p.x, roofY - 1.35, p.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5, Math.atan2(p.nx, p.nz), 0, 'YXZ')), V(1, 1, 1));
      lamps.push(lampGeo.clone().applyMatrix4(m));
    }
    g.add(new THREE.Mesh(BGU.mergeGeometries(lamps), this.lampMat));
    // Seats (instanced) under the crowd.
    const seats = [...lower.seats, ...upper.seats];
    const seatGeo = BGU.mergeGeometries([new THREE.BoxGeometry(0.44, 0.05, 0.38).translate(0, 0.02, -0.08), new THREE.BoxGeometry(0.44, 0.4, 0.05).translate(0, 0.22, 0.12)]);
    const seatMesh = new THREE.InstancedMesh(seatGeo, new THREE.MeshStandardMaterial({ roughness: 0.45 }), seats.length);
    const m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), c = new THREE.Color();
    seats.forEach((st, i) => {
      m4.compose(V(st.x, st.y, st.z), qq.setFromAxisAngle(UP, st.ry), V(1, 1, 1));
      seatMesh.setMatrixAt(i, m4);
      seatMesh.setColorAt(i, c.set(st.color).offsetHSL(0, 0, (Math.random() - 0.5) * 0.04));
    });
    seatMesh.receiveShadow = true;
    g.add(seatMesh);
    Crowd.build(seats, cfg.crowd);
    // Courtside LED boards.
    this.ledTex = this.ledTexture(4096, 128, 1, false);
    const boards = new THREE.Group();
    const bPath = rrPath(12.3, 22.3, 2.2);
    const bq = new Quads();
    let s = 0;
    for (let i = 0; i < SAMPLES * 2; i++) {
      const A = bPath(0, i / (SAMPLES * 2)), Bq = bPath(0, (i + 1) / (SAMPLES * 2)), len = Math.hypot(Bq.x - A.x, Bq.z - A.z);
      bq.quad(V(A.x, 0, A.z), V(Bq.x, 0, Bq.z), V(Bq.x, 0.95, Bq.z), V(A.x, 0.95, A.z), V(-A.nx, 0, -A.nz), [[s / 12, 0], [(s + len) / 12, 0], [(s + len) / 12, 1], [s / 12, 1]]);
      s += len;
    }
    const ledMat = new THREE.MeshStandardMaterial({ color: 0x06080a, emissive: 0xffffff, emissiveMap: this.ledTex, emissiveIntensity: 1.0, roughness: 0.35 });
    boards.add(new THREE.Mesh(bq.geometry(), ledMat));
    g.add(boards);
    this.buildCourtside(g);
    this.buildScreens(g, roofIn, roofY);
    this.buildFlags(g, upEnd + 0.3, roofY + 0.6);
    this.buildPalms(g);
    this.buildSkyline(g);
    scene.add(g);
    this.group = g;
  },
  ledTexture(w, h, alpha, fascia) {
    return canvasTex(w, h, (x, W, H) => {
      x.fillStyle = '#05080b'; x.fillRect(0, 0, W, H);
      const n = fascia ? 8 : 6, cell = W / n;
      for (let i = 0; i < n; i++) {
        const ad = ADS[(i * 3 + (fascia ? 1 : 0)) % ADS.length];
        const hue = [74, 190, 8, 45, 140, 330][i % 6];
        x.fillStyle = i % 2 ? `hsl(${hue} 70% 14%)` : '#07121c';
        x.fillRect(i * cell, 0, cell, H);
        x.fillStyle = i % 3 === 0 ? '#d6f04a' : '#f2f5ee';
        x.font = `900 ${Math.round(H * 0.62)}px "Big Shoulders Display", Impact, sans-serif`;
        x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillText(ad, i * cell + cell / 2, H * 0.54);
      }
      // LED pixel grid
      x.fillStyle = 'rgba(0,0,0,0.35)';
      for (let yy = 0; yy < H; yy += 4) x.fillRect(0, yy, W, 1);
    }, { repeat: true });
  },
  buildCourtside(g) {
    const navy = { shirt: 0x1f2a44, pants: 0xc8b88a, shoe: 0x2a2a2a, headband: false, wristband: false, sleeve: 0.2, hair: 'short' };
    const who = (extra) => ({ ...navy, skin: SKIN_TONES[(Math.random() * SKIN_TONES.length) | 0], hairColor: HAIR_COLORS[(Math.random() * 4) | 0], ...extra });
    const wood = new THREE.MeshStandardMaterial({ color: 0x1d4a3e, roughness: 0.6 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xc7ced4, roughness: 0.35, metalness: 0.7 });
    // Umpire's chair on the west side of the net.
    const chair = new THREE.Group();
    for (const [dx, dz] of [[-0.35, -0.35], [0.35, -0.35], [-0.35, 0.35], [0.35, 0.35]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 1.95, 10), steel); leg.position.set(dx, 0.975, dz); leg.castShadow = true; chair.add(leg);
    }
    for (let i = 1; i <= 5; i++) { const rung = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.03, 0.05), steel); rung.position.set(0, i * 0.34, -0.36); chair.add(rung); }
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 1.0), wood); deck.position.y = 1.97; deck.castShadow = true; chair.add(deck);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.06, 0.5), wood); seat.position.set(0, 2.45, 0.05); chair.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.05), wood); back.position.set(0, 2.72, 0.28); chair.add(back);
    const front = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.05), wood); front.position.set(0, 2.25, -0.48); chair.add(front);
    const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 8), steel); legs.position.set(0, 2.2, 0.05); chair.add(legs);
    chair.position.set(-7.6, 0, 0); chair.rotation.y = -Math.PI / 2;
    g.add(chair);
    this.figures.push(new Figure(who({ height: 0.98 }), STILL.sit(2.45), -7.6, 0.03, -Math.PI / 2));
    // Player benches either side of the chair.
    for (const s of [-1, 1]) {
      const b = new THREE.Group();
      const bSeat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.5), new THREE.MeshStandardMaterial({ color: 0x0f2230, roughness: 0.6 })); bSeat.position.y = 0.46; b.add(bSeat);
      const bBack = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.05), bSeat.material); bBack.position.set(0, 0.75, 0.24); b.add(bBack);
      for (const [dx, dz] of [[-0.22, -0.22], [0.22, -0.22], [-0.22, 0.22], [0.22, 0.22]]) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.46, 6), steel); l.position.set(dx, 0.23, dz); b.add(l); }
      const towel = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.04, 0.28), new THREE.MeshStandardMaterial({ color: s > 0 ? 0xf2f5ee : 0xd6f04a, roughness: 0.95 })); towel.position.set(0, 0.8, 0.2); towel.rotation.x = -0.3; b.add(towel);
      const bag = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.3, 0.32), new THREE.MeshStandardMaterial({ color: s > 0 ? 0x1f3b5c : 0xc9443a, roughness: 0.7 })); bag.position.set(0.75, 0.15, 0); b.add(bag);
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.24, 10), new THREE.MeshStandardMaterial({ color: 0x9fd4ff, roughness: 0.1, transparent: true, opacity: 0.7 })); bottle.position.set(-0.4, 0.12, -0.1); b.add(bottle);
      b.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      b.position.set(-9.4, 0, s * 2.4); b.rotation.y = -Math.PI / 2;
      g.add(b);
    }
    // Line judges on chairs, facing their lines.
    const lj = [[-4.6, 21.5, 0], [4.6, -21.5, Math.PI], [11.2, 11.4, Math.PI / 2], [-11.2, -11.4, -Math.PI / 2], [11.2, -6.4, Math.PI / 2], [-11.2, 6.4, -Math.PI / 2]];
    for (const [x, z, ry] of lj) {
      const ch = new THREE.Group();
      const cs = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.05, 0.44), new THREE.MeshStandardMaterial({ color: 0x14202b, roughness: 0.6 })); cs.position.y = 0.46; ch.add(cs);
      for (const [dx, dz] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.46, 6), steel); l.position.set(dx, 0.23, dz); ch.add(l); }
      ch.position.set(x, 0, z); ch.rotation.y = ry; ch.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      g.add(ch);
      this.figures.push(new Figure(who({ shirt: 0x223454, pants: 0x223454 }), STILL.sit(0.47), x, z, ry));
    }
    // Ball kids: crouched by the net posts, standing at the back corners.
    const kid = () => ({ shirt: 0xd6f04a, pants: 0x1c1f24, shoe: 0xf4f4f0, headband: false, wristband: false, height: 0.84, sleeve: 0.18, skin: SKIN_TONES[(Math.random() * SKIN_TONES.length) | 0], hair: Math.random() < 0.4 ? 'ponytail' : 'short', hairColor: HAIR_COLORS[(Math.random() * 5) | 0] });
    // They fetch balls between points (see ballkids.js), so each remembers its spot and resting pose.
    this.kids = [];
    const addKid = (pose, x, z, ry) => { const f = new Figure(kid(), pose, x, z, ry); this.figures.push(f); this.kids.push({ fig: f, x, z, ry, rest: pose }); };
    for (const [x, z, ry] of [[7.0, 0.9, Math.PI / 2], [-7.0, -1.1, -Math.PI / 2]]) addKid(STILL.crouch(), x, z, ry);
    for (const [x, z, ry] of [[9.2, 21.2, 0.41], [-9.2, 21.2, -0.41], [9.2, -21.2, Math.PI - 0.41], [-9.2, -21.2, -(Math.PI - 0.41)]]) addKid(STILL.wait(), x, z, ry);
  },
  buildScreens(g, roofIn, roofY) {
    this.boardTex = canvasTex(1024, 512, (x, W, H) => { x.fillStyle = '#05080b'; x.fillRect(0, 0, W, H); });
    const screenMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: this.boardTex, emissiveIntensity: 1.0, roughness: 0.4 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x1b2229, roughness: 0.6, metalness: 0.3 });
    for (const u of [0.125, 0.625]) {
      const p = PATH(roofIn + 1.5, u);
      const scr = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(10.4, 5.9, 0.5), frameMat); scr.add(frame);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(10, 5.5), screenMat); face.position.z = -0.26; face.rotation.y = Math.PI; scr.add(face);
      scr.position.set(p.x, roofY - 5.2, p.z);
      scr.lookAt(0, roofY - 9, 0);
      scr.rotateY(Math.PI);
      g.add(scr);
    }
    this.updateBoard({ names: ['', ''], games: [0, 0], points: ['', ''], server: 0, note: 'PALM COURT' });
  },
  // Big-screen scoreboard, redrawn when the score changes.
  updateBoard({ names, games, points, server, note }) {
    const c = this.boardTex.image, x = c.getContext('2d'), W = c.width, H = c.height;
    x.fillStyle = '#05080b'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#0c1826'; x.fillRect(24, 24, W - 48, H - 48);
    x.fillStyle = '#d6f04a'; x.fillRect(24, 24, W - 48, 70);
    x.fillStyle = '#1b2300'; x.font = '900 52px "Big Shoulders Display", Impact, sans-serif'; x.textBaseline = 'middle'; x.textAlign = 'left';
    x.fillText(note || 'PALM COURT', 50, 61);
    for (let i = 0; i < 2; i++) {
      const y = 170 + i * 150;
      x.fillStyle = server === i ? '#d6f04a' : 'rgba(0,0,0,0)';
      x.beginPath(); x.arc(70, y, 13, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#f2f5ee'; x.font = '900 88px "Big Shoulders Display", Impact, sans-serif'; x.textAlign = 'left';
      x.fillText(String(names[i] || '').toUpperCase().slice(0, 12), 100, y + 4);
      x.textAlign = 'center';
      x.fillStyle = '#13263a'; x.fillRect(W - 330, y - 58, 120, 116);
      x.fillStyle = '#f2f5ee'; x.fillText(String(games[i] ?? 0), W - 270, y + 4);
      x.fillStyle = '#d6f04a'; x.fillRect(W - 190, y - 58, 140, 116);
      x.fillStyle = '#1b2300'; x.fillText(String(points[i] ?? ''), W - 120, y + 4);
    }
    x.fillStyle = 'rgba(0,0,0,0.3)';
    for (let yy = 0; yy < H; yy += 3) x.fillRect(0, yy, W, 1);
    this.boardTex.needsUpdate = true;
  },
  // Palms: fronds are arched, V-folded blades cut into leaflets by an alpha texture (their shadows too), on a
  // tapered, ringed trunk with a fibrous boot under the crown.
  // Flags on poles around the roof's outer rim, rippling in the breeze (the cloth moves in the vertex shader).
  buildFlags(g, d, y) {
    const designs = [['#c9443a', '#f2f5ee', '#1f3b5c', 'h'], ['#1f7a4f', '#f2f5ee', '#d9794a', 'v'], ['#1d2b44', '#d6f04a', '#1d2b44', 'h'],
      ['#f2c14e', '#1d2b44', '#f2c14e', 'v'], ['#2f6fb3', '#f2f5ee', '#2f6fb3', 'h'], ['#d6f04a', '#09131d', '#d6f04a', 'v']];
    const cloth = new THREE.PlaneGeometry(2.4, 1.5, 12, 6); cloth.translate(1.2, 0, 0);   // hoisted at its left edge
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xc7ced4, roughness: 0.35, metalness: 0.7 });
    this.flagTime = { value: 0 };
    const n = 12;
    for (let i = 0; i < n; i++) {
      const [c1, c2, c3, dir] = designs[i % designs.length];
      const tex = canvasTex(96, 64, (x, W, H) => {
        const cols = [c1, c2, c3];
        for (let k = 0; k < 3; k++) { x.fillStyle = cols[k]; if (dir === 'h') x.fillRect(0, (k * H) / 3, W, H / 3 + 1); else x.fillRect((k * W) / 3, 0, W / 3 + 1, H); }
      });
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, side: THREE.DoubleSide });
      const phase = i * 1.7;
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = this.flagTime; sh.uniforms.uPhase = { value: phase };
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime, uPhase;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            float fx = position.x / 2.4;   // 0 at the pole, 1 at the fly end
            float w = uTime * 5.2 + uPhase - fx * 5.5;   // one shared program, a phase per flag
            transformed.z += fx * (0.22 * sin(w) + 0.06 * sin(w * 2.3 + position.y * 3.0));
            transformed.y -= fx * fx * 0.12;`);
      };
      const p = PATH(d, (i + 0.5) / n);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 4.2, 8), poleMat); pole.position.set(p.x, y + 2.1, p.z);
      const flag = new THREE.Mesh(cloth, mat); flag.position.set(p.x, y + 3.45, p.z);
      flag.rotation.y = Math.atan2(p.nx, p.nz) + Math.PI / 2 + 0.6;   // all streaming the same way, roughly downwind
      flag.castShadow = false;
      g.add(pole, flag);
    }
  },
  buildPalms(g) {
    const leaf = canvasTex(256, 1024, (x, W, H) => {
      x.clearRect(0, 0, W, H);
      const mid = W / 2;
      for (let yy = 40; yy < H - 20; yy += 9) {
        const t = yy / H, len = W * 0.48 * Math.sin(Math.min(1, t * 1.15) * Math.PI) ** 0.7, droop = 34 + t * 40;
        const shade = 70 + Math.random() * 40;
        x.strokeStyle = `rgb(${shade * 0.45 | 0},${shade | 0},${shade * 0.35 | 0})`;
        x.lineWidth = 7 - t * 3; x.lineCap = 'round';
        for (const s of [-1, 1]) { x.beginPath(); x.moveTo(mid, yy); x.quadraticCurveTo(mid + s * len * 0.5, yy + droop * 0.2, mid + s * len, yy + droop); x.stroke(); }
      }
      x.strokeStyle = '#7d8a3a'; x.lineWidth = 8; x.beginPath(); x.moveTo(mid, 0); x.lineTo(mid, H); x.stroke();   // midrib
    });
    const frondMat = new THREE.MeshStandardMaterial({ map: leaf, alphaTest: 0.45, roughness: 0.8, side: THREE.DoubleSide });
    const frondDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: leaf, alphaTest: 0.45 });
    const ringTex = canvasTex(64, 64, (x, W, H) => {   // tube u runs along the trunk, so rings are columns here
      x.fillStyle = '#86694b'; x.fillRect(0, 0, W, H);
      for (let xx = 0; xx < W; xx += 8) { x.fillStyle = `rgba(40,28,18,${0.35 + Math.random() * 0.25})`; x.fillRect(xx, 0, 2 + Math.random() * 2, H); }
    }, { repeat: true });
    ringTex.repeat.set(6, 1);
    const trunkMat = new THREE.MeshStandardMaterial({ map: ringTex, roughness: 1 });
    const bootMat = new THREE.MeshStandardMaterial({ color: 0x5f4a33, roughness: 1 });
    const potMat = new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.8 });
    const frondGeo = new THREE.PlaneGeometry(1.7, 4.2, 4, 14);
    frondGeo.translate(0, 2.1, 0);
    {   // arch the blade and fold it into a shallow V along the midrib
      const p = frondGeo.attributes.position;
      for (let i = 0; i < p.count; i++) { const y = p.getY(i), xx = p.getX(i); p.setZ(i, 0.1 * y * y + Math.abs(xx) * 0.35); }
      frondGeo.computeVertexNormals();
    }
    for (const [x, z] of [[13.2, 23.2], [-13.2, 23.2], [13.2, -23.2], [-13.2, -23.2]]) {
      const palm = new THREE.Group(), h = rand(8.5, 10.5);
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.6, 0.8, 16), potMat); pot.position.y = 0.4; palm.add(pot);
      const segs = 12, pts = [];
      for (let i = 0; i <= segs; i++) pts.push(V(Math.sin(i / segs * 1.4) * 0.35 * (x > 0 ? 1 : -1), i / segs * h, 0));
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.2, 12, false);
      {   // taper: wide at the base, slimmer under the crown
        const p = tube.attributes.position, curve = new THREE.CatmullRomCurve3(pts), c = V(0, 0, 0);
        for (let i = 0; i < p.count; i++) {
          const t = Math.min(1, Math.max(0, p.getY(i) / h)); curve.getPoint(t, c);
          const k = 1.35 - 0.5 * t;
          p.setXYZ(i, c.x + (p.getX(i) - c.x) * k, p.getY(i), c.z + (p.getZ(i) - c.z) * k);
        }
        tube.computeVertexNormals();
      }
      const trunk = new THREE.Mesh(tube, trunkMat);
      trunk.castShadow = true; palm.add(trunk);
      const crown = new THREE.Group(); crown.position.copy(pts[segs]);
      const boot = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 8), bootMat); boot.scale.set(1, 1.5, 1); boot.position.y = -0.25; crown.add(boot);
      const n = 14;
      for (let i = 0; i < n; i++) {
        const f = new THREE.Mesh(frondGeo, frondMat);
        const young = i % 5 === 0;   // a few newer fronds stand up
        const s = young ? rand(0.6, 0.8) : rand(0.85, 1.05);
        f.scale.set(young ? s * 0.45 : s, s, s);   // new fronds are still folded, so narrow
        f.rotation.set(young ? rand(0.35, 0.6) : rand(0.95, 1.5), (i / n) * Math.PI * 2 + rand(-0.15, 0.15), rand(-0.12, 0.12), 'YXZ');
        f.castShadow = true; f.customDepthMaterial = frondDepth;
        crown.add(f);
      }
      palm.add(crown);
      palm.position.set(x, 0, z); palm.rotation.y = rand(0, 6.28);
      g.add(palm);
    }
  },
  // The city beyond the stadium: towers with floors and window grids at real scale (a texture tile is 12 m wide and
  // six 4 m floors tall), glossy glass that picks up the sky, varied facade tints, and lit windows at night that
  // line up with the daytime ones.
  buildSkyline(g) {
    const TW = 128, TH = 256, FLOORS = 6, COLS = 8, fh = TH / FLOORS;
    const cells = [];
    for (let f = 0; f < FLOORS; f++) for (let c = 0; c < COLS; c++) cells.push([c * 16 + 2, f * fh + 7, 12, fh - 12]);
    const facade = canvasTex(TW, TH, (x) => {
      x.fillStyle = '#9aa1a8'; x.fillRect(0, 0, TW, TH);
      for (const [cx, cy, cw, ch] of cells) { const v = 55 + Math.random() * 35; x.fillStyle = `rgb(${v * 0.55 | 0},${v * 0.72 | 0},${v | 0})`; x.fillRect(cx, cy, cw, ch); }
    }, { repeat: true });
    const rough = canvasTex(TW, TH, (x) => {
      x.fillStyle = '#d0d0d0'; x.fillRect(0, 0, TW, TH);
      x.fillStyle = '#2e2e2e'; for (const [cx, cy, cw, ch] of cells) x.fillRect(cx, cy, cw, ch);
    }, { repeat: true, srgb: false });
    const glow = canvasTex(TW, TH, (x) => {
      x.fillStyle = '#000'; x.fillRect(0, 0, TW, TH);
      for (const [cx, cy, cw, ch] of cells) if (Math.random() < 0.42) {
        x.globalAlpha = 0.45 + Math.random() * 0.55;
        x.fillStyle = `rgb(255,${200 + Math.random() * 40 | 0},${140 + Math.random() * 60 | 0})`; x.fillRect(cx, cy, cw, ch);
      }
    }, { repeat: true });
    const tints = [0xb8c4cf, 0xd8d2c4, 0x9fb0bf, 0xe6e6e2, 0x8f9ba6, 0xc9bca6, 0xa9b8c2];
    const boxes = [], c = new THREE.Color();
    for (let i = 0; i < 90; i++) {
      const a = rand(0, Math.PI * 2), r = rand(320, 620), h = rand(30, 160) * (Math.random() < 0.15 ? 1.8 : 1), w = rand(18, 45);
      const geo = new THREE.BoxGeometry(w, h, rand(18, 40)).translate(Math.cos(a) * r, h / 2 - 2, Math.sin(a) * r);
      const pos = geo.attributes.position, nrm = geo.attributes.normal, uv = geo.attributes.uv, col = new Float32Array(pos.count * 3);
      const du = rand(0, 1);   // stagger each building's window grid
      c.set(tints[(Math.random() * tints.length) | 0]);
      for (let k = 0; k < pos.count; k++) {
        if (Math.abs(nrm.getY(k)) > 0.5) uv.setXY(k, 0.005, 0.005);   // roofs: plain frame colour
        else uv.setXY(k, (Math.abs(nrm.getX(k)) > 0.5 ? pos.getZ(k) : pos.getX(k)) / 12 + du, (pos.getY(k) + 2) / 24);
        col.set([c.r, c.g, c.b], k * 3);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      boxes.push(geo);
    }
    this.windowsMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: facade, roughnessMap: rough, roughness: 1, metalness: 0.2, emissive: 0xffffff, emissiveMap: glow, emissiveIntensity: 0 });
    const city = new THREE.Mesh(BGU.mergeGeometries(boxes), this.windowsMat);
    city.userData.noAO = true;
    g.add(city);
  },
  // Night: bright floodlights and lit windows; day: soft glow only.
  setTimeOfDay(tod) {
    const night = tod === 'night';
    if (this.lampMat) this.lampMat.emissiveIntensity = night ? 12 : 0.4;
    if (this.windowsMat) this.windowsMat.emissiveIntensity = night ? 0.9 : 0;
  },
  update(t, ball) {
    if (this.flagTime) this.flagTime.value = t;
    if (this.ledTex) this.ledTex.offset.x = (t * 0.02) % 1;
    if (this.fasciaTex) this.fasciaTex.offset.x = (-t * 0.012) % 1;
    for (const f of this.figures) { f.lookTarget = ball; f.update(1 / 60); }
  },
};
