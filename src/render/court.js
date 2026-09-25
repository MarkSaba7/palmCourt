// The court: surfaces (hard, clay, grass) with their painted lines, the net (mesh, tape, strap, posts, singles
// sticks) with ripples, and ball and slide marks.
import * as THREE from 'three';
import { COURT, netHeight, lerp } from '../core.js';
import { scene } from './renderer.js';
import { gpuTexture, detailTexture, canvasTex, NOISE_GLSL } from './textures.js';
import { Perf } from './renderer.js';

// Ground covers the playing area plus run-off, x -12..12 and z -22..22 metres.
export const GROUND = { w: 24, l: 44 };
// Line widths in metres (ITF: 2.5-5 cm, baseline up to 10 cm, centre mark 10 cm long). Every line lies inside the
// court, so its outer edge is exactly the COURT dimension that core.js calls lines against.
export const LINES = { w: 0.05, base: 0.08, mark: 0.1 };

const LOOK = {
  // tile: metres per repeat of the micro detail; normal: its bump strength; rough/lineRough: surface and paint gloss
  hard:  { inner: '#23578f', outer: '#3a6c4e', line: '#f3f5f0', rough: 0.6,  lineRough: 0.46, env: 0.7,  tile: 1.1,  normal: 0.9, wobble: 0.0008 },
  clay:  { inner: '#b65a36', outer: '#b25735', line: '#efe9dd', rough: 0.93, lineRough: 0.6,  env: 0.35, tile: 1.3,  normal: 1.3, wobble: 0.0 },
  grass: { inner: '#467f33', outer: '#437b31', line: '#fbfbf5', rough: 0.82, lineRough: 0.9,  env: 0.4,  tile: 0.5,  normal: 1.0, wobble: 0.004 },
};
const KIND = { hard: 0, clay: 1, grass: 2 };
const f4 = (v) => v.toFixed(4);
const linear = (hex) => { const c = new THREE.Color(hex); return new THREE.Vector3(c.r, c.g, c.b); };   // THREE.Color is already linear

// Where play wears a court: behind each baseline (the rally spot and the deuce/ad return spots) and at the T.
const WEAR_GLSL = `
float ellipseMask(vec2 p, vec2 c, vec2 r) { vec2 d = (p - c) / r; return exp(-dot(d, d)); }
float baseWear(vec2 w) {
  vec2 a = abs(w);
  float m = ellipseMask(a, vec2(0.0, 12.3), vec2(3.6, 1.35));
  m += 0.55 * ellipseMask(a, vec2(2.4, 12.1), vec2(1.7, 1.0));
  m += 0.25 * ellipseMask(a, vec2(0.0, 6.9), vec2(1.2, 0.8));
  return clamp(m, 0.0, 1.0);
}`;

// Macro albedo for the whole ground, baked once per surface (about 1 cm a texel at high): court colours, wear,
// scuffs, prints and patches. Alpha carries a roughness offset (hard, clay; 0.5 = none) or bare earth (grass).
const MACRO = (kind) => `
#define KIND ${kind}
uniform vec3 uInner, uOuter; uniform float uTexel;
${WEAR_GLSL}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
// A tapered, gently curved streak along local x.
float streak(vec2 q, float len, float wid, float bend) {
  float t = clamp(abs(q.x) / (0.5 * len), 0.0, 1.0), wd = wid * sqrt(1.0 - t * t) + 1e-4;
  return 1.0 - smoothstep(wd * 0.4, wd, abs(q.y - bend * q.x * q.x));
}
#if KIND == 0
// Rubber from shoes: short dark curved smears, mostly sideways, thick behind the baselines.
float rubber(vec2 w) {
  const float C = 0.32;
  vec2 g = floor(w / C); float m = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 id = g + vec2(i, j), c = (id + 0.5) * C;
    if (hash12(id + 3.7) > 0.03 + 0.95 * baseWear(c)) continue;
    vec2 h = hash22(id + 11.3);
    vec2 q = rot((hash12(id + 7.1) - 0.5) * 1.4) * (w - c - (h - 0.5) * C);
    m = max(m, streak(q, 0.1 + 0.55 * h.x, 0.006 + 0.018 * h.y, (hash12(id + 5.9) - 0.5) * 4.0) * (0.3 + 0.7 * hash12(id + 9.2)));
  }
  return m;
}
#elif KIND == 1
// Shoe prints: sole and heel pressed in (x) with a pushed-up rim (y) and herringbone tread when the texture can hold it.
vec2 prints(vec2 w, float tread) {
  const float C = 0.45;
  vec2 g = floor(w / C), res = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 id = g + vec2(i, j), c = (id + 0.5) * C;
    float p = (abs(c.x) < 6.5 && abs(c.y) < 14.5) ? 0.04 + 0.85 * baseWear(c) : 0.01;
    if (hash12(id + 1.3) > p) continue;
    vec2 h = hash22(id + 2.9);
    vec2 q = rot(hash12(id + 4.4) * 6.2832) * (w - c - (h - 0.5) * C * 0.8);
    float d = min(length((q - vec2(0.045, 0.0)) / vec2(0.1, 0.048)), length((q + vec2(0.09, 0.0)) / vec2(0.055, 0.04)));
    float keep = hash12(id + 6.6) < 0.3 ? smoothstep(-0.02, 0.03, q.x) : 1.0;   // push-offs leave only the forefoot
    float sole = (1.0 - smoothstep(0.85, 1.0, d)) * keep;
    float rim = smoothstep(0.9, 1.02, d) * (1.0 - smoothstep(1.02, 1.3, d)) * keep;
    float tr = 0.5 + 0.5 * sin((q.x + abs(q.y) * 0.9) * 260.0);
    float age = 0.4 + 0.6 * hash12(id + 8.8);
    res = max(res, vec2(sole * (0.75 + 0.25 * mix(1.0, tr, tread)), rim) * age);
  }
  return res;
}
// Slides: long scraped streaks with grooves (x) and the clay they push up at the end (y).
vec2 slides(vec2 w) {
  const float C = 1.1;
  vec2 g = floor(w / C), res = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 id = g + vec2(i, j), c = (id + 0.5) * C;
    float p = 0.75 * baseWear(c) + ((abs(c.x) < 5.0 && abs(c.y) < 12.0) ? 0.04 : 0.0);
    if (hash12(id + 12.1) > p) continue;
    vec2 h = hash22(id + 13.7);
    float ang = (hash12(id + 14.2) - 0.5) * 1.2 + (hash12(id + 15.5) < 0.5 ? 0.0 : 3.1416);
    vec2 q = rot(ang) * (w - c - (h - 0.5) * C * 0.6);
    float len = 0.5 + 0.8 * h.x, wid = 0.05 + 0.04 * h.y;
    float s = streak(q, len, wid, (hash12(id + 16.1) - 0.5) * 0.6) * (0.75 + 0.25 * sin(q.y / wid * 9.0));
    vec2 e = (q - vec2(0.5 * len + 0.02, 0.0)) / vec2(0.07, wid * 1.4);
    res = max(res, vec2(s, exp(-dot(e, e) * 2.0)) * (0.4 + 0.6 * hash12(id + 17.3)));
  }
  return res;
}
float roundedRect(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
#else
// Grass wear: bald behind the baselines, at the return spots, just inside the baseline and a track to the T.
float grassWear(vec2 w) {
  vec2 a = abs(w);
  float m = ellipseMask(a, vec2(0.0, 12.35), vec2(3.4, 1.25));
  m = max(m, 0.85 * ellipseMask(a, vec2(3.1, 12.9), vec2(1.3, 0.9)));
  m = max(m, 0.65 * ellipseMask(a, vec2(0.0, 11.2), vec2(1.5, 0.8)));
  m = max(m, 0.35 * ellipseMask(a, vec2(0.0, 6.5), vec2(0.8, 1.0)));
  return m;
}
#endif
void main() {
  vec2 w = vec2(vUv.x * 24.0 - 12.0, 22.0 - vUv.y * 44.0), a = abs(w);
  // The court colour ends under the middle of the outer lines, so filtering never shows a fringe beside the paint.
  vec3 c = (a.x <= ${f4(COURT.halfDW - LINES.w / 2)} && a.y <= ${f4(COURT.halfL - LINES.base / 2)}) ? uInner : uOuter;
  float wear = clamp(baseWear(w) * (0.6 + 0.8 * fbm(w * 1.2 + 2.0)), 0.0, 1.0);
#if KIND == 0
  // acrylic: re-coat patches, squeegee passes laid down the court, sand speckle, polished and rubber-marked wear
  c *= 1.0 + (fbm(w * 0.25) - 0.5) * 0.07;
  float sq = w.x / 1.05 + (fbm(w * 0.3) - 0.5) * 0.3;
  c *= 1.0 + (hash12(vec2(floor(sq), 3.0)) - 0.5) * 0.035;
  c *= 1.0 - 0.025 * (1.0 - smoothstep(0.0, 0.04, min(fract(sq), 1.0 - fract(sq))));
  c *= 1.0 + (hash12(floor(w * 100.0)) - 0.5) * 0.04;
  vec3 polished = mix(c, vec3(dot(c, vec3(0.3, 0.59, 0.11))), 0.25) * 1.22 + 0.008;
  c = mix(c, polished, wear * 0.5);
  c *= 1.0 - pow(vnoise(vec2(w.x * 0.45, w.y * 2.6) + 3.0), 4.0) * wear * 0.3;
  float r = rubber(w);
  c = mix(c, vec3(0.016, 0.018, 0.022), r * 0.5);
  gl_FragColor = vec4(c, 0.5 - 0.16 * wear + 0.1 * r);
#elif KIND == 1
  // clay: tonal patches, damp watered patches, drag-mat passes looping the court, loose and packed wear, prints, slides
  c *= 1.0 + (fbm(w * 0.2) - 0.5) * 0.12;
  float damp = smoothstep(0.52, 0.72, fbm(w * 0.14 + 7.0) + (fbm(w * 1.6) - 0.5) * 0.12);
  c = mix(c, c * vec3(0.8, 0.74, 0.72), damp * 0.75);
  float tread = 1.0 - smoothstep(0.012, 0.022, uTexel);
  float rr = roundedRect(w, vec2(2.5, 8.5), 3.5) / 1.9 + (fbm(w * 0.18) - 0.5) * 0.7, pf = fract(rr);
  c *= 1.0 + (vnoise(vec2(rr * 1.9 * 38.0, (w.x - w.y) * 0.7)) - 0.5) * 0.08 * (1.0 - 0.6 * wear) * (0.4 + 0.6 * tread);
  c *= 1.0 + 0.045 * (1.0 - smoothstep(0.0, 0.03, min(pf, 1.0 - pf))) * (1.0 - wear);
  float loose = smoothstep(0.38, 0.7, fbm(w * 3.0 + 9.0)) * wear;
  c = mix(c, c * vec3(1.12, 1.08, 1.04) + 0.006, loose * 0.8);
  c = mix(c, c * 0.88, wear * (1.0 - loose) * 0.3);
  vec2 pr = prints(w, tread), sl = slides(w);
  c *= (1.0 - pr.x * 0.14) * (1.0 + pr.y * 0.1) * (1.0 - sl.x * 0.15);
  c = mix(c, c * 1.12 + 0.008, sl.y * 0.7);
  c *= 1.0 + (hash12(floor(w * 90.0)) - 0.5) * 0.08;
  gl_FragColor = vec4(c, 0.5 - damp * 0.2 + loose * 0.08 - pr.x * 0.08 - sl.x * 0.1);
#else
  // grass: colour variation, drier patches, thinning and bare earth where the players stand
  c *= 1.0 + (fbm(w * 0.35) - 0.5) * 0.16;
  c = mix(c, c * vec3(1.12, 1.06, 0.66), smoothstep(0.55, 0.8, fbm(w * 0.22 + 5.0)) * 0.3);
  float gw = grassWear(w), n1 = fbm(w * 1.7 + 3.0) - 0.5, n2 = fbm(w * 7.0) - 0.5;
  float bare = smoothstep(0.45, 0.6, gw + n1 * 0.5 + n2 * 0.22);
  float thin = clamp(smoothstep(0.18, 0.45, gw + n1 * 0.5) - bare, 0.0, 1.0);
  float tuft = smoothstep(0.6, 0.78, vnoise(w * 24.0 + 3.0)) * (1.0 - smoothstep(0.7, 0.95, gw));
  vec3 earth = srgb2lin(vec3(0.6, 0.5, 0.36)) * (0.82 + 0.36 * fbm(w * 4.0)) * (1.0 - 0.18 * smoothstep(0.7, 1.0, gw));
  c = mix(c, c * vec3(1.16, 1.1, 0.7), thin * 0.75);
  float b = bare * (1.0 - tuft * 0.75);
  c = mix(c, earth, b);
  gl_FragColor = vec4(c, clamp(b + thin * 0.3, 0.0, 1.0));
#endif
}`;

// Tiling micro detail for each surface (see detailTexture): height for the bumps, micro albedo and roughness.
const DETAIL = {
  // acrylic: fine sand grains in the paint, their tops polished smoother
  hard: `
    float height(vec2 uv) { float g = 1.0 - tcell(uv * 330.0, vec2(330.0)); return 0.45 * g * g + 0.35 * tnoise(uv * 512.0, vec2(512.0)) + 0.2 * tnoise(uv * 64.0, vec2(64.0)); }
    vec2 micro(vec2 uv) {
      vec2 c = tcellId(uv * 330.0, vec2(330.0)); float g = 1.0 - c.x;
      return vec2(0.5 + (g - 0.5) * 0.2 + (c.y - 0.5) * 0.12, 0.5 + (0.5 - g) * 0.35 + (tnoise(uv * 40.0, vec2(40.0)) - 0.5) * 0.3);
    }`,
  // crushed brick: granules of varied tone, fine grit and the scratches of the drag mat
  clay: `
    float brush(vec2 uv) { return tnoise(vec2(uv.x * 8.0, uv.y * 420.0), vec2(8.0, 420.0)); }
    float height(vec2 uv) { float g = 1.0 - tcell(uv * 260.0, vec2(260.0)); return 0.45 * g * g + 0.25 * tnoise(uv * 700.0, vec2(700.0)) + 0.3 * brush(uv); }
    vec2 micro(vec2 uv) {
      vec2 c = tcellId(uv * 260.0, vec2(260.0)); float g = 1.0 - c.x;
      float tone = (c.y - 0.5) * 0.5 * smoothstep(0.1, 0.5, g) + (tnoise(uv * 700.0, vec2(700.0)) - 0.5) * 0.3 + (brush(uv) - 0.5) * 0.2;
      return vec2(0.5 + tone * 0.6, 0.5 + (0.5 - g) * 0.2 + (c.y - 0.5) * 0.2);
    }`,
  // turf seen from above: overlapping blades 1.5-3.5 mm wide, lit by height, dark soil and shadow between them
  grass: `
    vec4 blades(vec2 uv) {
      const float N = 60.0;
      vec2 p = uv * N, g = floor(p); vec4 top = vec4(0.0, 0.0, 0.0, 0.0);
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) for (int k = 0; k < 2; k++) {
        vec2 id = mod(g + vec2(i, j), N) + float(k) * 97.0;
        vec2 h = hash22(id * 1.7), h2 = hash22(id * 2.3 + 5.0);
        vec2 d = p - (g + vec2(i, j) + h); float an = h2.x * 3.1416, cs = cos(an), sn = sin(an);
        vec2 q = vec2(cs * d.x + sn * d.y, -sn * d.x + cs * d.y);
        float len = 0.6 + 0.8 * h2.y, wid = 0.1 + 0.12 * hash12(id + 3.3), t = clamp(q.x / len, -1.0, 1.0);
        float wd = wid * sqrt(max(1.0 - t * t, 0.0));
        float b = 1.0 - smoothstep(wd * 0.5, wd + 0.02, abs(q.y));
        float hg = (0.4 + 0.6 * hash12(id + 9.1)) * b * (0.85 + 0.15 * t);
        if (hg > top.x) top = vec4(hg, hash12(id + 4.4), t, b);
      }
      return top;
    }
    float height(vec2 uv) { return blades(uv).x; }
    vec2 micro(vec2 uv) {
      vec4 b = blades(uv);
      float lit = 0.3 + 0.3 * b.y + 0.25 * b.x + 0.1 * b.z;
      return vec2(mix(0.12, lit, b.w), mix(0.72, 0.45, b.w));
    }`,
};

// The ground's shading: macro texture + two rotated copies of the micro detail (high+), painted lines evaluated
// analytically (exact ITF geometry, filtered over each pixel's footprint, so they never shimmer or z-fight), and
// grass stripes that swap light and dark with the viewing direction like mown turf.
function groundMaterial(kind, macro, detail, hq) {
  const L = LOOK[kind], { halfL, halfSW, halfDW, svc } = COURT;
  const mat = new THREE.MeshStandardMaterial({ roughness: L.rough, metalness: 0, envMapIntensity: L.env });
  mat.defines.COURT_KIND = KIND[kind];
  if (hq) mat.defines.COURT_HQ = '';
  const uniforms = {
    uMacro: { value: macro }, uDetail: { value: detail }, uTile: { value: L.tile }, uRough: { value: L.rough },
    uLineRough: { value: L.lineRough }, uLine: { value: linear(L.line) }, uWobble: { value: L.wobble },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCourtW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvCourtW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vCourtW;
        uniform sampler2D uMacro, uDetail; uniform float uTile, uRough, uLineRough, uWobble; uniform vec3 uLine;
        ${NOISE_GLSL}
        ${WEAR_GLSL}
        float cov1(float x, float a, float b, float f) { return clamp((min(b, x + 0.5 * f) - max(a, x - 0.5 * f)) / f, 0.0, 1.0); }
        float box(vec2 p, vec4 r, vec2 f, float e) { return cov1(p.x, r.x - e, r.y + e, f.x) * cov1(p.y, r.z - e, r.w + e, f.y); }
        // Paint coverage at p = (|x|, |z|) over a pixel footprint f; e grows every line by e metres.
        float courtLines(vec2 p, vec2 f, float e) {
          const float HL = ${f4(halfL)}, HS = ${f4(halfSW)}, HD = ${f4(halfDW)}, SV = ${f4(svc)}, LW = ${f4(LINES.w)}, BW = ${f4(LINES.base)}, MK = ${f4(LINES.mark)};
          float c = box(p, vec4(-HD, HD, HL - BW, HL), f, e);                            // baselines
          c = max(c, box(p, vec4(HD - LW, HD, -HL, HL), f, e));                        // doubles sidelines
          c = max(c, box(p, vec4(HS - LW, HS, -HL, HL), f, e));                        // singles sidelines
          c = max(c, box(p, vec4(-HS, HS, SV - LW, SV), f, e));                        // service lines
          c = max(c, box(p, vec4(-0.5 * LW, 0.5 * LW, -SV, SV), f, e));                // centre service line
          return max(c, box(p, vec4(-0.5 * LW, 0.5 * LW, HL - BW - MK, HL - BW), f, e)); // centre marks
        }`)
      .replace('#include <map_fragment>', `
        vec2 w = vCourtW.xz;
        vec2 fp = max(vec2(length(vec2(dFdx(w.x), dFdy(w.x))), length(vec2(dFdx(w.y), dFdy(w.y)))), vec2(1e-4));
        float px = max(fp.x, fp.y);
        vec4 mac = texture2D(uMacro, vec2((w.x + 12.0) / 24.0, (22.0 - w.y) / 44.0));
        vec4 det = texture2D(uDetail, w / uTile);
        #ifdef COURT_HQ
          // a second, rotated copy of the detail takes over in patches, so its tiling never lines up
          vec4 det2 = texture2D(uDetail, mat2(0.8, 0.6, -0.6, 0.8) * w / uTile + 0.37);
          det = mix(det, det2, smoothstep(0.3, 0.7, vnoise(w * 0.7 + 5.0)));
        #endif
        vec2 nd = det.rg * 2.0 - 1.0;
        float ma = det.b - 0.5, mr = det.a - 0.5, lw = baseWear(w);
        vec3 col = mac.rgb; float rough = uRough;
        #if COURT_KIND == 0
          col *= 1.0 + ma * 0.35;
          rough += (mac.a - 0.5) + mr * 0.25;
        #elif COURT_KIND == 1
          col *= 1.0 + ma * 0.5;
          rough += (mac.a - 0.5) * 0.6 + mr * 0.15;
        #else
          float bare = mac.a;
          // Mown stripes: blades laid towards the viewer look dark, laid away look light; faint from the side.
          float sp = w.y / 1.1885, sw = max(fp.y / 1.1885 * 3.1416 * 1.5, 0.06);
          float stripe = clamp(sin(3.1416 * sp) / sw, -1.0, 1.0);
          vec3 V = normalize(cameraPosition - vCourtW);
          col *= 1.0 - stripe * 0.1 * V.z * (1.0 - 0.4 * V.y) * (1.0 - bare);
          col *= 1.0 + ma * mix(0.9, 0.35, bare);
          nd *= 1.0 - 0.5 * bare;
          rough += mr * 0.2 + bare * 0.1;
        #endif
        // painted lines
        vec2 p = abs(w);
        #ifdef COURT_HQ
          p += (vec2(vnoise(w * vec2(90.0, 23.0)), vnoise(w * vec2(23.0, 90.0) + 7.0)) - 0.5) * uWobble * (1.0 - smoothstep(0.002, 0.008, px));
        #endif
        float lc = courtLines(p, fp * 1.25, 0.0);
        vec3 lcol = uLine; float lrough = uLineRough, lnorm = 0.35;
        #if COURT_KIND == 0
          lcol *= (1.0 + ma * 0.08) * (1.0 - 0.14 * lw * smoothstep(0.4, 0.8, vnoise(w * 12.0)));   // scuffed where they stand
          lrough += mr * 0.1;
        #elif COURT_KIND == 1
          // tapes sit a little proud: a thin shadow gap along their edges, clay dust swept over them
          float gap = clamp(courtLines(p, fp * 1.25, 0.004) - lc, 0.0, 1.0);
          col *= 1.0 - 0.3 * gap;
          float dust = clamp(smoothstep(0.35, 0.95, vnoise(w * 3.0) * 0.55 + det.b * 0.35 + lw * 0.45), 0.0, 1.0);
          lcol = mix(lcol, mac.rgb * 1.15, dust * 0.6);
          lrough = mix(lrough, 0.92, dust); lnorm = mix(0.2, 0.8, dust);
        #else
          // chalk on the blades: patchy up close, rubbed off at the baseline centre
          lc *= mix(0.78 + 0.22 * smoothstep(-0.2, 0.15, ma), 0.95, bare) * (1.0 - 0.45 * lw * smoothstep(0.35, 0.7, vnoise(w * 6.0)));
          lnorm = 0.8;
        #endif
        col = mix(col, lcol, lc);
        rough = mix(rough, lrough, lc);
        nd *= mix(1.0, lnorm, lc);
        rough = clamp(rough + 0.06 * smoothstep(0.01, 0.1, px), 0.3, 1.0);   // flattened distant bumps still scatter
        diffuseColor.rgb = col;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rough;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(normalize(vec3(nd.x, 1.0, nd.y)), 0.0)).xyz);');
  };
  mat.customProgramCacheKey = () => `court-${kind}-${hq ? 1 : 0}`;
  return mat;
}

const group = new THREE.Group();
const Surface = { kind: null, tier: -1, mesh: null };
const tier = () => Perf.cfg().detail | 0;
const disposeTex = (t) => (t.renderTarget ? t.renderTarget.dispose() : t.dispose());

function disposeSurface() {
  const s = Surface;
  if (!s.mesh) return;
  group.remove(s.mesh);
  s.mesh.geometry.dispose(); s.mesh.material.dispose(); disposeTex(s.macro); disposeTex(s.detail);
  s.mesh = null; s.kind = null;
}
// Textures are made for the current surface and quality only (the macro map is 45 MB at high), and freed on a change.
function buildSurface(kind) {
  disposeSurface();
  const L = LOOK[kind], t = tier(), big = t >= 2, mw = big ? 2048 : 1024;
  const macro = gpuTexture({
    width: mw, height: mw * 2, fragment: MACRO(KIND[kind]), srgb: true, bands: big ? 8 : 2,
    uniforms: { uInner: { value: linear(L.inner) }, uOuter: { value: linear(L.outer) }, uTexel: { value: GROUND.w / mw } },
  });
  const detail = detailTexture({ size: t >= 3 ? 2048 : t >= 1 ? 1024 : 512, glsl: DETAIL[kind], strength: L.normal });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(GROUND.w, GROUND.l), groundMaterial(kind, macro, detail, big));
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  group.add(mesh);
  Object.assign(Surface, { kind, tier: t, mesh, macro, detail });
}

// ---------- net ----------
export const Net3D = { mesh: null, mat: null, hit: new THREE.Vector4(0, 0, -99, 0), dir: { value: 1 }, sticks: [] };
const { netC, netP, postX } = COURT;
// Ripple from a ball hitting the net: pinned at the posts and held stiffer by the cable along the top.
const RIPPLE_GLSL = `
uniform vec4 uHit; uniform float uDir;
float netRipple(vec3 p) {
  float age = uHit.w - uHit.z;
  if (age < 0.0 || age >= 2.5) return 0.0;
  float d = distance(p.xy, uHit.xy);
  float top = ${f4(netC)} + ${f4(netP - netC)} * pow(min(abs(p.x) / ${f4(postX)}, 1.0), 1.6);
  float pin = (1.0 - smoothstep(${f4(postX - 0.6)}, ${f4(postX)}, abs(p.x))) * mix(1.0, 0.35, smoothstep(top - 0.35, top, p.y));
  return uDir * 0.1 * pin * exp(-age * 3.2) * exp(-d * 1.4) * cos(age * 22.0 - d * 9.0);
}`;
// Cord mask for the 4.5 cm mesh: thin cords on the cell edges, knots where they cross, a bound edge at each post.
// Far away, where cells are smaller than a pixel, it fades to the mesh's average cover instead of shimmering.
const CORD_GLSL = `
float netCover(vec2 uv) {
  vec2 cell = uv / 0.045, f = abs(fract(cell) - 0.5), fw = fwidth(cell);
  vec2 lines = smoothstep(0.5 - 0.055 - fw, 0.5 - 0.055 + fw, f);
  float knot = 1.0 - smoothstep(0.1 - fw.x, 0.1 + fw.x, length(0.5 - f));
  float cover = max(max(lines.x, lines.y), knot);
  cover = max(cover, smoothstep(${f4(postX - 0.1)}, ${f4(postX - 0.09)}, abs(uv.x)));
  return mix(cover, 0.26, clamp(max(fw.x, fw.y) * 1.6 - 0.25, 0.0, 1.0));
}`;
function rippled(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uHit = { value: Net3D.hit }; sh.uniforms.uDir = Net3D.dir;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + RIPPLE_GLSL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.z += netRipple(position);');
  };
  return mat;
}
// White tape folded over the cable: a U-shaped band 6 cm deep and 1.4 cm thick, swept along the sag of the net.
function tapeGeometry(n = 128) {
  const t = 0.007, depth = 0.06, prof = [[t, -depth]];
  for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI; prof.push([Math.cos(a) * t, -t + Math.sin(a) * t]); }
  prof.push([-t, -depth]);
  const pos = [], idx = [], m = prof.length;
  for (let i = 0; i <= n; i++) {
    const x = lerp(-postX, postX, i / n), h = netHeight(x);
    for (const [z, dy] of prof) pos.push(x, h + dy, z);
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    const a = i * m + j, b = i * m + ((j + 1) % m), c = a + m, d = b + m;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
function buildNet() {
  const g = new THREE.Group(), segX = 96, segY = 10;
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= segY; j++) for (let i = 0; i <= segX; i++) {
    const x = lerp(-postX, postX, i / segX), top = netHeight(x) - 0.03, y = lerp(0.03, top, j / segY);
    pos.push(x, y, 0); uv.push(x, y);
  }
  for (let j = 0; j < segY; j++) for (let i = 0; i < segX; i++) {
    const a = j * (segX + 1) + i, b = a + 1, c = a + segX + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx); geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x15191c, roughness: 0.85, side: THREE.DoubleSide, transparent: true, depthWrite: false });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uHit = { value: Net3D.hit }; sh.uniforms.uDir = Net3D.dir;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vNetUv;\n' + RIPPLE_GLSL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvNetUv = uv;\ntransformed.z += netRipple(position);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vNetUv;\n' + CORD_GLSL)
      .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
        diffuseColor.a *= netCover(vNetUv);`);
  };
  const net = new THREE.Mesh(geo, mat);
  net.renderOrder = 2;
  // The mesh casts a soft, see-through shadow: shadow texels are dropped in a fixed dither at the mesh's cover.
  const depth = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
  depth.onBeforeCompile = (sh) => {
    sh.uniforms.uHit = { value: Net3D.hit }; sh.uniforms.uDir = Net3D.dir;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vNetUv;\n' + RIPPLE_GLSL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvNetUv = uv;\ntransformed.z += netRipple(position);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vNetUv;\nfloat netHash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (netHash(floor(vNetUv / 0.02)) > 0.3) discard;');
  };
  net.customDepthMaterial = depth;
  net.castShadow = true;
  g.add(net);
  Net3D.mesh = net; Net3D.mat = mat;
  const white = rippled(new THREE.MeshStandardMaterial({ color: 0xf6f6f1, roughness: 0.62 }));
  const tape = new THREE.Mesh(tapeGeometry(), white);
  tape.castShadow = true;
  g.add(tape);
  // Centre strap over the tape down to its ground anchor (geometry in world coordinates so it ripples with the net).
  const strapGeo = new THREE.BoxGeometry(0.05, netC - 0.016, 0.018, 1, 8, 1);
  strapGeo.translate(0, 0.02 + (netC - 0.016) / 2, 0);
  const strap = new THREE.Mesh(strapGeo, white);
  strap.castShadow = true;
  g.add(strap);
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a4, roughness: 0.35, metalness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.5, metalness: 0.6 });
  const anchor = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.03, 12), dark);
  anchor.position.set(0, 0.015, 0);
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.035, 0.024), dark);
  buckle.position.set(0, 0.22, 0);
  g.add(anchor, buckle);
  // Posts: round, 2 cm above the tape, on a ground sleeve; one carries the winder and its crank.
  const postMat = new THREE.MeshStandardMaterial({ color: 0x163a31, roughness: 0.38, metalness: 0.45 });
  const postH = netP + 0.02;
  for (const s of [-1, 1]) {
    const x = s * postX, add = (geo, m, px, py, pz, rx = 0, rz = 0) => {
      const o = new THREE.Mesh(geo, m); o.position.set(px, py, pz); o.rotation.set(rx, 0, rz); o.castShadow = true; o.receiveShadow = true; g.add(o); return o;
    };
    add(new THREE.CylinderGeometry(0.045, 0.045, postH, 24), postMat, x, postH / 2, 0);
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.016, 24), postMat, x, postH + 0.008, 0);
    add(new THREE.SphereGeometry(0.05, 20, 6, 0, Math.PI * 2, 0, Math.PI / 2), postMat, x, postH + 0.016, 0).scale.y = 0.3;
    add(new THREE.CylinderGeometry(0.068, 0.072, 0.012, 24), steel, x, 0.006, 0);
    if (s > 0) {
      const ox = x + 0.045;
      add(new THREE.BoxGeometry(0.04, 0.13, 0.07), postMat, ox + 0.015, 0.93, 0);                       // gear housing
      add(new THREE.CylinderGeometry(0.009, 0.009, 0.05, 10), steel, ox + 0.055, 0.95, 0, 0, Math.PI / 2);   // spindle
      add(new THREE.BoxGeometry(0.014, 0.13, 0.016), steel, ox + 0.08, 0.9, 0.02, 0.35, 0);              // crank arm
      add(new THREE.CylinderGeometry(0.012, 0.012, 0.075, 10), dark, ox + 0.115, 0.845, 0.04, 0, Math.PI / 2);   // handle
    }
  }
  // Singles sticks, 0.914 m outside the singles sidelines, holding the net up under the tape.
  for (const s of [-1, 1]) {
    const x = s * (COURT.halfSW + 0.914), h = netHeight(x) - 0.004;
    const stick = new THREE.Mesh(new THREE.BoxGeometry(0.05, h, 0.05), postMat);
    stick.position.set(x, h / 2, 0); stick.castShadow = true; stick.receiveShadow = true;
    g.add(stick); Net3D.sticks.push(stick);
  }
  scene.add(g);
}

// ---------- ball and slide marks ----------
// Greyscale maps with alpha: a ball mark is an oval with a darker rim and skid streaks, a slide mark a tapered
// grooved scrape with the clay it pushed up at the leading end (the canvas bottom).
function markTexture(w, h, shade) {
  return canvasTex(w, h, (g) => {
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = ((x + 0.5) / w) * 2 - 1, v = ((y + 0.5) / h) * 2 - 1, [l, a] = shade(u, v, Math.random());
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(255 * Math.min(1, Math.max(0, l)));
      img.data[i + 3] = Math.round(255 * Math.min(1, Math.max(0, a)));
    }
    g.putImageData(img, 0, 0);
  });
}
const sst = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
let markTex = null, skidTex = null;
function markTextures() {
  if (markTex) return;
  markTex = markTexture(64, 128, (u, v, r) => {
    const d = Math.hypot(u, v) + (r - 0.5) * 0.06;
    const rim = sst(0.62, 0.85, d) * (1 - sst(0.9, 1.0, d));
    return [0.88 + 0.08 * Math.sin(u * 23 + r) - 0.28 * rim, 1 - sst(0.88, 1.0, d)];
  });
  skidTex = markTexture(64, 256, (u, v, r) => {
    const t = (1 - v) / 2, wd = Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(v) * 1.05, 2))) * (0.75 + 0.25 * t);
    const inside = 1 - sst(wd * 0.7, wd, Math.abs(u) + (r - 0.5) * 0.08);
    const pile = Math.exp(-Math.pow((v - 0.82) / 0.12, 2)) * (1 - sst(0.6, 1.0, Math.abs(u)));
    return [0.72 + 0.14 * Math.sin(u * 30) + 0.4 * pile + (r - 0.5) * 0.1, Math.max(inside * (0.45 + 0.55 * (1 - t)), pile)];
  });
}
const MARK = { clay: [0xb4633f, 0.6], grass: [0x8fae62, 0.28], hard: [0xc8c6b8, 0.1] };
const Marks = { list: [], i: 0, mat: null, surface: 'hard' };
function buildMarks() {
  markTextures();
  Marks.mat = new THREE.MeshStandardMaterial({ map: markTex, color: 0x7a391c, roughness: 1, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  const geo = new THREE.CircleGeometry(0.5, 20);
  for (let k = 0; k < 24; k++) {
    const m = new THREE.Mesh(geo, Marks.mat.clone());
    m.rotation.x = -Math.PI / 2; m.position.y = 0.006; m.visible = false; m.receiveShadow = true;
    scene.add(m); Marks.list.push(m);
  }
}
export function addBallMark(x, z, vx, vz, surface) {
  const m = Marks.list[Marks.i++ % Marks.list.length];
  const sp = Math.hypot(vx, vz), [col, op] = MARK[surface] || MARK.hard;
  m.visible = true; m.position.x = x; m.position.z = z;
  m.rotation.z = Math.atan2(vx, vz);
  m.scale.set(0.066, 0.1 + Math.min(0.1, sp * 0.004), 1);
  m.material.color.set(col); m.material.opacity = op;
  m.userData.born = performance.now();
}
// Slide marks on clay: long scuffs where a player brakes hard, pooled like the ball marks.
const Skids = { list: [], i: 0 };
export function addSkidMark(x, z, dx, dz, len) {
  if (!Skids.list.length) {
    markTextures();
    const geo = new THREE.CircleGeometry(0.5, 20), mat = new THREE.MeshStandardMaterial({ map: skidTex, color: 0xb8653f, roughness: 1, transparent: true, opacity: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    for (let k = 0; k < 30; k++) { const m = new THREE.Mesh(geo, mat); m.rotation.x = -Math.PI / 2; m.position.y = 0.006; m.visible = false; m.receiveShadow = true; scene.add(m); Skids.list.push(m); }
  }
  const m = Skids.list[Skids.i++ % Skids.list.length];
  m.visible = true; m.position.x = x; m.position.z = z;
  m.rotation.z = Math.atan2(dx, dz);
  m.scale.set(0.13, len, 1);
}
export function clearBallMarks() { for (const m of Marks.list) m.visible = false; for (const m of Skids.list) m.visible = false; }

export const World = {
  surface: null,
  init() {
    scene.add(group); buildNet(); buildMarks();
    // A new quality preset rebuilds the court textures at the matching size and detail.
    Perf.onChange(() => { if (this.surface && Surface.tier !== tier()) buildSurface(this.surface); });
  },
  setSurface(kind) {
    if (kind === this.surface) return;
    this.surface = kind;
    buildSurface(kind);
    clearBallMarks();
    for (const fn of this.listeners) fn(kind);
  },
  // Singles sticks are on by default (a singles match on a doubles court).
  setSinglesSticks(on) { for (const s of Net3D.sticks) s.visible = !!on; },
  listeners: [],
  onChange(fn) { this.listeners.push(fn); },
  netHit(x, y, t, dir) { Net3D.hit.set(x, y, t, t); Net3D.dir.value = dir < 0 ? -1 : 1; },
  update(t) {
    const h = Net3D.hit;
    if (h.z > -50) { h.w = t; if (t - h.z > 2.5) h.z = -99; }
  },
};
