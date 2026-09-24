// Procedural textures: drawn on the GPU with shaders (fast, any size) or on a 2D canvas (text, signs).
import * as THREE from 'three';
import { renderer } from './renderer.js';

export function canvasTex(w, h, draw, { srgb = true, repeat = false } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Shared GLSL noise: hash, value noise, fbm, cellular.
export const NOISE_GLSL = `
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
// tileable value noise with period per
float tnoise(vec2 p, vec2 per) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 a = mod(i, per), b = mod(i + 1.0, per);
  return mix(mix(hash12(a), hash12(vec2(b.x, a.y)), u.x), mix(hash12(vec2(a.x, b.y)), hash12(b), u.x), u.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
float tfbm(vec2 p, vec2 per) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * tnoise(p, per); p *= 2.0; per *= 2.0; a *= 0.5; } return s; }
// tileable cellular noise: distance to nearest feature point
float tcell(vec2 p, vec2 per) {
  vec2 i = floor(p), f = fract(p); float d = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y); vec2 o = hash22(mod(i + g, per)); d = min(d, length(g + o - f));
  }
  return d;
}
vec3 srgb2lin(vec3 c) { return pow(c, vec3(2.2)); }
`;

const quadGeo = new THREE.PlaneGeometry(2, 2);
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const vertex = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

// Render a fragment shader into a texture. The shader writes linear colors (or raw data for normal maps).
export function gpuTexture({ width, height, fragment, uniforms = {}, repeat = false, mipmaps = true, type = THREE.UnsignedByteType }) {
  const rt = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: false, type, generateMipmaps: mipmaps,
    minFilter: mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, magFilter: THREE.LinearFilter,
    wrapS: repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping, wrapT: repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping,
  });
  rt.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uRes: { value: new THREE.Vector2(width, height) } },
    vertexShader: vertex,
    fragmentShader: 'precision highp float; varying vec2 vUv; uniform vec2 uRes;\n' + NOISE_GLSL + fragment,
    depthTest: false, depthWrite: false,
  });
  const mesh = new THREE.Mesh(quadGeo, mat), sc = new THREE.Scene();
  sc.add(mesh);
  const prev = renderer.getRenderTarget(), prevTone = renderer.toneMapping;
  renderer.setRenderTarget(rt);
  renderer.render(sc, orthoCam);
  renderer.setRenderTarget(prev);
  renderer.toneMapping = prevTone;
  mat.dispose();
  return rt.texture;
}

// Build a tiling normal map from a height function written in GLSL: float height(vec2 uv) returning 0..1.
export function normalFromHeight({ size = 1024, heightGlsl, strength = 1, uniforms = {} }) {
  return gpuTexture({
    width: size, height: size, repeat: true, uniforms: { uStrength: { value: strength }, ...uniforms },
    fragment: heightGlsl + `
      uniform float uStrength;
      void main() {
        vec2 e = 1.0 / uRes;
        float hl = height(fract(vUv - vec2(e.x, 0.0))), hr = height(fract(vUv + vec2(e.x, 0.0)));
        float hd = height(fract(vUv - vec2(0.0, e.y))), hu = height(fract(vUv + vec2(0.0, e.y)));
        vec3 n = normalize(vec3((hl - hr) * uStrength, (hd - hu) * uStrength, 1.0));
        gl_FragColor = vec4(n * 0.5 + 0.5, height(vUv));
      }`,
  });
}
