import * as THREE from 'three';
import type { ShaderUniformValue, ThreeThemeDefinition } from './types.js';

function createFractalWorldsUniforms(): Record<string, ShaderUniformValue> {
  const loader = new THREE.TextureLoader();
  const texOpts = {
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearMipmapLinearFilter,
    generateMipmaps: true
  };

  const albedo = loader.load('/textures/lavaAqua.png', undefined, undefined,
    (err) => console.error('FractalWorlds: lavaAqua load error', err));
  Object.assign(albedo, texOpts);

  const specular = loader.load('/textures/specular01.jpg', undefined, undefined,
    (err) => console.error('FractalWorlds: specular load error', err));
  Object.assign(specular, texOpts);

  const blueNoise = loader.load('/textures/bluenoise.png', undefined, undefined,
    (err) => console.error('FractalWorlds: blueNoise load error', err));
  blueNoise.wrapS = blueNoise.wrapT = THREE.RepeatWrapping;
  blueNoise.magFilter = THREE.NearestFilter;
  blueNoise.minFilter = THREE.NearestFilter;
  blueNoise.generateMipmaps = false;

  return {
    uAlbedo: { value: albedo },
    uSpecular: { value: specular },
    uBlueNoise: { value: blueNoise }
  };
}

export const fractalWorldsTheme: ThreeThemeDefinition = {
  id: 'fractal-worlds',
  label: 'FractalWorlds (3D)',
  kind: 'three',
  renderOrder: -93,
  opacity: 0.95,
  fragmentShader: `
  precision highp float;

  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uAccentA;
  uniform vec3 uAccentB;
  uniform float uOpacity;
  uniform sampler2D uAlbedo;
  uniform sampler2D uSpecular;
  uniform sampler2D uBlueNoise;

  // ── Aestrethra Kleinian SDF ──
  // EXACT formula from fractalworlds.io deminified source (webcrack):
  //   k = max(2/r², wBias)  — NOT 2/r² + wBias!
  //   distance = abs(max(len2d-4, -len2d*z/4) / abs(scale) * overallScale)
  //   orbitTrap = vec4(abs(p.xyz), r²) — captured during first 6 iterations
  //   repetition = mod(p+50, 100)-50 — tiles every 100 units
  vec2 aestrethraDE(vec3 p, vec3 rot, float wBias) {
    p = mod(p + 50.0, 100.0) - 50.0;
    float scale = 1.0;
    vec4 orbitTrap = vec4(1e3);
    for (int i = 0; i < 8; i++) {
      p = clamp(p, -rot, rot) * 2.0 - p;
      float r2 = dot(p, p);
      float k = max(2.0 / max(r2, 0.0001), wBias);
      p *= k;
      scale *= k;
      if (i < 6) orbitTrap = min(orbitTrap, vec4(abs(p), r2));
    }
    float len2d = length(p.xy);
    // EXACT DE: abs(max(len2d-4, -len2d*z/4) / abs(scale) * overallScale)
    float d = abs(max(len2d - 4.0, -len2d * p.z / 4.0) / max(abs(scale), 0.001) * 10.0);
    return vec2(d, orbitTrap.w);
  }

  // Overload returning full orbit trap vec4 for texture sampling
  struct DEResult { float dist; vec4 orbit; };
  DEResult aestrethraDEFull(vec3 p, vec3 rot, float wBias) {
    p = mod(p + 50.0, 100.0) - 50.0;
    float scale = 1.0;
    vec4 orbitTrap = vec4(1e3);
    for (int i = 0; i < 8; i++) {
      p = clamp(p, -rot, rot) * 2.0 - p;
      float r2 = dot(p, p);
      float k = max(2.0 / max(r2, 0.0001), wBias);
      p *= k;
      scale *= k;
      if (i < 6) orbitTrap = min(orbitTrap, vec4(abs(p), r2));
    }
    float len2d = length(p.xy);
    float d = abs(max(len2d - 4.0, -len2d * p.z / 4.0) / max(abs(scale), 0.001) * 10.0);
    DEResult result;
    result.dist = d;
    result.orbit = orbitTrap;
    return result;
  }

  float sd(vec3 p, vec3 rot, float wBias) { return aestrethraDE(p, rot, wBias).x; }

  vec3 calcNormal(vec3 p, vec3 rot, float wBias) {
    float e = 0.005;
    vec2 k = vec2(1.0, -1.0);
    return normalize(
      k.xyy * sd(p + k.xyy * e, rot, wBias) +
      k.yyx * sd(p + k.yyx * e, rot, wBias) +
      k.yxy * sd(p + k.yxy * e, rot, wBias) +
      k.xxx * sd(p + k.xxx * e, rot, wBias)
    );
  }

  float hash(vec3 seed) {
    return fract(sin(dot(seed, vec3(12.3456, 78.9012, 34.5678))) * 34567.89012) * 0.1;
  }

  void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    // ── Camera: forward flight through tiled fractal with gentle drift ──
    // Moves forward through the 100-unit tiled space, with X/Y sway
    // to explore different ring structures. lookAt stays ahead.
    float t = uTime;
    float speed = 8.0; // forward speed through tiled fractal
    vec3 ro = vec3(
      sin(t * 0.13) * 4.0 + cos(t * 0.07) * 2.0,
      sin(t * 0.11) * 3.0 + cos(t * 0.09) * 1.5,
      t * speed + sin(t * 0.17) * 5.0
    );
    vec3 lookAt = vec3(
      ro.x + sin(t * 0.13 + 0.5) * 3.0,
      ro.y + cos(t * 0.11 + 0.3) * 2.0,
      ro.z + 10.0
    );
    vec3 forward = normalize(lookAt - ro);
    vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, forward);
    vec3 rd = normalize(forward + right * uv.x * 0.55 + up * uv.y * 0.55);

    // ── Kleinian params: EXACT fractalworlds.io Aestrethra ──
    // parameters: {x:1, y:1, z:1.3, w:0.025}
    // parametersOffset: {x:0.2, y:0.2, z:0.05, w:0.025}
    vec3 rot = vec3(
      1.0 + sin(uTime * 0.05) * 0.2,
      1.0 + cos(uTime * 0.06) * 0.2,
      1.3 + sin(uTime * 0.07) * 0.05
    );
    float wBias = 0.025 + sin(uTime * 0.04) * 0.025;

    vec3 lightPos = vec3(0.0, 50.0, -60.0);
    vec3 lightDir = normalize(lightPos - ro);
    vec3 sunColor = vec3(1.0, 0.984, 0.898);

    // ── Raymarch ──
    float tDist = hash(ro + rd);
    float dist;
    const int MAX_STEPS = 96;
    const float MAX_DIST = 90.0;
    const float HIT_THRESH = 0.0005;

    for (int i = 0; i < MAX_STEPS; i++) {
      vec3 pos = ro + rd * tDist;
      dist = aestrethraDE(pos, rot, wBias).x;
      if (abs(dist) < HIT_THRESH || tDist > MAX_DIST) break;
      tDist += dist * 0.7;
    }

    vec3 color;

    if (tDist < MAX_DIST) {
      vec3 hitPos = ro + rd * tDist;
      vec3 normal = calcNormal(hitPos, rot, wBias);
      float diff = clamp(dot(normal, lightDir), 0.0, 1.0);

      // ── Orbit trap → lavaAqua texture ──
      // fractalworlds uses: triplanar average of orbitTrap.xyz + offset 0.9
      DEResult de = aestrethraDEFull(hitPos, rot, wBias);
      // Simplified triplanar: average of abs(p) components
      float orbitVal = (de.orbit.x + de.orbit.y + de.orbit.z) / 3.0 + 0.9;
      vec3 texColor = texture2D(uAlbedo, vec2(orbitVal, 0.5)).rgb;

      // ── PBR-like lighting ──
      // ambientIntensity: 0.15, sunIntensity: 4
      vec3 surfaceColor = texColor * (0.15 + diff * 0.6) * sunColor * 2.0;

      // Specular (Blinn-Phong, roughness 0.8)
      vec3 halfVec = normalize(lightDir - rd);
      float spec = pow(max(dot(normal, halfVec), 0.0), 8.0);
      surfaceColor += sunColor * spec * 0.3;

      // ── Fog: fogIntensity 0.03 ──
      vec3 fogSky = vec3(0.898, 0.933, 1.0) * 0.5;
      vec3 fogSun = sunColor * pow(max(dot(rd, lightDir), 0.0), 8.0) * 1.0;
      vec3 fogColor = fogSky + fogSun;
      float fogAmount = 1.0 - exp(-tDist * 0.03);
      color = mix(surfaceColor, fogColor, fogAmount);
    } else {
      vec3 fogSky = vec3(0.898, 0.933, 1.0) * 0.5;
      vec3 fogSun = sunColor * pow(max(dot(rd, lightDir), 0.0), 32.0) * 2.0;
      color = fogSky + fogSun;
    }

    // ── Tone mapping: exposure 1.5, Reinhard ──
    color *= 1.5;
    color = color / (color + 1.0);

    // ── Vignette: intensity 0.5 ──
    float cd = length(uv * vec2(1.0, uResolution.y / uResolution.x));
    color *= 1.0 - smoothstep(0.3, 1.4, cd) * 0.5;

    gl_FragColor = vec4(color, uOpacity);
  }
`,
  createUniforms: createFractalWorldsUniforms
};
