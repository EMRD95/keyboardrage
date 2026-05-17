import type { ThreeThemeDefinition } from './types.js';

export const fractalTunnelTheme: ThreeThemeDefinition = {
  id: 'fractal-tunnel',
  label: 'Fractal Tunnel (3D)',
  kind: 'three',
  renderOrder: -98,
  opacity: 0.95,
  fragmentShader: `
  precision highp float;

  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uAccentA;
  uniform vec3 uAccentB;
  uniform float uOpacity;

  // Kleinian inversion fractal SDF — lean for CPU rendering
  float kleinianSDF(vec3 p) {
    float scale = 1.0;
    float minRadius = 1e9;
    const float foldSize = 1.2;
    const float sphereR = 1.26;
    const float sphereR2 = sphereR * sphereR;

    // 5 iterations — minimal for recognizable Kleinian structure
    for (int i = 0; i < 5; i++) {
      float r2 = dot(p, p);
      if (r2 < sphereR2) {
        float k = sphereR2 / max(r2, 0.001);
        p *= k;
        scale *= k;
      }
      p = clamp(p, -foldSize, foldSize) * 2.0 - p;
      minRadius = min(minRadius, length(p));
    }

    return (minRadius / max(scale, 0.001)) * 0.5;
  }

  float sd(vec3 p) {
    return kleinianSDF(p);
  }

  // Tetrahedron normal: larger epsilon for stable normals at low iteration count
  vec3 calcNormal(vec3 p) {
    float e = 0.015;
    vec2 k = vec2(1.0, -1.0);
    return normalize(
      k.xyy * sd(p + k.xyy * e) +
      k.yyx * sd(p + k.yyx * e) +
      k.yxy * sd(p + k.yxy * e) +
      k.xxx * sd(p + k.xxx * e)
    );
  }

  void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    // Infinite cyclic orbit
    float t = uTime * 0.3;
    vec3 ro = vec3(
      sin(t * 0.7) * 3.5,
      cos(t * 0.5) * 2.8 + sin(t * 0.3) * 1.5,
      cos(t * 0.6) * 4.0 + 2.5
    );
    vec3 lookAt = vec3(
      sin(t * 0.7 + 1.2) * 1.5,
      cos(t * 0.5 + 0.8) * 1.0,
      cos(t * 0.6 + 2.5) * 2.0 + 1.5
    );
    vec3 forward = normalize(lookAt - ro);
    vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, forward);
    vec3 rd = normalize(forward + right * uv.x * 0.55 + up * uv.y * 0.55);

    // Raymarch — 64 steps, tight near clip
    float tDist = 0.0;
    float dist;
    const int MAX_STEPS = 64;
    const float MAX_DIST = 30.0;
    const float HIT_THRESH = 0.001;
    int steps = 0;

    for (int i = 0; i < MAX_STEPS; i++) {
      vec3 pos = ro + rd * tDist;
      dist = sd(pos);
      steps = i;
      if (abs(dist) < HIT_THRESH || tDist > MAX_DIST) break;
      tDist += dist * 0.85;  // conservative: avoids skipping thin surfaces
    }

    vec3 color;

    if (tDist < MAX_DIST) {
      vec3 hitPos = ro + rd * tDist;
      vec3 normal = calcNormal(hitPos);
      vec3 lightDir = normalize(vec3(0.4, 0.7, 0.4));
      float diff = max(dot(normal, lightDir), 0.0) * 0.75 + 0.25;

      float depth = tDist / MAX_DIST;
      float iterColor = float(steps) / float(MAX_STEPS);
      float band = sin(iterColor * 7.0 + uTime * 0.05) * 0.5 + 0.5;

      vec3 c1 = vec3(0.0, 1.0, 0.85);
      vec3 c2 = vec3(1.0, 0.35, 0.85);
      vec3 c3 = vec3(1.0, 0.65, 0.1);
      vec3 surfaceColor = mix(c1, c2, smoothstep(0.0, 0.5, band));
      surfaceColor = mix(surfaceColor, c3, smoothstep(0.5, 1.0, band));

      color = surfaceColor * diff;
      float fog = exp(-depth * 4.0);
      color = mix(vec3(0.002, 0.003, 0.008), color, fog);
    } else {
      color = vec3(0.002, 0.003, 0.008);
    }

    float cd = length(uv * vec2(1.0, uResolution.y / uResolution.x));
    color *= 1.0 - smoothstep(0.0, 0.45, cd) * 0.18;
    color *= 1.0 - smoothstep(0.5, 1.4, cd) * 0.40;

    gl_FragColor = vec4(color, uOpacity);
  }
`
};
