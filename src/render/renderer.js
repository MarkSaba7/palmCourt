// Renderer, scene, camera, post-processing and graphics quality.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
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

// Final look: gentle contrast, saturation, vignette and a touch of grain (which also hides sky banding).
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uVignette: { value: 0.22 }, uSaturation: { value: 1.06 },
    uContrast: { value: 1.04 }, uLift: { value: new THREE.Vector3(0, 0, 0) }, uGain: { value: new THREE.Vector3(1, 1, 1) }, uGrain: { value: 0.018 },
  },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime, uVignette, uSaturation, uContrast, uGrain; uniform vec3 uLift, uGain;
    varying vec2 vUv;
    float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      c = (c - 0.5) * uContrast + 0.5;
      c = c * uGain + uLift;
      vec2 d = (vUv - 0.5) * vec2(1.15, 1.0);
      c *= mix(1.0 - uVignette, 1.0, smoothstep(0.78, 0.2, length(d)));
      c += (hash(vUv * 1024.0 + fract(uTime) * 61.0) - 0.5) * uGrain;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

// Depth of field for cinematic shots (menu close-ups, replays): a single-pass bokeh gather over the scene's depth.
// Background samples can't bleed over a sharper foreground. Disabled, and free, during play.
const DofShader = {
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
    uFocus: { value: 5 }, uAperture: { value: 0 }, uMax: { value: 14 }, cameraNear: { value: 0.25 }, cameraFar: { value: 1400 },
  },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
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

export const PRESETS = {
  low:    { label: 'Low',    maxDpr: 1.0,  scale: 0.8, shadow: 1024, radius: 1.5, ao: false, bloom: false, samples: 2, crowd: 0.45, detail: 0 },
  medium: { label: 'Medium', maxDpr: 1.25, scale: 1.0, shadow: 2048, radius: 2.5, ao: false, bloom: true,  samples: 4, crowd: 0.75, detail: 1 },
  high:   { label: 'High',   maxDpr: 1.5,  scale: 1.0, shadow: 2048, radius: 3.0, ao: true,  bloom: true,  samples: 4, crowd: 1.0,  detail: 2 },
  ultra:  { label: 'Ultra',  maxDpr: 2.0,  scale: 1.0, shadow: 4096, radius: 3.0, ao: true,  bloom: true,  samples: 4, crowd: 1.0,  detail: 3 },
};

let composer = null, renderPass = null, aoPass = null, bloomPass = null, gradePass = null, outputPass = null, dofPass = null;

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
    return this.software ? 'low' : this.integrated ? 'medium' : 'high';
  },
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
  setScale(s) {
    this.scale = s;
    readView();
    renderer.setPixelRatio(s);
    renderer.setSize(view.w, view.h, false);
    if (composer) { composer.setPixelRatio(s); composer.setSize(view.w, view.h); }
  },
  frame(ms) {
    this.avg = this.avg * 0.92 + ms * 0.08;
    this.fps = 1000 / this.avg;
    if (this.mode() !== 'auto') return;
    const now = performance.now();
    if (now < this.lastAdjust) return;
    if (this.avg > 21) {
      if (this.scale > this.min + 0.01 && now - this.lastAdjust > 1200) { this.setScale(Math.max(this.min, this.scale * 0.85)); this.lastAdjust = now; }
      this.goodSince = 0;
    } else if (this.avg < 17.8) {
      if (!this.goodSince) this.goodSince = now;
      if (now - this.goodSince > 5000 && now - this.lastAdjust > 5000 && this.scale < this.max - 0.01) {
        this.setScale(Math.min(this.max, this.scale * 1.1)); this.lastAdjust = now; this.goodSince = now;
      }
    } else this.goodSince = 0;
  },
};

function buildComposer(p) {
  if (composer) { composer.renderTarget1.dispose(); composer.renderTarget2.dispose(); if (aoPass) aoPass.dispose(); if (bloomPass) bloomPass.dispose(); }
  readView();
  const w = view.w, h = view.h;
  // The scene target keeps its depth as a texture (resolved from the multisampled buffer) for depth of field.
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: p.samples, depthTexture: new THREE.DepthTexture(w, h) });
  composer = new EffectComposer(renderer, rt);
  renderPass = new RenderPass(scene, camera);
  const drawScene = renderPass.render.bind(renderPass);
  // Which of the two targets holds this frame's scene (and its depth) depends on how many passes swapped before.
  renderPass.render = (r, writeBuffer, readBuffer, dt, mask) => {
    if (dofPass) dofPass.uniforms.tDepth.value = readBuffer.depthTexture;
    drawScene(r, writeBuffer, readBuffer, dt, mask);
  };
  composer.addPass(renderPass);
  aoPass = null; bloomPass = null;
  if (p.ao) {
    aoPass = new GTAOPass(scene, camera, w, h);
    aoPass.output = GTAOPass.OUTPUT.Default;
    aoPass.blendIntensity = 0.9;
    aoPass.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.6, thickness: 1.2, scale: 1.0, samples: p.detail >= 3 ? 16 : 12, distanceFallOff: 1.0 });
    aoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    // Half-resolution AO (upsampled when blended). Its normal pass draws everything solid, so skip objects marked
    // noAO (the crowd) and anything that doesn't write depth in the real render (ball trail, net mesh, decals),
    // which would otherwise leave dark occlusion outlines on the court.
    const setSize = aoPass.setSize.bind(aoPass), half = p.detail >= 3 ? 0.75 : 0.5;
    aoPass.setSize = (sw, sh) => setSize(Math.max(1, Math.round(sw * half)), Math.max(1, Math.round(sh * half)));
    const hide = aoPass._overrideVisibility.bind(aoPass);
    aoPass._overrideVisibility = function () {
      hide();
      const cache = this._visibilityCache;
      this.scene.traverse((o) => {
        if (!o.visible) return;
        const m = o.material;
        if (o.userData.noAO || (m && m.transparent && !m.depthWrite)) { o.visible = false; cache.push(o); }
      });
    };
    composer.addPass(aoPass);
  }
  dofPass = null;
  if (p.detail >= 1) {
    dofPass = new ShaderPass(DofShader);
    dofPass.enabled = false;
    composer.addPass(dofPass);
  }
  if (p.bloom) {
    bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.28, 0.55, 0.92);
    composer.addPass(bloomPass);
  }
  outputPass = new OutputPass();
  composer.addPass(outputPass);
  gradePass = new ShaderPass(GradeShader);
  composer.addPass(gradePass);
}

// Look settings the time of day can change (night gets more bloom, golden hour a warm grade), plus depth of field
// for cinematic cameras: dof(focus distance in metres, blur in pixels at 720p); dof(0) turns it off.
export const Look = {
  dofFocus: 5, dofAperture: 0,
  dof(focus, aperture = 0) { this.dofFocus = focus; this.dofAperture = aperture; },
  set({ bloom = 0.28, bloomThreshold = 0.92, exposure = 1.0, saturation = 1.06, contrast = 1.04, vignette = 0.22, gain = [1, 1, 1], lift = [0, 0, 0] } = {}) {
    renderer.toneMappingExposure = exposure;
    this.bloom = bloom; this.bloomThreshold = bloomThreshold;
    if (bloomPass) { bloomPass.strength = bloom; bloomPass.threshold = bloomThreshold; }
    this.grade = { saturation, contrast, vignette, gain, lift };
    applyGrade();
  },
};
function applyGrade() {
  if (!gradePass || !Look.grade) return;
  const u = gradePass.uniforms, g = Look.grade;
  u.uSaturation.value = g.saturation; u.uContrast.value = g.contrast; u.uVignette.value = g.vignette;
  u.uGain.value.set(...g.gain); u.uLift.value.set(...g.lift);
  if (bloomPass) { bloomPass.strength = Look.bloom ?? 0.28; bloomPass.threshold = Look.bloomThreshold ?? 0.92; }
}
Perf.onChange(() => applyGrade());

export function render(time) {
  if (!innerWidth || !innerHeight) return;   // nothing on screen to draw into
  // Resize events can be missed (booting in a hidden window, some fullscreen switches), so check every frame.
  if (innerWidth !== view.w || innerHeight !== view.h) onResize();
  if (gradePass) gradePass.uniforms.uTime.value = time || 0;
  if (dofPass) {
    dofPass.enabled = Look.dofAperture > 0;
    if (dofPass.enabled) {
      const u = dofPass.uniforms, k = renderer.getDrawingBufferSize(_buf).y / 720;
      u.uRes.value.copy(_buf); u.uFocus.value = Look.dofFocus; u.uAperture.value = Look.dofAperture * k; u.uMax.value = Math.min(26, 14 * k);
      u.cameraNear.value = camera.near; u.cameraFar.value = camera.far;
    }
  }
  composer.render();
}

const _buf = new THREE.Vector2();
function onResize() {
  if (!readView()) return;
  camera.aspect = view.w / view.h;
  camera.updateProjectionMatrix();
  renderer.setSize(view.w, view.h, false);
  if (composer) composer.setSize(view.w, view.h);
}
addEventListener('resize', onResize);
