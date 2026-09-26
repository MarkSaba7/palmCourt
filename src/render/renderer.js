// Renderer, scene, camera, post-processing and graphics quality.
import * as THREE from 'three';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { Settings } from '../core.js';

export const canvas = document.getElementById('gl');
// Last usable window size. A hidden or minimised window can report 0x0, which would leave every render target
// with zero-size attachments (a blank frame and a flood of GL errors), so those readings are ignored.
const view = { w: Math.max(1, innerWidth), h: Math.max(1, innerHeight) };
function readView() {
  if (innerWidth > 0 && innerHeight > 0) { view.w = innerWidth; view.h = innerHeight; return true; }
  return false;
}
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, stencil: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(view.w, view.h, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;   // keeps paint, kit and sponsor colours true, rolls off highlights
renderer.toneMappingExposure = 1.0;

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(48, view.w / view.h, 0.25, 1400);
camera.position.set(0, 12, 34);
camera.lookAt(0, 0, 0);

const VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

// Final look, in one pass: bloom and glare added in HDR, exposure, Neutral tone mapping, sRGB, then gentle
// contrast, saturation, lift/gain, vignette and a touch of grain (which also hides sky banding).
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null }, tBloom: { value: null }, tGlare: { value: null }, uBloom: { value: 0 }, uGlare: { value: 0 }, uGlareTint: { value: new THREE.Vector3(1, 1, 1) },
    uExposure: { value: 1 }, uTime: { value: 0 }, uVignette: { value: 0.22 }, uSaturation: { value: 1.06 }, uContrast: { value: 1.04 },
    uLift: { value: new THREE.Vector3(0, 0, 0) }, uGain: { value: new THREE.Vector3(1, 1, 1) }, uGrain: { value: 0.018 }, uAspect: { value: 16 / 9 },
  },
  vertexShader: VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse, tBloom, tGlare; uniform float uBloom, uGlare, uExposure, uTime, uVignette, uSaturation, uContrast, uGrain, uAspect;
    uniform vec3 uLift, uGain, uGlareTint;
    varying vec2 vUv;
    float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
    vec3 neutral(vec3 c) {   // Khronos PBR Neutral, as three's NeutralToneMapping
      float x = min(c.r, min(c.g, c.b)), off = x < 0.08 ? x - 6.25 * x * x : 0.04;
      c -= off;
      float peak = max(c.r, max(c.g, c.b));
      if (peak < 0.76) return c;
      float d = 0.24, np = 1.0 - d * d / (peak + d - 0.76);
      c *= np / peak;
      return mix(c, vec3(np), 1.0 - 1.0 / (0.15 * (peak - np) + 1.0));
    }
    vec3 srgb(vec3 c) { return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308)))); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      #ifdef BLOOM
      c += texture2D(tBloom, vUv).rgb * uBloom;
      #ifdef GLARE
      c += texture2D(tGlare, vUv).rgb * uGlare * uGlareTint;
      #endif
      #endif
      c = srgb(clamp(neutral(max(c, 0.0) * uExposure), 0.0, 1.0));
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      c = (c - 0.5) * uContrast + 0.5;
      c = c * uGain + uLift;
      vec2 d = (vUv - 0.5) * vec2(uAspect / 1.55, 1.0);
      c *= mix(1.0 - uVignette, 1.0, smoothstep(0.78, 0.2, length(d)));
      c += (hash(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) * uGrain;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

// Bloom: a dual-filter down/up chain from half resolution. The first step weights samples by 1/(1+luma) (no
// flickering fireflies from sparkling specks) and keeps only the energy above a soft-kneed threshold, so white
// lines and the ball stay crisp while floodlights and the sun's glints glow.
const BloomDown = {
  uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1 }, uKnee: { value: 0.5 } },
  vertexShader: VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uThreshold, uKnee; varying vec2 vUv;
    vec3 tap(vec2 o) { return min(texture2D(tDiffuse, vUv + o * uTexel).rgb, vec3(60.0)); }
    void main() {
      vec3 a = tap(vec2(-1.0, -1.0)), b = tap(vec2(1.0, -1.0)), c = tap(vec2(-1.0, 1.0)), d = tap(vec2(1.0, 1.0)), e = tap(vec2(0.0));
      #ifdef PREFILTER
      float wa = 1.0 / (1.0 + max(a.r, max(a.g, a.b))), wb = 1.0 / (1.0 + max(b.r, max(b.g, b.b))), wc = 1.0 / (1.0 + max(c.r, max(c.g, c.b)));
      float wd = 1.0 / (1.0 + max(d.r, max(d.g, d.b))), we = 4.0 / (1.0 + max(e.r, max(e.g, e.b)));
      vec3 col = (a * wa + b * wb + c * wc + d * wd + e * we) / (wa + wb + wc + wd + we);
      float br = max(col.r, max(col.g, col.b));
      float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
      soft = soft * soft / (4.0 * uKnee + 1e-4);
      col *= max(soft, br - uThreshold) / max(br, 1e-4);
      #else
      vec3 col = (a + b + c + d + e * 4.0) * 0.125;
      #endif
      gl_FragColor = vec4(col, 1.0);
    }`,
};
const BloomUp = {
  uniforms: { tDiffuse: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uSpread: { value: 1 } },
  vertexShader: VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse, tBase; uniform vec2 uTexel; uniform float uSpread; varying vec2 vUv;
    void main() {   // 3x3 tent over the smaller level, added to this level's own downsample
      vec2 t = uTexel;
      vec3 s = texture2D(tDiffuse, vUv).rgb * 4.0;
      s += (texture2D(tDiffuse, vUv + vec2(-t.x, 0.0)).rgb + texture2D(tDiffuse, vUv + vec2(t.x, 0.0)).rgb + texture2D(tDiffuse, vUv + vec2(0.0, -t.y)).rgb + texture2D(tDiffuse, vUv + vec2(0.0, t.y)).rgb) * 2.0;
      s += texture2D(tDiffuse, vUv - t).rgb + texture2D(tDiffuse, vUv + t).rgb + texture2D(tDiffuse, vUv + vec2(t.x, -t.y)).rgb + texture2D(tDiffuse, vUv + vec2(-t.x, t.y)).rgb;
      gl_FragColor = vec4(texture2D(tBase, vUv).rgb + s / 16.0 * uSpread, 1.0);
    }`,
};
// Floodlight glare: a long horizontal streak drawn out of a small bloom level, like a broadcast lens at night.
const GlareShader = {
  uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uStep: { value: 1 } },
  vertexShader: VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uStep; varying vec2 vUv;
    void main() {
      vec3 s = vec3(0.0); float tot = 0.0;
      for (int i = -6; i <= 6; i++) {
        float w = exp(-abs(float(i)) * 0.45);
        s += texture2D(tDiffuse, vUv + vec2(float(i) * uStep * uTexel.x, 0.0)).rgb * w; tot += w;
      }
      gl_FragColor = vec4(s / tot, 1.0);
    }`,
};

// Depth of field for cinematic shots (menu close-ups, replays): a single-pass bokeh gather over the scene's depth.
// Background samples can't bleed over a sharper foreground. Disabled, and free, during play.
const DofShader = {
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
    uFocus: { value: 5 }, uAperture: { value: 0 }, uMax: { value: 14 }, cameraNear: { value: 0.25 }, cameraFar: { value: 1400 },
  },
  vertexShader: VERT,
  fragmentShader: `
    #include <packing>
    uniform sampler2D tDiffuse, tDepth; uniform vec2 uRes; uniform float uFocus, uAperture, uMax, cameraNear, cameraFar;
    varying vec2 vUv;
    float viewDist(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar); }
    float blurSize(float z) { return clamp(uAperture * abs(z - uFocus) / max(z, 0.01), 0.0, uMax); }
    void main() {
      float cz = viewDist(vUv), cs = blurSize(cz);
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      float tot = 1.0, radius = 1.6;
      for (int i = 0; i < 80; i++) {
        if (radius >= uMax) break;
        float ang = float(i) * 2.39996323;
        vec2 tc = vUv + vec2(cos(ang), sin(ang)) * radius / uRes;
        vec3 sc = texture2D(tDiffuse, tc).rgb;
        float sz = viewDist(tc), ss = blurSize(sz);
        if (sz > cz) ss = clamp(ss, 0.0, cs * 2.0);
        float m = smoothstep(radius - 0.5, radius + 0.5, ss);
        col += mix(col / tot, sc, m);
        tot += 1.0;
        radius += 1.6 / radius;
      }
      gl_FragColor = vec4(col / tot, 1.0);
    }`,
};

// samples: MSAA in the scene target. aa: post anti-aliasing after tone mapping ('fxaa' is cheap, 'smaa' cleaner
// on long thin edges such as court lines, net tape and rackets). sunCascade: size of the soft stadium-wide sun
// shadow map (0 = none; the court always has its own sharp one). floodShadow: night floodlight shadow map size.
export const PRESETS = {
  low:    { label: 'Low',    maxDpr: 1.0,  scale: 0.8, shadow: 1024, radius: 1.2, ao: false, bloom: false, samples: 0, aa: 'fxaa', sunCascade: 0,    floodShadow: 0,    crowd: 0.3,  detail: 0 },
  medium: { label: 'Medium', maxDpr: 1.25, scale: 1.0, shadow: 2048, radius: 1.6, ao: false, bloom: true,  samples: 2, aa: 'smaa', sunCascade: 1024, floodShadow: 512,  crowd: 0.75, detail: 1 },
  high:   { label: 'High',   maxDpr: 1.5,  scale: 1.0, shadow: 2048, radius: 2.0, ao: true,  bloom: true,  samples: 4, aa: 'smaa', sunCascade: 2048, floodShadow: 1024, crowd: 1.0,  detail: 2 },
  ultra:  { label: 'Ultra',  maxDpr: 2.0,  scale: 1.0, shadow: 4096, radius: 2.6, ao: true,  bloom: true,  samples: 4, aa: 'smaa', sunCascade: 2048, floodShadow: 2048, crowd: 1.0,  detail: 3 },
};

let composer = null;

// Graphics quality. 'auto' picks a preset from the graphics chip, then trades pixel density for smoothness.
export const Perf = {
  scale: 1, max: 1, min: 0.5, avg: 16.7, fps: 60, lastAdjust: 0, goodSince: 0, gpu: '', software: false, integrated: false, preset: 'high',
  detectGpu() {
    try {
      const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      this.gpu = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
    } catch (e) { this.gpu = ''; }
    this.software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(this.gpu);
    this.integrated = /intel|iris|uhd|hd graphics|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|adreno|mali|powervr|apple m\d/i.test(this.gpu) && !/rtx|gtx|radeon rx|arc a/i.test(this.gpu);
    return this.software;
  },
  gpuName() {
    const m = this.gpu.match(/ANGLE \([^,]*,\s*(.+?)\s*(?:\(0x[0-9a-f]+\))?\s*(?:Direct3D|OpenGL|Vulkan|Metal|,)/i);
    return (m ? m[1] : this.gpu).replace(/\s+/g, ' ').trim() || 'unknown graphics';
  },
  presetKey() {
    const g = Settings.gfx === 'fast' ? 'low' : Settings.gfx === 'sharp' ? 'ultra' : Settings.gfx;
    if (PRESETS[g]) return g;
    const k = this.software ? 'low' : this.integrated ? 'medium' : 'high', keys = Object.keys(PRESETS);
    return keys[Math.min(keys.indexOf(k), this.cap)];   // cap: lowered by frame() when even the lowest resolution was too slow
  },
  cap: 9, bad: 0, upAt: -1e9, hold: 5000, slowSince: 0,
  cfg() { return PRESETS[this.preset]; },
  mode() { return Settings.gfx === 'auto' || !PRESETS[Settings.gfx] ? 'auto' : Settings.gfx; },
  apply() {
    this.preset = this.presetKey();
    const p = this.cfg(), dpr = window.devicePixelRatio || 1;
    this.max = Math.min(dpr, p.maxDpr) * p.scale;
    this.min = Math.max(0.45, this.max * 0.5);
    buildComposer(p);
    this.setScale(this.mode() === 'auto' ? Math.min(this.max, 1.25) : this.max);
    for (const f of this.listeners) f(p);
    this.lastAdjust = performance.now() + 2500;   // let shaders compile before judging speed
    this.goodSince = 0;
  },
  listeners: [],
  onChange(fn) { this.listeners.push(fn); },
  // Main-thread time per frame by section, for tuning: PalmCourt.Perf.profile(), play a while, then read
  // PalmCourt.Perf.sections ({ Game: { avg, mean, max, n }, … } in ms; avg is smoothed). Off (null) by default, when
  // the frame loop skips it entirely. info() adds the draw calls, triangles and shader programs of the last frame.
  sections: null,
  profile(on = true) { this.sections = on ? {} : null; return this; },
  section(k, ms) {
    const s = this.sections[k] || (this.sections[k] = { avg: ms, mean: 0, max: 0, n: 0, sum: 0 });
    s.avg += (ms - s.avg) * 0.05; s.sum += ms; s.n++; s.mean = s.sum / s.n; if (ms > s.max) s.max = ms;
  },
  info() { const i = renderer.info; return { preset: this.preset, scale: +this.scale.toFixed(2), calls: i.render.calls, triangles: i.render.triangles, programs: i.programs ? i.programs.length : 0, geometries: i.memory.geometries, textures: i.memory.textures }; },
  setScale(s) {
    this.scale = s;
    readView();
    renderer.setPixelRatio(s);
    renderer.setSize(view.w, view.h, false);
    if (composer) { composer.setPixelRatio(s); composer.setSize(view.w, view.h); }
  },
  // Auto quality, once per drawn frame (ms since the last one). Too slow: lower the resolution a step at a time,
  // and if even the lowest is too slow for a few seconds, drop to the next preset down (only when calm: menus,
  // between points; it stays down for the session). Fast for a while: raise the resolution again. A step up that
  // turns out too slow doubles the wait before the next try, so it settles instead of see-sawing.
  frame(ms, calm = true) {
    this.avg = this.avg * 0.92 + Math.min(ms, 50) * 0.08;   // one long frame (a shader compiling) is a hitch, not a slow GPU
    this.fps = 1000 / this.avg;
    if (this.mode() !== 'auto') return;
    const now = performance.now();
    if (now < this.lastAdjust) return;
    if (this.avg > 21) {
      this.goodSince = 0;
      if (this.scale > this.min + 0.01) {
        this.slowSince = 0;
        if (now - this.lastAdjust > 1200) {
          if (now - this.upAt < 10000) this.hold = Math.min(120000, this.hold * 2);
          this.setScale(Math.max(this.min, this.scale * 0.85)); this.lastAdjust = now;
        }
      } else if (this.avg > 24 && this.preset !== 'low') {
        if (!this.slowSince) this.slowSince = now;
        if (calm && now - this.slowSince > 4000) {
          this.cap = Object.keys(PRESETS).indexOf(this.preset) - 1; this.slowSince = 0;
          console.warn(`Palm Court: graphics too slow, auto quality steps down to ${PRESETS[Object.keys(PRESETS)[this.cap]].label}.`);
          this.apply();
        }
      } else this.slowSince = 0;
    } else if (this.avg < 17.8) {
      this.slowSince = 0;
      if (!this.goodSince) this.goodSince = now;
      if (this.upAt > this.lastAdjust - 1 && now - this.upAt > 60000) this.hold = 5000;   // the last step up held: back to quick steps
      if (now - this.goodSince > this.hold && now - this.lastAdjust > 5000 && this.scale < this.max - 0.01) {
        this.setScale(Math.min(this.max, this.scale * 1.1)); this.lastAdjust = this.upAt = now; this.goodSince = now;
      }
    } else this.goodSince = this.slowSince = 0;
  },
};

// A render target some GPUs can't draw into (half float, multisampled, with a depth texture) would leave a black
// screen, so each one is tried once (draw, resolve, check for errors) before the chain relies on it.
const _probe = new THREE.Scene();
function targetOk(rt) {
  const gl = renderer.getContext();
  if (gl.isContextLost()) return false;
  for (let i = 0; i < 16 && gl.getError() !== gl.NO_ERROR; i++);
  try {
    renderer.setRenderTarget(rt);
    let ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    renderer.render(_probe, camera);   // clears, then resolves the multisampled buffer into the textures
    const fb = renderer.properties.get(rt).__webglFramebuffer;
    if (ok && rt.samples > 0 && fb) { renderer.state.bindFramebuffer(gl.FRAMEBUFFER, fb); ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE; }
    renderer.setRenderTarget(null);
    return ok && gl.getError() === gl.NO_ERROR;
  } catch (e) {
    try { renderer.setRenderTarget(null); } catch (e2) { /* context gone */ }
    return false;
  }
}

const quad = new FullScreenQuad(null);
function draw(mat, target) { renderer.setRenderTarget(target); quad.material = mat; quad.render(renderer); }
const shaderMat = (S, defines = {}) => new THREE.ShaderMaterial({
  uniforms: THREE.UniformsUtils.clone(S.uniforms), vertexShader: S.vertexShader, fragmentShader: S.fragmentShader, defines,
  depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
});
const hdrTarget = (w, h) => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });

// The post chain: scene (multisampled, half float, depth texture) → GTAO → depth of field → bloom + glare →
// tone mapping and grade → FXAA or SMAA → screen. Post passes ping-pong between plain (single-sample) targets so
// only the scene pays for MSAA. If the GPU can't draw into the targets at all, the scene is drawn straight to the
// screen with tone mapping done by the materials (no effects, but a picture).
class Chain {
  constructor(p) {
    this.p = p; this.pr = renderer.getPixelRatio(); this.w = view.w; this.h = view.h;
    const [W, H] = this.px();
    const tries = [[p.samples, true], [p.samples, false], [0, true], [0, false]].filter(([s], i, a) => i < 2 || s !== a[0][0]);
    for (const [s, depth] of tries) {
      const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: s, depthTexture: depth ? new THREE.DepthTexture(W, H) : null });
      if (targetOk(rt)) { this.scene = rt; break; }
      rt.dispose();
    }
    this.a = hdrTarget(W, H); this.b = hdrTarget(W, H);
    if (!this.scene || !targetOk(this.a)) {
      console.warn('Palm Court: this GPU cannot render into half-float targets; drawing without post-processing.');
      this.direct = true; this.dispose(); return;
    }
    if (this.scene.samples !== p.samples || !this.scene.depthTexture) console.warn(`Palm Court: scene target fell back to ${this.scene.samples}x MSAA${this.scene.depthTexture ? '' : ', no depth of field'}.`);
    if (p.ao) this.makeAO(W, H);
    if (this.scene.depthTexture && p.detail >= 1) { this.dof = shaderMat(DofShader); this.dof.uniforms.tDepth.value = this.scene.depthTexture; }
    if (p.bloom) this.makeBloom();
    this.final = shaderMat(FinalShader, p.bloom ? { BLOOM: '', GLARE: '' } : {});
    if (p.aa === 'smaa') {
      this.smaa = new SMAAPass();
      if (p.detail >= 2) {   // longer edge searches and a lower threshold: cleaner court lines at grazing angles
        this.smaa._materialEdges.defines.SMAA_THRESHOLD = '0.05';
        this.smaa._materialWeights.defines.SMAA_MAX_SEARCH_STEPS = '16';
      }
    } else if (p.aa === 'fxaa') this.fxaa = shaderMat(FXAAShader);
    this.setSize(this.w, this.h);
  }
  px() { return [Math.max(1, Math.floor(this.w * this.pr)), Math.max(1, Math.floor(this.h * this.pr))]; }
  makeAO(W, H) {
    const ao = new GTAOPass(scene, camera, W, H);
    if (!targetOk(ao.normalRenderTarget)) { ao.dispose(); return; }
    ao.output = GTAOPass.OUTPUT.Default;
    ao.blendIntensity = 0.85;
    ao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1.6, thickness: 1.0, scale: 1.0, samples: this.p.detail >= 3 ? 16 : 12, distanceFallOff: 1.0 });
    ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    // Half-resolution AO (upsampled when blended). Its normal pass draws everything solid, so skip objects marked
    // noAO (the crowd) and anything that doesn't write depth in the real render (ball trail, net mesh, decals),
    // which would otherwise leave dark occlusion outlines on the court.
    const setSize = ao.setSize.bind(ao), half = this.p.detail >= 3 ? 0.75 : 0.5;
    ao.setSize = (sw, sh) => setSize(Math.max(1, Math.round(sw * half)), Math.max(1, Math.round(sh * half)));
    const hide = ao._overrideVisibility.bind(ao);
    ao._overrideVisibility = function () {
      hide();
      const cache = this._visibilityCache;
      this.scene.traverse((o) => {
        if (!o.visible) return;
        const m = o.material;
        if (o.userData.noAO || (m && m.transparent && !m.depthWrite)) { o.visible = false; cache.push(o); }
      });
    };
    this.ao = ao;
  }
  makeBloom() {
    this.down = []; this.up = []; this.downMat = []; this.upMat = [];
    for (let i = 0; i < 6; i++) {
      this.down.push(hdrTarget(1, 1)); this.up.push(hdrTarget(1, 1));
      this.downMat.push(shaderMat(BloomDown, i === 0 ? { PREFILTER: '' } : {}));
      this.upMat.push(shaderMat(BloomUp));
    }
    this.glareT = [hdrTarget(1, 1), hdrTarget(1, 1)];
    this.glareMat = shaderMat(GlareShader);
  }
  setPixelRatio(r) { this.pr = r; this.setSize(this.w, this.h); }
  setSize(w, h) {
    this.w = w; this.h = h;
    if (this.direct) return;
    const [W, H] = this.px();
    this.scene.setSize(W, H); this.a.setSize(W, H); this.b.setSize(W, H);
    if (this.ao) this.ao.setSize(W, H);
    if (this.down) {
      let bw = W, bh = H;
      for (let i = 0; i < this.down.length; i++) {
        bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
        this.down[i].setSize(bw, bh); this.up[i].setSize(bw, bh);
        if (i === 2) for (const g of this.glareT) g.setSize(bw, bh);
      }
    }
    if (this.smaa) this.smaa.setSize(W, H);
    if (this.fxaa) this.fxaa.uniforms.resolution.value.set(1 / W, 1 / H);
    this.final.uniforms.uAspect.value = W / H;
  }
  // Returns the bloom texture (half resolution) for the final pass.
  bloom(src) {
    const L = this.down.length;
    let tex = src, texel = _v2.set(1 / this.scene.width, 1 / this.scene.height);
    for (let i = 0; i < L; i++) {
      const m = this.downMat[i], u = m.uniforms;
      u.tDiffuse.value = tex; u.uTexel.value.copy(texel);
      if (i === 0) { u.uThreshold.value = Look.bloomThreshold; u.uKnee.value = Look.bloomThreshold * 0.5; }
      draw(m, this.down[i]);
      tex = this.down[i].texture; texel.set(1 / this.down[i].width, 1 / this.down[i].height);
    }
    let up = this.down[L - 1];
    for (let i = L - 2; i >= 0; i--) {
      const m = this.upMat[i], u = m.uniforms;
      u.tDiffuse.value = up.texture; u.tBase.value = this.down[i].texture; u.uTexel.value.set(1 / up.width, 1 / up.height); u.uSpread.value = Look.bloomSpread;
      draw(m, this.up[i]);
      up = this.up[i];
    }
    if (Look.glare > 0) {   // two passes of the streak kernel (steps 1 and 7) at 1/8 resolution make a long, smooth streak
      const g = this.glareMat.uniforms, t = this.glareT;
      g.tDiffuse.value = this.up[2].texture; g.uTexel.value.set(1 / t[0].width, 1 / t[0].height); g.uStep.value = 1.5;
      draw(this.glareMat, t[0]);
      g.tDiffuse.value = t[0].texture; g.uStep.value = 7;
      draw(this.glareMat, t[1]);
    }
    return up.texture;
  }
  render(time) {
    const r = renderer;
    if (this.direct) { r.setRenderTarget(null); r.render(scene, camera); return; }
    r.setRenderTarget(this.scene);
    r.render(scene, camera);
    let read = this.scene;
    const other = () => (read === this.a ? this.b : this.a);
    if (this.ao) { const w = other(); this.ao.render(r, w, read); read = w; }
    if (this.dof && Look.dofAperture > 0) {
      const u = this.dof.uniforms, k = this.scene.height / 720;
      u.tDiffuse.value = read.texture; u.uRes.value.set(this.scene.width, this.scene.height);
      u.uFocus.value = Look.dofFocus; u.uAperture.value = Look.dofAperture * k; u.uMax.value = Math.min(26, 14 * k);
      u.cameraNear.value = camera.near; u.cameraFar.value = camera.far;
      const w = other(); draw(this.dof, w); read = w;
    }
    const f = this.final.uniforms;
    f.tDiffuse.value = read.texture; f.uTime.value = time || 0; f.uExposure.value = r.toneMappingExposure;
    if (this.down) {
      f.tBloom.value = this.bloom(read.texture);
      f.uBloom.value = Look.bloom; f.uGlare.value = Look.glare; f.tGlare.value = this.glareT[1].texture;
    }
    if (this.smaa || this.fxaa) {
      const w = other(); draw(this.final, w);
      if (this.smaa) { this.smaa.renderToScreen = true; this.smaa.render(r, null, w); }
      else { this.fxaa.uniforms.tDiffuse.value = w.texture; draw(this.fxaa, null); }
    } else draw(this.final, null);
  }
  dispose() {
    for (const t of [this.scene, this.a, this.b, ...(this.down || []), ...(this.up || []), ...(this.glareT || [])]) if (t) t.dispose();
    for (const m of [this.dof, this.final, this.fxaa, this.glareMat, ...(this.downMat || []), ...(this.upMat || [])]) if (m) m.dispose();
    if (this.ao) this.ao.dispose();
    if (this.smaa) this.smaa.dispose();
  }
}
const _v2 = new THREE.Vector2();

function buildComposer(p) {
  if (composer) composer.dispose();
  readView();
  composer = new Chain(p);
  applyGrade();
}

// Look settings the time of day can change (night gets more bloom and floodlight glare, golden hour a warm grade),
// plus depth of field for cinematic cameras: dof(focus distance in metres, blur in pixels at 720p); dof(0) turns it off.
export const Look = {
  dofFocus: 5, dofAperture: 0, bloom: 0.2, bloomThreshold: 2.5, bloomSpread: 0.8, glare: 0, glareTint: [0.8, 0.9, 1.0],
  dof(focus, aperture = 0) { this.dofFocus = focus; this.dofAperture = aperture; },
  set({ bloom = 0.2, bloomThreshold = 2.5, bloomSpread = 0.8, glare = 0, glareTint = [0.8, 0.9, 1.0], exposure = 1.0, saturation = 1.06, contrast = 1.04, vignette = 0.22, gain = [1, 1, 1], lift = [0, 0, 0], grain = 0.018 } = {}) {
    renderer.toneMappingExposure = exposure;
    Object.assign(this, { bloom, bloomThreshold, bloomSpread, glare, glareTint });
    this.grade = { saturation, contrast, vignette, gain, lift, grain };
    applyGrade();
  },
};
function applyGrade() {
  if (!composer || !composer.final || !Look.grade) return;
  const u = composer.final.uniforms, g = Look.grade;
  u.uSaturation.value = g.saturation; u.uContrast.value = g.contrast; u.uVignette.value = g.vignette; u.uGrain.value = g.grain;
  u.uGain.value.set(...g.gain); u.uLift.value.set(...g.lift); u.uGlareTint.value.set(...Look.glareTint);
}
Perf.onChange(() => applyGrade());

let lost = false;
export function render(time) {
  if (!innerWidth || !innerHeight || lost || !composer) return;   // nothing on screen to draw into
  // Resize events can be missed (booting in a hidden window, some fullscreen switches), so check every frame.
  if (innerWidth !== view.w || innerHeight !== view.h) onResize();
  composer.render(time);
}

function onResize() {
  if (!readView()) return;
  camera.aspect = view.w / view.h;
  camera.updateProjectionMatrix();
  renderer.setSize(view.w, view.h, false);
  if (composer) composer.setSize(view.w, view.h);
}
addEventListener('resize', onResize);

// A lost WebGL context (driver reset, GPU switch, sleep on some laptops) stops drawing until the browser restores
// it; three.js then re-uploads meshes and textures by itself. Render targets come back empty, so the post chain is
// rebuilt and anything baked into a target (the sky's light probe…) is re-baked by its owner via onContextRestored.
const restorers = [];
export function onContextRestored(fn) { restorers.push(fn); }
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; console.warn('Palm Court: WebGL context lost, waiting for it to come back.'); });
canvas.addEventListener('webglcontextrestored', () => {
  lost = false;
  console.warn('Palm Court: WebGL context restored.');
  try {
    Perf.apply();
    for (const fn of restorers) fn();
  } catch (e) { console.error(e); }
});
