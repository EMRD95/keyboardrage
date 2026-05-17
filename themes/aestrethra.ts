import type { ThreeThemeDefinition } from './types.js';

export const aestrethraTheme: ThreeThemeDefinition = {
  id: 'aestrethra',
  label: 'Aestrethra (3D)',
  kind: 'three',
  renderOrder: -96,
  opacity: 0.95,
  fragmentShader: `
  precision highp float;

  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uAccentA;
  uniform vec3 uAccentB;
  uniform float uOpacity;

  // ── Atmospheric scattering (dark sky, same as FractalWorlds) ──
  vec3 atmosphericScattering(vec3 dir, vec3 lightDir) {
    float t = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 skyColour = mix(vec3(0.01, 0.01, 0.04), vec3(0.04, 0.06, 0.12), t);
    float dist = length(dir - normalize(lightDir));
    float sun = exp(-dist * (dist / 0.3));
    skyColour += vec3(1.0, 0.8, 0.5) * sun * 0.15;
    skyColour += vec3(0.6, 0.25, 0.1) * exp(-pow(dist * 2.0, 2.0)) * 0.1;
    skyColour *= smoothstep(-0.1, 0.1, lightDir.y);
    return skyColour;
  }

  float hash(vec3 seed) {
    return fract(sin(dot(seed, vec3(12.3456, 78.9012, 34.5678))) * 34567.89012) * 0.1;
  }

  // ── Aestrethra parameterized Kleinian SDF ──
  vec2 aestrethraDE(vec3 p, vec3 rot, float wBias) {
    float scale = 1.0;
    vec4 minRadius = vec4(1e3);
    for (int i = 0; i < 8; i++) {
      p = clamp(p, -rot, rot) * 2.0 - p;
      float r2 = dot(p, p);
      float k = (2.0 / max(r2, 0.001)) + wBias;
      p *= k;
      scale *= k;
      if (i < 6) minRadius = min(minRadius, vec4(p, r2));
    }
    float len2d = length(p.xy);
    float d = (len2d - 4.0) * abs(-p.z / 4.0) / max(length(vec2(scale)), 0.001) * 0.5;
    return vec2(d, minRadius.w);
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

  void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    // Spiral orbit — stays in the dense core forever, feels like forward flight
    float t = uTime * 0.2;
    vec3 ro = vec3(
      sin(t * 0.5) * 3.5,
      cos(t * 0.4) * 3.0 + sin(t * 0.25) * 2.0 + 2.0,
      cos(t * 0.45) * 4.0 + sin(t * 0.15) * 6.0
    );
    vec3 lookAt = vec3(
      sin(t * 0.5 + 1.3) * 2.5,
      cos(t * 0.4 + 0.9) * 1.5,
      cos(t * 0.45 + 1.7) * 3.0 + sin(t * 0.15 + 0.5) * 5.0 + 5.0
    );
    vec3 forward = normalize(lookAt - ro);
    vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, forward);
    vec3 rd = normalize(forward + right * uv.x * 0.55 + up * uv.y * 0.55);

    // Moderate fold sizes: open enough to see, dense enough to stay interesting
    vec3 rot = vec3(
      1.05 + sin(uTime * 0.05) * 0.25,
      1.05 + cos(uTime * 0.06) * 0.25,
      1.15 + sin(uTime * 0.07) * 0.30
    );
    float wBias = 0.018 + sin(uTime * 0.04) * 0.010;

    vec3 lightPos = vec3(0.0, 50.0, -60.0);
    vec3 lightDir = normalize(lightPos - ro);

    // Raymarch
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

      // Smooth depth-based coloring — no jitter
      float depth = tDist / MAX_DIST;
      float band = sin(tDist * 0.5 + uTime * 0.04) * 0.5 + 0.5;

      vec3 c1 = vec3(0.0, 1.0, 0.8);
      vec3 c2 = vec3(1.0, 0.4, 0.9);
      vec3 c3 = vec3(1.0, 0.7, 0.15);
      vec3 surfaceColor = mix(c1, c2, smoothstep(0.0, 0.5, band));
      surfaceColor = mix(surfaceColor, c3, smoothstep(0.5, 1.0, band));

      color = surfaceColor * (0.2 + diff * 0.4);

      // Light fog: distant structures stay visible, atmosphere for depth
      float fog = exp(-pow(tDist * 0.0000005, 3.0));
      vec3 skyColour = atmosphericScattering(rd, lightDir);
      color = mix(skyColour, color, fog);
    } else {
      color = atmosphericScattering(rd, lightDir);
    }

    float cd = length(uv * vec2(1.0, uResolution.y / uResolution.x));
    color *= 1.0 - smoothstep(0.0, 0.5, cd) * 0.12;
    color *= 1.0 - smoothstep(0.5, 1.4, cd) * 0.30;

    gl_FragColor = vec4(color, uOpacity);
  }
`
};
