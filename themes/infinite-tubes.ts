import type { ThreeThemeDefinition } from './types.js';

export const infiniteTubesTheme: ThreeThemeDefinition = {
  id: 'infinite-tubes',
  label: 'Infinite Tubes (3D)',
  kind: 'three',
  renderOrder: -95,
  opacity: 0.95,
  fragmentShader: `
  precision highp float;

  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uAccentA;
  uniform vec3 uAccentB;
  uniform float uOpacity;

  float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i+vec2(1,0)), f.x),
               mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), f.x), f.y);
  }

  void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    vec2 delta = uv;
    float dist = length(delta);
    float angle = atan(delta.y, delta.x);

    float z = 1.0 / max(dist, 0.001);

    float curveX = noise(vec2(z * 0.15 + uTime * 0.15, 0.0)) * 1.5;
    float curveY = noise(vec2(z * 0.15 + uTime * 0.15, 3.7)) * 1.5;
    vec2 curvedUV = uv - vec2(curveX, curveY) * (1.0 / z);
    float curvedDist = length(curvedUV);
    float curvedZ = 1.0 / max(curvedDist, 0.001);

    float rings = sin(curvedZ * 4.0 + uTime * 1.8) * 0.5 + 0.5;
    float ringGlow = smoothstep(0.02, 0.01, abs(fract(curvedZ * 2.0 + uTime * 0.9) - 0.5)) * 0.3;

    float angleTiles = sin(angle * 12.0 + curvedZ * 2.0) * 0.5 + 0.5;
    float brickLines = smoothstep(0.95, 1.0, angleTiles) * 0.4;

    float pattern = rings * 0.6 + ringGlow + brickLines;

    vec3 baseColor = mix(vec3(0.15, 0.08, 0.03), vec3(0.3, 0.15, 0.05), rings);
    vec3 tubeColor = mix(baseColor, uAccentA, ringGlow * 0.6);
    tubeColor = mix(tubeColor, uAccentB, brickLines * 0.3);

    float fog = exp(-curvedZ * 0.12);
    vec3 fogColor = vec3(0.01, 0.01, 0.02);
    vec3 color = mix(fogColor, tubeColor, fog * pattern + 0.05);

    color *= 1.0 - smoothstep(0.0, 0.6, dist) * 0.5;
    color *= smoothstep(0.05, 0.15, dist);

    gl_FragColor = vec4(color, uOpacity);
  }
`
};
