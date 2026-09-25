// Sky, sun, shadows, image-based lighting and time of day (day, golden hour, night under floodlights).
import * as THREE from 'three';
import { renderer, scene, Look, Perf, onContextRestored } from './renderer.js';

// ---- Shadow filtering -----------------------------------------------------------------------------------------
// Patched into three's shader chunks at load, before any material compiles:
// - PCF becomes a grid of hardware-filtered taps sized by the light's shadow radius: smooth penumbrae with none of
//   the stock filter's per-pixel noise (which crawls when the camera moves).
// - Each tap's reference depth follows the receiver's plane (from screen-space derivatives), so the flat court
//   needs almost no bias: no acne, and shadows stay attached to the players' feet.
// - The sun gets two cascades: a sharp map fitted to the court and a soft one over the whole stadium, carried by
//   a second, zero-intensity directional light. Fragments use the court map where it covers them and fade to the
//   stadium map at its edge.
const PC_FUNCS = `
		vec2 pcDepthGradient( vec3 c ) {
			vec3 dx = dFdx( c ), dy = dFdy( c );
			float det = dx.x * dy.y - dx.y * dy.x;
			if ( abs( det ) < 1e-14 ) return vec2( 0.0 );
			vec2 g = vec2( dy.y * dx.z - dx.y * dy.z, dx.x * dy.z - dy.x * dx.z ) / det;
			float m = length( g );
			return m > 2.0 ? g * ( 2.0 / m ) : g;   // silhouette pixels have meaningless gradients
		}
		float pcShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, vec2 grad ) {
			vec3 c = shadowCoord.xyz / shadowCoord.w;
			c.z += shadowBias;
			if ( c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0 ) return 1.0;
			vec2 texel = 1.0 / shadowMapSize;
			float r = max( shadowRadius, 0.5 );
			int n = int( clamp( ceil( r ), 1.0, 4.0 ) ) + 1;
			float stp = 2.0 * r / float( n - 1 ), mid = 0.5 * float( n - 1 ), s = 0.0;
			for ( int y = 0; y < 5; y ++ ) {
				if ( y >= n ) break;
				for ( int x = 0; x < 5; x ++ ) {
					if ( x >= n ) break;
					vec2 o = ( vec2( float( x ), float( y ) ) - mid ) * stp * texel;
					s += texture( shadowMap, vec3( c.xy + o, c.z + dot( grad, o ) ) );
				}
			}
			return mix( 1.0, s / float( n * n ), shadowIntensity );
		}
		float getShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
			return pcShadow( shadowMap, shadowMapSize, shadowIntensity, shadowBias, shadowRadius, shadowCoord, vec2( 0.0 ) );
		}
		float pcStockShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {`;
const PC_SUN = `
#if defined( USE_SHADOWMAP ) && defined( SHADOWMAP_TYPE_PCF ) && NUM_DIR_LIGHT_SHADOWS > 1
float pcSunShadow( DirectionalLightShadow s0, DirectionalLightShadow s1, vec2 g0, vec2 g1, bool wide ) {
	float a = pcShadow( directionalShadowMap[ 0 ], s0.shadowMapSize, s0.shadowIntensity, s0.shadowBias, s0.shadowRadius, vDirectionalShadowCoord[ 0 ], g0 );
	if ( ! wide ) return a;
	vec2 c = vDirectionalShadowCoord[ 0 ].xy / vDirectionalShadowCoord[ 0 ].w, e = min( c, 1.0 - c );
	float w = smoothstep( 0.0, 0.035, min( e.x, e.y ) );
	float b = w < 1.0 ? pcShadow( directionalShadowMap[ 1 ], s1.shadowMapSize, s1.shadowIntensity, s1.shadowBias, s1.shadowRadius, vDirectionalShadowCoord[ 1 ], g1 ) : 1.0;
	return mix( b, a, w );
}
#endif
`;
const DIR_DECL = `	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif`;
const DIR_PREP = DIR_DECL + `
	#if defined( USE_SHADOWMAP ) && defined( SHADOWMAP_TYPE_PCF ) && NUM_DIR_LIGHT_SHADOWS > 0
	vec2 pcG0 = pcDepthGradient( vDirectionalShadowCoord[ 0 ].xyz / vDirectionalShadowCoord[ 0 ].w );
	#if NUM_DIR_LIGHT_SHADOWS > 1
	vec2 pcG1 = pcDepthGradient( vDirectionalShadowCoord[ 1 ].xyz / vDirectionalShadowCoord[ 1 ].w );
	bool pcWide = dot( directionalLights[ 1 ].color, vec3( 1.0 ) ) == 0.0 && dot( directionalLights[ 1 ].direction, directionalLights[ 0 ].direction ) > 0.9999;
	#endif
	#endif`;
const DIR_SHADOW = '		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
const DIR_SHADOW_PC = `		#if ! defined( SHADOWMAP_TYPE_PCF )
${DIR_SHADOW}
		#elif ( UNROLLED_LOOP_INDEX == 0 ) && ( NUM_DIR_LIGHT_SHADOWS > 1 )
		directLight.color *= ( directLight.visible && receiveShadow ) ? pcSunShadow( directionalLightShadow, directionalLightShadows[ 1 ], pcG0, pcG1, pcWide ) : 1.0;
		#elif ( UNROLLED_LOOP_INDEX == 0 )
		directLight.color *= ( directLight.visible && receiveShadow ) ? pcShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ], pcG0 ) : 1.0;
		#else
		directLight.color *= ( directLight.visible && receiveShadow && dot( directLight.color, vec3( 1.0 ) ) > 0.0 ) ? pcShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ], vec2( 0.0 ) ) : 1.0;
		#endif`;
const SPOT_DECL = `	#if defined( USE_SHADOWMAP ) && NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLightShadow;
	#endif`;
const SPOT_PREP = SPOT_DECL + `
	#if defined( USE_SHADOWMAP ) && defined( SHADOWMAP_TYPE_PCF ) && NUM_SPOT_LIGHT_SHADOWS > 0
	vec2 pcGs[ NUM_SPOT_LIGHT_SHADOWS ];
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_SHADOWS; i ++ ) {
		pcGs[ i ] = pcDepthGradient( vSpotLightCoord[ i ].xyz / vSpotLightCoord[ i ].w );
	}
	#pragma unroll_loop_end
	#endif`;
const SPOT_SHADOW = '\t\tdirectLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowIntensity, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;';
const SPOT_SHADOW_PC = `		#if defined( SHADOWMAP_TYPE_PCF )
		directLight.color *= ( directLight.visible && receiveShadow ) ? pcShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowIntensity, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ], pcGs[ i ] ) : 1.0;
		#else
${SPOT_SHADOW}
		#endif`;
const PCF_SIG = '		float getShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {';
function patchShadows() {
  const C = THREE.ShaderChunk, once = (s, a) => s.split(a).length === 2;
  const pars = C.shadowmap_pars_fragment, lights = C.lights_fragment_begin;
  if (!once(pars, PCF_SIG) || !once(lights, DIR_DECL) || !once(lights, DIR_SHADOW) || !once(lights, SPOT_DECL) || !once(lights, SPOT_SHADOW)) {
    console.warn('Palm Court: shadow shader patch skipped (three.js chunks changed); using stock shadows.');
    return false;
  }
  C.shadowmap_pars_fragment = pars.replace(PCF_SIG, PC_FUNCS) + PC_SUN;
  C.lights_fragment_begin = lights.replace(DIR_DECL, DIR_PREP).replace(DIR_SHADOW, DIR_SHADOW_PC).replace(SPOT_DECL, SPOT_PREP).replace(SPOT_SHADOW, SPOT_SHADOW_PC);
  return true;
}
const CASCADES = patchShadows();

// Receivers each sun shadow map must cover (x0, x1, y0, y1, z0, z1): the court with its run-off, and the stadium.
const COURT_BOX = [-12.5, 12.5, 0, 2.6, -22.5, 22.5];
const BOWL_BOX = [-48, 48, 0, 26, -58, 58];

// ---- Sky ------------------------------------------------------------------------------------------------------
// An art-directed analytic sky: horizon-to-zenith gradient, warm glow in the air towards the sun, Mie-like halo,
// limb-darkened sun disc, drifting two-layer clouds lit from the sun side with silver linings, and at night stars
// (a separate point cloud), a moon, the city's glow and the floodlights' haze over the stadium. All in linear HDR
// so bloom picks up the sun and the probe can reuse the same shader for image-based lighting.
const SkyShader = {
  uniforms: {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSun: { value: new THREE.Color() }, uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
    uGlow: { value: new THREE.Color() }, uHaze: { value: new THREE.Color() }, uCity: { value: new THREE.Color() }, uMoonDir: { value: new THREE.Vector3(0, 1, 0) }, uMoon: { value: 0 },
    uCloudLit: { value: new THREE.Color() }, uCloudDark: { value: new THREE.Color() }, uCloud: { value: new THREE.Vector4(0.4, 0.8, 1, 1) },
    uTime: { value: 0 }, uDisc: { value: 1 }, uScale: { value: 1 }, uSat: { value: 1 }, uHorizonK: { value: 3 },
  },
  vertexShader: `
    varying vec3 vWorld;
    void main() {
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_Position.z = gl_Position.w;   // on the far plane
    }`,
  fragmentShader: `
    uniform vec3 uSunDir, uSun, uZenith, uHorizon, uGlow, uHaze, uCity, uMoonDir, uCloudLit, uCloudDark;
    uniform vec4 uCloud;   // coverage, opacity, scale, drift speed
    uniform float uTime, uDisc, uScale, uSat, uMoon, uHorizonK;
    varying vec3 vWorld;
    vec2 grad2(vec2 i) { vec3 p = fract(i.xyx * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yzx + 33.33); return fract((p.xx + p.yz) * p.zy) * 2.0 - 1.0; }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p), u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
      float a = dot(grad2(i), f), b = dot(grad2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
      float c = dot(grad2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), d = dot(grad2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.6;
    }
    const mat2 ROT = mat2(1.6, 1.2, -1.2, 1.6);
    float fbm(vec2 p, int oct, float drift) {
      float s = 0.0, a = 0.5;
      for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * noise(p); p = ROT * p + drift; a *= 0.5; }
      return s;
    }
    void main() {
      vec3 d = normalize(vWorld - cameraPosition);
      float h = d.y, hp = max(h, 0.0), mu = dot(d, uSunDir);
      // Gradient: a bright, hazy horizon band thinning into the zenith colour.
      // (Mixed in a square-root space, which keeps the golden-hour transition from going muddy pink.)
      vec3 col = mix(sqrt(uHorizon), sqrt(uZenith), 1.0 - exp(-hp * uHorizonK)); col *= col;
      // Warm light in the air towards the sun, strongest low down (golden hour), a wide halo and a tight corona.
      vec2 dh = d.xz / max(length(d.xz), 1e-4), sh = uSunDir.xz / max(length(uSunDir.xz), 1e-4);
      float toward = pow(dot(dh, sh) * 0.5 + 0.5, 3.0), m = max(mu, 0.0);
      col += uGlow * (toward * exp(-hp * 4.0) + 0.45 * pow(m, 6.0));
      col += uSun * (0.012 * pow(m, 60.0) + 0.05 * pow(m, 900.0));
      // Night: floodlight haze in the air over the stadium and the city's glow on the horizon.
      col += uHaze * exp(-hp * 3.5) + uCity * exp(-abs(h) * 14.0);
      // Clouds: a domain-warped fbm on a curved layer, drifting and slowly evolving; lit on the sun side,
      // self-shadowed by the density towards the sun, with silver linings when backlit.
      #ifdef CLOUDS
      if (h > 0.0 && uCloud.x > 0.0) {
        vec2 p = d.xz / (h + 0.12) * uCloud.z + vec2(uTime * uCloud.w, uTime * uCloud.w * 0.35);
        float ev = uTime * uCloud.w * 0.35;
        vec2 q = p + 0.35 * vec2(noise(p * 0.5 + 3.1), noise(p * 0.5 - 7.3));
        float n = fbm(q, CLOUD_OCT, ev) + 0.5;
        float region = noise(p * 0.18 + 11.0) * 0.5 + 0.5;
        float cov = clamp(uCloud.x + (region - 0.5) * 0.5, 0.0, 1.0), th = 1.0 - cov;
        float mask = smoothstep(th, th + 0.28, n) * smoothstep(0.0, 0.1, h);
        float n2 = fbm(q + sh * 0.22, 3, ev) + 0.5;
        float lit = clamp(0.62 + (n - n2) * 2.4 - (n - th) * 0.5, 0.0, 1.0);
        float edge = mask * (1.0 - mask) * 4.0;
        vec3 cc = mix(uCloudDark, uCloudLit, lit) + uSun * 0.02 * pow(m, 5.0) * (0.4 + edge);
        cc = mix(cc, col, 1.0 - smoothstep(0.0, 0.25, h));   // distant clouds fade into the haze
        col = mix(col, cc, mask * uCloud.y);
      }
      #endif
      // Sun disc (limb darkened) and moon, above the horizon only.
      float above = smoothstep(-0.01, 0.01, h);
      float disc = smoothstep(0.999955, 0.999975, mu);
      col += uSun * uDisc * disc * (0.6 + 0.4 * smoothstep(0.999955, 0.99999, mu)) * 30.0 * above;
      float mm = dot(d, uMoonDir);
      col += uMoon * (vec3(1.5, 1.5, 1.42) * smoothstep(0.99992, 0.99995, mm) + vec3(0.05, 0.06, 0.08) * pow(max(mm, 0.0), 300.0)) * above;
      // Below the horizon: a hazy ground colour (hidden by the scenery, but the light probe sees it).
      col = mix(col, uHorizon * 0.45, smoothstep(0.0, -0.08, h));
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      gl_FragColor = vec4(mix(vec3(l), col, uSat) * uScale, 1.0);
    }`,
};

// Linear colours. sunI is the directional light; sky colours are radiance the camera sees; probe scales the sky
// for image-based lighting (sunlit white paint is about 0.8, so a clear sky gives the court roughly a quarter of
// the sun's light) and probeSat desaturates it (real skylight is whiter than the sky looks).
const lin = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
const TOD = {
  day: {
    label: 'Day', elevation: 57, azimuth: 32,
    sky: { zenith: lin(0.05, 0.16, 0.52), horizon: lin(0.5, 0.64, 0.84), glow: lin(0.34, 0.3, 0.24), sun: lin(12, 11.2, 10), horizonK: 2.6,
      cloud: [0.36, 0.88, 2.2, 0.007], cloudLit: lin(1.05, 1.05, 1.04), cloudDark: lin(0.38, 0.45, 0.58) },
    sun: 0xfff3e3, sunI: 3.0, hemiSky: 0xcfe3ff, hemiGround: 0x6d7a5c, hemiI: 0, env: 1, probe: 0.34, probeSat: 0.35, contact: 0.42, envRing: [0.07, 0.075, 0.08], envGround: [0.06, 0.1, 0.08], fog: 0xc9d9e8, fogNear: 160, fogFar: 900,
    look: { exposure: 1.22, bloom: 0.07, bloomThreshold: 3.2, bloomSpread: 0.75, saturation: 1.04, contrast: 1.04, vignette: 0.18, gain: [1.0, 1.0, 1.0], lift: [0, 0, 0.004] },
  },
  golden: {
    label: 'Golden hour', elevation: 24, azimuth: -68,
    sky: { zenith: lin(0.045, 0.12, 0.38), horizon: lin(0.92, 0.66, 0.4), glow: lin(1.4, 0.7, 0.24), sun: lin(14, 8.2, 3.6), horizonK: 3.2,
      cloud: [0.42, 0.9, 2.0, 0.006], cloudLit: lin(1.35, 0.8, 0.46), cloudDark: lin(0.3, 0.26, 0.34) },
    sun: 0xffc38f, sunI: 3.1, hemiSky: 0xbfcbe8, hemiGround: 0x5a4a3c, hemiI: 0, env: 1, probe: 0.3, probeSat: 0.55, contact: 0.4, envRing: [0.08, 0.062, 0.05], envGround: [0.07, 0.058, 0.043], fog: 0xe0b894, fogNear: 160, fogFar: 900,
    look: { exposure: 1.28, bloom: 0.1, bloomThreshold: 2.6, bloomSpread: 0.8, saturation: 1.07, contrast: 1.05, vignette: 0.24, gain: [1.035, 1.0, 0.95], lift: [0.006, 0.002, 0] },
  },
  night: {
    label: 'Night', elevation: 72, azimuth: 20,
    sky: { zenith: lin(0.0015, 0.003, 0.009), horizon: lin(0.012, 0.018, 0.03), glow: lin(0, 0, 0), sun: lin(0, 0, 0), horizonK: 3.5, haze: lin(0.05, 0.055, 0.065), city: lin(0.045, 0.03, 0.016), moon: 1,
      cloud: [0.22, 0.55, 1.8, 0.004], cloudLit: lin(0.03, 0.032, 0.04), cloudDark: lin(0.008, 0.01, 0.015) },
    sun: 0xe8eeff, sunI: 0.35, floods: 1500, floodColor: 0xf4f6ff, hemiSky: 0x3a4a66, hemiGround: 0x1f2226, hemiI: 0.28, env: 0.4, contact: 0.55, envRing: [0.012, 0.014, 0.018], envGround: [0.025, 0.03, 0.034], fog: 0x06090e, fogNear: 60, fogFar: 320,
    look: { exposure: 1.12, bloom: 0.11, bloomThreshold: 2.2, bloomSpread: 0.85, glare: 0.35, glareTint: [0.75, 0.85, 1.0], saturation: 1.06, contrast: 1.07, vignette: 0.3, gain: [0.98, 1.0, 1.04], lift: [0, 0.002, 0.006] },
  },
};
// Floodlight banks on the roof over each corner of the court, aimed across it: four soft, overlapping shadows
// fanning out from each player, as under real stadium lights.
const FLOODS = [[-26, 25, -21], [26, 25, -21], [-26, 25, 21], [26, 25, 21]];

const _eye = new THREE.OrthographicCamera(), _m = new THREE.Matrix4(), _v = new THREE.Vector3();

// Contact shadows: soft dark ellipses on the ground under each foot of every skinned character (players, ball
// kids, line judges), and a wider, fainter one under the body. They ground people where the shadow map is too
// soft to (night floodlights, the low preset, the sun behind a player) and fade out as a foot lifts.
const Contact = {
  mesh: null, people: [], scanAt: -1e9, max: 96, strength: 0.5,
  init() {
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    geo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(new Float32Array(this.max), 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, toneMapped: false,
      vertexShader: `attribute float aAlpha; varying vec2 vUv; varying float vA;
        void main() { vUv = uv; vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec2 vUv; varying float vA;
        void main() { vec2 d = vUv * 2.0 - 1.0; float r = dot(d, d); gl_FragColor = vec4(0.0, 0.0, 0.0, vA * exp(-r * 3.2) * (1.0 - smoothstep(0.7, 1.0, r))); }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.userData.noAO = true;
    scene.add(this.mesh);
  },
  // Characters come and go (menu, practice, a new look rebuilds the mesh), so look for them once a second.
  scan() {
    this.people = [];
    scene.traverse((o) => {
      if (!o.isSkinnedMesh || !o.skeleton) return;
      const b = (n) => o.skeleton.getBoneByName(n);
      const p = { mesh: o, hips: b('hips'), feet: [[b('footL'), b('toeL')], [b('footR'), b('toeR')]] };
      if (p.hips && p.feet.every(([f, t]) => f && t)) this.people.push(p);
    });
  },
  shown(o) { for (; o; o = o.parent) if (!o.visible) return false; return true; },
  update() {
    const now = performance.now();
    if (now - this.scanAt > 1000) { this.scanAt = now; this.scan(); }
    const M = this.mesh, A = M.geometry.attributes.aAlpha, a = _c.a, b = _c.b, k = this.strength;
    let n = 0;
    const put = (x, z, sx, sz, ry, alpha) => {
      if (n >= this.max || alpha < 0.01) return;
      _c.q.setFromAxisAngle(_c.up, ry);
      _c.p.set(x, 0.008, z); _c.s.set(sx, 1, sz);
      M.setMatrixAt(n, _m.compose(_c.p, _c.q, _c.s));
      A.array[n++] = alpha;
    };
    for (const P of this.people) {
      if (!this.shown(P.mesh)) continue;
      P.hips.updateWorldMatrix(true, false);
      a.setFromMatrixPosition(P.hips.matrixWorld);
      if (a.y > 1.6) continue;   // seated up high (the umpire's chair)
      put(a.x, a.z, 0.95, 0.95, 0, k * 0.34 * THREE.MathUtils.clamp(1.6 - a.y, 0, 1));
      for (const [f, t] of P.feet) {
        f.updateWorldMatrix(true, false); t.updateWorldMatrix(true, false);
        a.setFromMatrixPosition(f.matrixWorld); b.setFromMatrixPosition(t.matrixWorld);
        const h = Math.min(a.y, b.y), lift = THREE.MathUtils.clamp(1 - (h - 0.04) / 0.3, 0, 1);
        put((a.x + b.x) / 2, (a.z + b.z) / 2, 0.2 + 0.1 * lift, 0.36, Math.atan2(b.x - a.x, b.z - a.z), k * lift * lift);
      }
    }
    M.count = n;
    if (n) { M.instanceMatrix.needsUpdate = true; A.needsUpdate = true; }
  },
};
const _c = { a: new THREE.Vector3(), b: new THREE.Vector3(), p: new THREE.Vector3(), s: new THREE.Vector3(), q: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0) };

export const Env = {
  tod: null, sky: null, sun: null, sunWide: null, hemi: null, pmrem: null, envRT: null, night: null, stars: null, floods: [], dir: new THREE.Vector3(),
  init() {
    this.sky = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.ShaderMaterial({
      name: 'PalmSky', uniforms: THREE.UniformsUtils.clone(SkyShader.uniforms), vertexShader: SkyShader.vertexShader, fragmentShader: SkyShader.fragmentShader,
      side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false, defines: { CLOUDS: '', CLOUD_OCT: 5 },
    }));
    this.sky.scale.setScalar(1200);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = 100;   // after the opaque scene: early depth rejection skips the sky behind the stands
    scene.add(this.sky);
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    scene.add(this.sun, this.sun.target);
    // The stadium-wide cascade: same direction, no light of its own (see the shadow patch above).
    this.sunWide = new THREE.DirectionalLight(0x000000, 0);
    this.sunWide.castShadow = CASCADES;
    this.sunWide.visible = false;
    this.sunWide.shadow.autoUpdate = false;   // static stands: redrawn when the light or the preset changes, and now and then
    scene.add(this.sunWide, this.sunWide.target);
    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6d7a5c, 0.35);
    scene.add(this.hemi);
    scene.fog = new THREE.Fog(0xc9d9e8, 160, 900);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.buildNight();
    Contact.init();
    Perf.onChange((p) => this.applyShadows(p));
    this.applyShadows(Perf.cfg());   // the first preset was applied before the sun existed
    onContextRestored(() => { const k = this.tod; this.tod = null; this.setTimeOfDay(k || 'day'); });
  },
  // Map sizes, softness and which lights cast shadows, for the preset and the time of day.
  applyShadows(p = Perf.cfg()) {
    const night = this.tod === 'night';
    const size = (s, n) => { if (s.mapSize.x !== n) { s.mapSize.set(n, n); if (s.map) { s.map.dispose(); s.map = null; } } };
    size(this.sun.shadow, p.shadow);
    this.sun.shadow.radius = p.radius;
    // At night the floodlights cast the shadows when the preset can afford them; the overhead key only fills in.
    this.sun.castShadow = !(night && p.floodShadow > 0);
    const wide = CASCADES && p.sunCascade > 0 && !night;
    this.sunWide.visible = wide;
    if (wide) { size(this.sunWide.shadow, p.sunCascade); this.sunWide.shadow.radius = 2.2; this.sunWide.shadow.needsUpdate = true; }
    for (const f of this.floods) {
      f.castShadow = night && p.floodShadow > 0;
      if (f.castShadow) { size(f.shadow, p.floodShadow); f.shadow.radius = p.floodShadow >= 1024 ? 2.0 : 1.4; }
    }
    this.fitShadows();
  },
  // Fit an orthographic shadow camera looking along the sun: its width and height to a box of receivers, its depth
  // to everything that can cast onto them (the whole bowl, so the stands' shadows reach the court at golden hour).
  // 'Up' runs along the court, so the court's long axis fills the map. Returns the size of a texel in metres.
  fitOrtho(light, recv) {
    const cam = light.shadow.camera, dir = this.dir;
    cam.up.set(0, 0, 1);
    if (Math.abs(dir.z) > 0.9) cam.up.set(1, 0, 0);
    light.position.copy(dir).multiplyScalar(150);
    light.target.position.set(0, 0, 0);
    light.updateMatrixWorld(); light.target.updateMatrixWorld();
    _eye.up.copy(cam.up); _eye.position.copy(light.position); _eye.lookAt(0, 0, 0); _eye.updateMatrixWorld();
    _m.copy(_eye.matrixWorld).invert();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const corners = (b, fn) => { for (const x of [b[0], b[1]]) for (const y of [b[2], b[3]]) for (const z of [b[4], b[5]]) fn(_v.set(x, y, z).applyMatrix4(_m)); };
    corners(recv, (v) => { x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); });
    corners(BOWL_BOX, (v) => { z0 = Math.min(z0, -v.z); z1 = Math.max(z1, -v.z); });
    const pad = 0.4;
    Object.assign(cam, { left: x0 - pad, right: x1 + pad, bottom: y0 - pad, top: y1 + pad, near: Math.max(0.5, z0 - 2), far: z1 + 2 });
    cam.updateProjectionMatrix();
    return Math.max(x1 - x0, y1 - y0) / light.shadow.mapSize.x;
  },
  // Biases are in metres per texel: the receiver-plane depth in the filter handles slopes, so only a sliver of
  // constant bias and a texel's worth of normal offset remain (no acne, no shadows floating off the feet).
  fitShadows() {
    if (!this.tod) return;
    const s = this.sun.shadow, t = this.fitOrtho(this.sun, COURT_BOX), span = s.camera.far - s.camera.near;
    s.bias = -0.004 / span; s.normalBias = t * 1.1;
    this.shadowTexel = t;
    if (this.sunWide.visible) {
      const w = this.sunWide.shadow, tw = this.fitOrtho(this.sunWide, BOWL_BOX), sw = w.camera.far - w.camera.near;
      w.bias = -0.02 / sw; w.normalBias = tw * 1.3; w.needsUpdate = true;
    }
    for (const f of this.floods) { f.shadow.bias = -0.00012; f.shadow.normalBias = 0.05; }
  },
  // Stars, a moon and the floodlight banks used for the night session (the night sky itself is the sky shader).
  buildNight() {
    const g = new THREE.Group();
    const n = 1600, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random(), v = Math.random() * 0.94 + 0.06, th = u * Math.PI * 2, ph = Math.acos(v);
      pos.set([Math.cos(th) * Math.sin(ph) * 1000, Math.cos(ph) * 1000, Math.sin(th) * Math.sin(ph) * 1000], i * 3);
      // Fainter towards the horizon, where the stadium and city light wash them out.
      const b = (0.25 + Math.pow(Math.random(), 3) * 0.75) * THREE.MathUtils.smoothstep(v, 0.08, 0.45), warm = Math.random();
      col.set([b * (0.85 + warm * 0.15), b * 0.9, b * (1.0 - warm * 0.15)], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ size: 1.5, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false, toneMapped: false }));
    this.stars.renderOrder = 101;
    this.stars.frustumCulled = false;
    g.add(this.stars);
    g.visible = false;
    scene.add(g);
    this.night = g;
    for (const [x, y, z] of FLOODS) {
      const s = new THREE.SpotLight(0xf4f6ff, 0, 0, 0.62, 0.55, 2);
      s.position.set(x, y, z); s.target.position.set(x * 0.1, 0, z * 0.25);
      s.castShadow = false;
      s.shadow.camera.near = 8; s.shadow.camera.far = 90;
      s.visible = false;
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
    this.night.visible = night;
    this.setSky(this.sky.material.uniforms, T, night);
    this.sun.color.set(T.sun); this.sun.intensity = T.sunI;
    this.sunWide.color.set(0x000000); this.sunWide.intensity = 0;
    this.hemi.color.set(T.hemiSky); this.hemi.groundColor.set(T.hemiGround); this.hemi.intensity = T.hemiI; this.hemi.visible = T.hemiI > 0;
    // Lights left in the scene cost shader time even at zero intensity, so the floods are removed by day.
    for (const f of this.floods) { f.intensity = night ? T.floods : 0; f.color.set(T.floodColor || 0xffffff); f.visible = night; }
    this.applyShadows();
    scene.fog.color.set(T.fog); scene.fog.near = T.fogNear; scene.fog.far = T.fogFar;
    scene.environmentIntensity = T.env;
    Contact.strength = T.contact;
    this.buildEnvironment(T, night);
    Look.set(T.look);
    for (const fn of this.listeners) fn(key);
  },
  setSky(u, T, night) {
    const S = T.sky, black = lin(0, 0, 0);
    u.uSunDir.value.copy(this.dir);
    u.uSun.value.copy(S.sun); u.uZenith.value.copy(S.zenith); u.uHorizon.value.copy(S.horizon); u.uGlow.value.copy(S.glow);
    u.uHaze.value.copy(S.haze || black); u.uCity.value.copy(S.city || black); u.uMoon.value = S.moon || 0;
    u.uMoonDir.value.set(-0.55, 0.52, -0.65).normalize();
    u.uCloudLit.value.copy(S.cloudLit); u.uCloudDark.value.copy(S.cloudDark); u.uCloud.value.set(...S.cloud);
    u.uHorizonK.value = S.horizonK; u.uDisc.value = night ? 0 : 1;
  },
  listeners: [],
  onChange(fn) { this.listeners.push(fn); },
  // Image-based lighting: render the sky, the stands and the ground into a prefiltered cube map, in the same
  // units as the sun light (the sky is scaled down and desaturated for it: see the TOD table).
  buildEnvironment(T, night) {
    const es = new THREE.Scene(), linA = (c) => lin(c[0], c[1], c[2]);
    const sky = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.sky.material.clone());
    sky.scale.setScalar(40);
    const u = sky.material.uniforms;
    this.setSky(u, T, night);
    // No sun disc in the probe: the real sun is the shadowed directional light, and the disc's energy spread
    // through the prefiltered map would light every shadow from the same direction.
    u.uDisc.value = 0; u.uScale.value = night ? 1 : T.probe; u.uSat.value = night ? 1 : T.probeSat; u.uTime.value = 0;
    es.add(sky);
    if (night) {
      // The floodlight banks, as the stands and players see them.
      const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffffff).multiplyScalar(22) });
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + 0.3, m = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.2), lamp);
        m.position.set(Math.cos(a) * 34, 18, Math.sin(a) * 34); m.lookAt(0, 4, 0);
        es.add(m);
      }
    }
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 24, 48, 1, true), new THREE.MeshBasicMaterial({ color: linA(T.envRing), side: THREE.BackSide }));
    ring.position.y = 6;
    es.add(ring);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 32), new THREE.MeshBasicMaterial({ color: linA(T.envGround) }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -1;
    es.add(ground);
    const rt = this.pmrem.fromScene(es, 0.03, 0.1, 200);
    if (this.envRT) this.envRT.dispose();
    this.envRT = rt;
    scene.environment = rt.texture;
    es.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  },
  frame: 0,
  update(t) {
    this.sky.material.uniforms.uTime.value = t;
    try { Contact.update(); } catch (e) { console.warn('Palm Court: contact shadows off:', e); Contact.update = () => {}; }   // decoration must never stop the frame
    // The stadium cascade holds static stands; refresh it every so often for anything that moved (palms, chairs).
    if (this.sunWide.visible && ++this.frame % 30 === 0) this.sunWide.shadow.needsUpdate = true;
  },
};

// Fewer cloud octaves on the low preset.
Perf.onChange((p) => {
  if (!Env.sky) return;
  const m = Env.sky.material, oct = p.detail >= 1 ? 5 : 3;
  if (m.defines.CLOUD_OCT !== oct) { m.defines.CLOUD_OCT = oct; m.needsUpdate = true; }
});

export const TIMES = Object.fromEntries(Object.entries(TOD).map(([k, v]) => [k, v.label]));
