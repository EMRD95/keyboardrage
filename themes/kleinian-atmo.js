export const kleinianAtmoTheme = {
    id: 'kleinian-atmo',
    label: 'Kleinian Atmo (3D)',
    kind: 'three',
    renderOrder: -97,
    opacity: 0.95,
    fragmentShader: `
  precision highp float;

  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uAccentA;
  uniform vec3 uAccentB;
  uniform float uOpacity;

  // ── Atmospheric scattering (adapted from sbcode TSL reference) ──
  vec3 atmosphericScattering(vec3 pos, vec3 lightDir) {
    vec3 topColour = vec3(0.1, 0.2, 0.5) * 2.0;
    vec3 midColour = vec3(1.0, 0.4, 0.2);
    vec3 bottomColour = vec3(0.0, 0.0, 0.133);

    float t = clamp(pos.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 skyColour = mix(mix(bottomColour, vec3(0.75, 0.85, 0.95), t) * 3.0, vec3(0.0), t * 1.25);

    float radius = 0.005;
    float dist = length(pos - normalize(lightDir));
    float sun = exp(-dist * (dist / radius));
    skyColour += vec3(1.0, 0.8, 0.5) * sun;

    float mie = exp(-pow(dist * 3.0, 2.0)) * 0.5;
    skyColour += midColour * mie * 1.5;

    float rayleigh = exp(pos.y * 2.5) * 0.3;
    skyColour += rayleigh * topColour;

    float nightFactor = smoothstep(-0.1, 0.1, lightDir.y);
    skyColour *= nightFactor;

    return skyColour;
  }

  // ── Hash for randomized ray start (prevents banding) ──
  float hash(vec3 seed) {
    float d = dot(seed, vec3(12.3456, 78.9012, 34.5678));
    return fract(sin(d * 34567.89012) * 0.1);
  }

  // ── Kleinian SDF with organic distortion ──
  float kleinianSDF(vec3 p, float organic) {
    float scale = 1.0;
    float minRadius = 1e9;
    const float foldSize = 1.2;
    float sphereR = 1.26;
    float sphereR2 = sphereR * sphereR;

    for (int i = 0; i < 8; i++) {
      float r2 = dot(p, p + organic);
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
    return kleinianSDF(p, 0.0);
  }
  float sdOrganic(vec3 p, float organic) {
    return kleinianSDF(p, organic);
  }

  // ── Tetrahedron normal ──
  vec3 calcNormal(vec3 p) {
    float e = 0.0025;
    vec2 k = vec2(1.0, -1.0);
    return normalize(
      k.xyy * sd(p + k.xyy * e) +
      k.yyx * sd(p + k.yyx * e) +
      k.yxy * sd(p + k.yxy * e) +
      k.xxx * sd(p + k.xxx * e)
    );
  }

  // ── Simple ambient occlusion (directional sample along normal) ──
  float ambientOcclusion(vec3 p, vec3 n) {
    float occ = 0.0;
    float spread = 0.015;
    for (int i = 1; i <= 4; i++) {
      float d = sd(p + n * (float(i) * spread));
      occ += smoothstep(0.0, 0.005, d);
    }
    return clamp(occ / 4.0, 0.0, 1.0);
  }

  void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    // Infinite cyclic orbit
    float t = uTime * 0.25;
    vec3 ro = vec3(
      sin(t * 0.7) * 4.0,
      cos(t * 0.5) * 3.0 + sin(t * 0.3) * 2.0,
      cos(t * 0.6) * 5.0 + 3.0
    );
    vec3 lookAt = vec3(
      sin(t * 0.7 + 1.2) * 2.0,
      cos(t * 0.5 + 0.8) * 1.5,
      cos(t * 0.6 + 2.5) * 2.5 + 2.0
    );
    vec3 forward = normalize(lookAt - ro);
    vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, forward);
    vec3 rd = normalize(forward + right * uv.x * 0.5 + up * uv.y * 0.5);

    // Light
    vec3 lightPos = vec3(0.0, 50.0, -60.0);
    vec3 lightDir = normalize(lightPos - ro);

    // Randomized start (prevents banding artifacts)
    float jitter = hash(ro + rd) * 0.05;

    // Raymarch
    float tDist = jitter;
    float dist;
    const int MAX_STEPS = 128;
    const float MAX_DIST = 80.0;
    const float HIT_THRESH = 0.0001;
    int steps = 0;

    // Organic parameter slowly evolving
    float organic = sin(uTime * 0.15) * 0.3;

    for (int i = 0; i < MAX_STEPS; i++) {
      vec3 pos = ro + rd * tDist;
      dist = sdOrganic(pos, organic);
      steps = i;
      if (abs(dist) < HIT_THRESH || tDist > MAX_DIST) break;
      tDist += dist * 0.666;
    }

    vec3 color;

    if (tDist < MAX_DIST) {
      vec3 hitPos = ro + rd * tDist;
      vec3 normal = calcNormal(hitPos);

      float diff = clamp(dot(normal, lightDir), 0.0, 1.0);
      float ao = ambientOcclusion(hitPos, normal);

      vec3 surfaceColour = vec3(0.4, 0.9, 0.7);
      // Tint with accent colors for neon look
      surfaceColour = mix(surfaceColour, uAccentA, 0.3);
      surfaceColour = mix(surfaceColour, uAccentB, 0.2);
      surfaceColour *= ao;

      color = surfaceColour * (0.2 + diff * 0.4) * pow(normal * 0.5 + 0.5, vec3(0.5));

      // Fog blend
      float fog = exp(-pow(tDist * 0.000001, 3.0));
      vec3 skyColour = atmosphericScattering(rd, lightDir);
      color = mix(skyColour, color, fog);
    } else {
      color = atmosphericScattering(rd, lightDir);
    }

    float cd = length(uv * vec2(1.0, uResolution.y / uResolution.x));
    color *= 1.0 - smoothstep(0.0, 0.5, cd) * 0.15;
    color *= 1.0 - smoothstep(0.5, 1.4, cd) * 0.35;

    gl_FragColor = vec4(color, uOpacity);
  }
`
};
