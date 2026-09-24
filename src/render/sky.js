// Sky, sun, image-based lighting and time of day (day, golden hour, night under floodlights).
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { renderer, scene, Look, Perf } from './renderer.js';

const TOD = {
  day: {
    label: 'Day', elevation: 57, azimuth: 32, sky: { turbidity: 2.4, rayleigh: 1.25, mieCoefficient: 0.004, mieDirectionalG: 0.82, cloudCoverage: 0.32, cloudDensity: 0.5, cloudElevation: 0.55 },
    sun: 0xfff3e3, sunI: 3.0, hemiSky: 0xcfe3ff, hemiGround: 0x6d7a5c, hemiI: 0, env: 1, probe: 0.2, skySat: 0.3, envRing: [0.07, 0.075, 0.08], envGround: [0.06, 0.1, 0.08], fog: 0xc9d9e8, fogNear: 160, fogFar: 900,
    look: { exposure: 1.25, bloom: 0.16, bloomThreshold: 3.4, saturation: 1.0, contrast: 1.0, vignette: 0.2, gain: [1.0, 1.0, 1.0] },
  },
  golden: {
    label: 'Golden hour', elevation: 24, azimuth: -68, sky: { turbidity: 5.5, rayleigh: 2.6, mieCoefficient: 0.007, mieDirectionalG: 0.88, cloudCoverage: 0.42, cloudDensity: 0.55, cloudElevation: 0.5 },
    sun: 0xffc9a0, sunI: 3.2, hemiSky: 0xbfcbe8, hemiGround: 0x5a4a3c, hemiI: 0, env: 1, probe: 0.34, skySat: 0.5, envRing: [0.08, 0.065, 0.055], envGround: [0.07, 0.06, 0.045], fog: 0xe0b894, fogNear: 160, fogFar: 900,
    look: { exposure: 1.3, bloom: 0.22, bloomThreshold: 2.6, saturation: 1.04, contrast: 1.02, vignette: 0.24, gain: [1.03, 1.0, 0.96] },
  },
  night: {
    label: 'Night', elevation: 72, azimuth: 20, sky: null,
    sun: 0xeef2ff, sunI: 0.5, floods: 230, hemiSky: 0x33415c, hemiGround: 0x1b1f22, hemiI: 0.2, env: 0.35, envRing: [0.01, 0.012, 0.016], envGround: [0.02, 0.026, 0.03], fog: 0x05080d, fogNear: 60, fogFar: 300,
    look: { exposure: 1.1, bloom: 0.38, bloomThreshold: 2.6, saturation: 1.05, contrast: 1.06, vignette: 0.3, gain: [0.98, 1.0, 1.04] },
  },
};

export const Env = {
  tod: null, sky: null, sun: null, hemi: null, pmrem: null, envRT: null, night: null, floods: [], dir: new THREE.Vector3(),
  init() {
    this.sky = new Sky();
    this.sky.scale.setScalar(1200);
    this.sky.frustumCulled = false;
    scene.add(this.sky);
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.025;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6d7a5c, 0.35);
    scene.add(this.hemi);
    scene.fog = new THREE.Fog(0xc9d9e8, 160, 900);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.buildNight();
    Perf.onChange((p) => this.applyShadows(p));
    this.applyShadows(Perf.cfg());   // the first preset was applied before the sun existed
  },
  applyShadows(p) {
    const s = this.sun.shadow;
    if (s.mapSize.x !== p.shadow) { s.mapSize.set(p.shadow, p.shadow); if (s.map) { s.map.dispose(); s.map = null; } }
    s.radius = p.radius;
    s.blurSamples = 12;
  },
  // Fit the sun's shadow frustum to the court and run-off as seen from the sun. Only receivers need to be inside
  // it: anything between the sun and the court (the stands at golden hour) still lands in the map.
  fitShadow() {
    const cam = this.sun.shadow.camera, eye = new THREE.Object3D();
    eye.position.copy(this.sun.position); eye.lookAt(this.sun.target.position); eye.updateMatrixWorld();
    const inv = eye.matrixWorld.clone().invert(), v = new THREE.Vector3();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const x of [-12.5, 12.5]) for (const y of [0, 2.6]) for (const z of [-22.5, 22.5]) {
      v.set(x, y, z).applyMatrix4(inv);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    // Snap the extent to a coarse grid so the map doesn't shimmer if the frustum is ever refit.
    const q = (a) => Math.round(a * 2) / 2;
    Object.assign(cam, { left: q(x0 - 0.5), right: q(x1 + 0.5), bottom: q(y0 - 0.5), top: q(y1 + 0.5), near: 1, far: 220 });
    cam.updateProjectionMatrix();
  },
  // Stars, a dark dome and the floodlight banks used for the night session.
  buildNight() {
    const g = new THREE.Group();
    const domeGeo = new THREE.SphereGeometry(1100, 32, 16);
    const dome = new THREE.Mesh(domeGeo, new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 top = vec3(0.004, 0.008, 0.02), hor = vec3(0.035, 0.05, 0.08);
          vec3 c = mix(hor, top, pow(h, 0.5));
          c += vec3(0.05, 0.035, 0.02) * exp(-abs(vDir.y) * 18.0);   // city glow on the horizon
          gl_FragColor = vec4(c, 1.0);
        }`,
    }));
    g.add(dome);
    const n = 1400, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random(), v = Math.random() * 0.92 + 0.08, th = u * Math.PI * 2, ph = Math.acos(v);
      pos.set([Math.cos(th) * Math.sin(ph) * 1000, Math.cos(ph) * 1000, Math.sin(th) * Math.sin(ph) * 1000], i * 3);
      const b = 0.35 + Math.random() * 0.65, warm = Math.random();
      col.set([b * (0.85 + warm * 0.15), b * 0.9, b * (1.0 - warm * 0.15)], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.add(new THREE.Points(sg, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false })));
    g.visible = false;
    scene.add(g);
    this.night = g;
    // Four floodlight banks at the stadium corners do most of the night lighting: tight cones on the court, so
    // the light pools there and falls off into the stands. The overhead key light only adds soft shadows.
    for (const [x, z] of [[-24, -34], [24, -34], [-24, 34], [24, 34]]) {
      const s = new THREE.SpotLight(0xf2f5ff, 0, 140, 0.42, 0.75, 1.2);
      s.position.set(x, 30, z); s.target.position.set(x * 0.15, 0, z * 0.15);
      s.castShadow = false;
      scene.add(s, s.target);
      this.floods.push(s);
    }
  },
  setTimeOfDay(key) {
    const T = TOD[key] || TOD.day;
    if (this.tod === key) return;
    this.tod = key;
    const el = THREE.MathUtils.degToRad(T.elevation), az = THREE.MathUtils.degToRad(T.azimuth);
    this.dir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
    const night = key === 'night';
    this.sky.visible = !night;
    this.night.visible = night;
    if (!night) {
      const u = this.sky.material.uniforms;
      for (const [k, v] of Object.entries(T.sky)) if (u[k]) u[k].value = v;
      u.sunPosition.value.copy(this.dir);
    }
    this.sun.color.set(T.sun); this.sun.intensity = T.sunI;
    this.sun.position.copy(this.dir).multiplyScalar(80);
    this.sun.target.position.set(0, 0, 0);
    this.fitShadow();
    this.hemi.color.set(T.hemiSky); this.hemi.groundColor.set(T.hemiGround); this.hemi.intensity = T.hemiI; this.hemi.visible = T.hemiI > 0;
    // Lights left in the scene cost shader time even at zero intensity, so the floods are removed by day.
    for (const f of this.floods) { f.intensity = night ? T.floods : 0; f.visible = night; }
    scene.fog.color.set(T.fog); scene.fog.near = T.fogNear; scene.fog.far = T.fogFar;
    scene.environmentIntensity = T.env;
    this.buildEnvironment(T, night);
    Look.set(T.look);
    for (const fn of this.listeners) fn(key);
  },
  listeners: [],
  onChange(fn) { this.listeners.push(fn); },
  // Image-based lighting: render the sky, the stands and the ground into a prefiltered cube map. Everything in
  // the probe is in the same units as the sun light: sunlit white paint is about 0.8, so a clear sky gives the
  // court roughly a quarter of the sun's light (the Preetham sky is scaled down to match), and the stands and
  // court bounce a little back up.
  buildEnvironment(T, night) {
    const es = new THREE.Scene(), lin = (c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
    if (night) {
      es.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.MeshBasicMaterial({ color: 0x060a12, side: THREE.BackSide })));
      const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffffff).multiplyScalar(26) });
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + 0.3, m = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.2), lamp);
        m.position.set(Math.cos(a) * 34, 18, Math.sin(a) * 34); m.lookAt(0, 4, 0);
        es.add(m);
      }
    } else {
      const sky = new Sky();
      sky.scale.setScalar(40);
      const u = sky.material.uniforms, src = this.sky.material.uniforms;
      for (const k of Object.keys(u)) if (src[k]) u[k].value = src[k].value?.clone ? src[k].value.clone() : src[k].value;
      // No sun disc in the probe: the real sun is the shadowed directional light, and the disc's energy spread
      // through the prefiltered map would light every shadow from the same direction.
      u.showSunDisc.value = 0;
      // Scale and desaturate the sky for lighting: the Preetham model's blue is far purer than real skylight,
      // which haze, cloud and bounce light turn much whiter.
      u.uSkyScale = { value: T.probe }; u.uSkySat = { value: T.skySat };
      sky.material.fragmentShader = 'uniform float uSkyScale, uSkySat;\n' + sky.material.fragmentShader.replace('gl_FragColor = vec4( texColor, 1.0 );',
        'texColor = mix( vec3( dot( texColor, vec3( 0.2126, 0.7152, 0.0722 ) ) ), texColor, uSkySat ); gl_FragColor = vec4( texColor * uSkyScale, 1.0 );');
      es.add(sky);
    }
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 24, 48, 1, true), new THREE.MeshBasicMaterial({ color: lin(T.envRing), side: THREE.BackSide }));
    ring.position.y = 6;
    es.add(ring);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 32), new THREE.MeshBasicMaterial({ color: lin(T.envGround) }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -1;
    es.add(ground);
    const rt = this.pmrem.fromScene(es, 0.03, 0.1, 200);
    if (this.envRT) this.envRT.dispose();
    this.envRT = rt;
    scene.environment = rt.texture;
    es.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  },
  update(t) {
    if (this.sky.visible) this.sky.material.uniforms.time.value = t;
  },
};

export const TIMES = Object.fromEntries(Object.entries(TOD).map(([k, v]) => [k, v.label]));
