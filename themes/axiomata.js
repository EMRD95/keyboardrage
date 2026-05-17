export const axiomataTheme = {
    id: 'axiomata',
    label: 'Axiomata (3D)',
    kind: 'three',
    renderOrder: -92,
    opacity: 0.95,
    fragmentShader: `
  precision highp float;

  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uAccentA;
  uniform vec3 uAccentB;
  uniform float uOpacity;

  // ── Axiomata: morphing fractal that blends two DE types ──
  // Ported from fractalworlds.io level #10 (de-functions.js + fractal-defs.js)
  // Morphs between:
  //   1. Yiaqorus-style KIFS: box fold + sphere inversion + sin perturbation
  //   2. Teklonium-style: abs fold + polynomial scaling
  // Controlled by transformMix (L.x) and finalMix (L.y)

  float hash(vec3 seed) {
    return fract(sin(dot(seed, vec3(12.3456, 78.9012, 34.5678))) * 34567.89012) * 0.1;
  }

  // ── Yiaqorus iteration step ──
  // Box fold + sphere inversion with sinusoidal perturbation on r²
  struct StepResult { vec3 p; float gain; vec4 orbit; };

  StepResult yiaqorusStep(vec3 p, vec3 foldBounds, float wBias) {
    StepResult r;
    // Box fold: reflect into [-foldBounds, foldBounds]
    vec3 folded = clamp(p, -foldBounds, foldBounds) * 2.0 - p;
    // Perturbed r² with sin(p.z * 0.3)
    float r2 = dot(folded, folded + sin(folded.z * 0.3));
    float k = max(2.0 / max(r2, 0.0001), wBias);
    r.p = folded * k;
    r.gain = abs(k);
    r.orbit = abs(vec4(r.p, r2));
    return r;
  }

  // ── Teklonium iteration step ──
  // Box fold [-1,1] scaled by l_z, then polynomial scaling
  StepResult tekloniumStep(vec3 p, float polynomialScale, float invPower, float l_z, vec3 offset) {
    StepResult r;
    float h = 1.0 / invPower;
    vec3 folded = clamp(p, -1.0, 1.0) * l_z - p;

    // Polynomial: sum of |p|^5 components
    vec3 ap = abs(folded);
    vec3 sq = ap * ap;
    vec3 quartic = sq * sq * ap;
    float sum5 = quartic.x + quartic.y + quartic.z;
    float invPow = pow(max(sum5, 0.0001), h);
    float invPow2 = invPow * invPow;
    float scaling = polynomialScale / max(invPow2, 0.0001);
    float clamped = clamp(max(scaling, polynomialScale), 0.0, polynomialScale * 2.0);
    float scale = -10.0 * clamped;

    r.p = folded * scale + offset;
    r.gain = abs(scale);
    r.orbit = abs(vec4(r.p, scale));
    return r;
  }

  // ── Lerp between two step results ──
  StepResult blendSteps(StepResult a, StepResult b, float t) {
    StepResult r;
    r.p = mix(a.p, b.p, t);
    r.gain = mix(a.gain, b.gain, t);
    r.orbit = mix(a.orbit, b.orbit, t);
    return r;
  }

  // ── Full Axiomata DE ──
  // Returns vec2(distance, orbitTrap.w)
  vec2 axiomataDE(vec3 pos, float transformMix, float finalMix, float wBias, float invPower) {
    vec3 p = pos;
    p = vec3(p.x, p.z, p.y); // Swizzle Y↔Z
    float scaleAccum = 1.0;
    vec4 orbit = vec4(1e3);
    vec3 tekOffset = p * 0.2;

    vec3 foldBounds = vec3(1.0, 1.0, 1.3);
    float polynomialScale = 0.3;
    float l_z = 2.0;

    for (int i = 0; i < 7; i++) {
      StepResult yResult = yiaqorusStep(p, foldBounds, wBias);
      StepResult tResult = tekloniumStep(p, polynomialScale, invPower, l_z, tekOffset);
      StepResult blended = blendSteps(yResult, tResult, transformMix);

      p = blended.p;
      scaleAccum *= blended.gain;

      if (i < 3) orbit = min(orbit, blended.orbit);
    }

    float safeScale = max(abs(scaleAccum), 0.000001);

    // KIFS distance (same as Aestrethra)
    float len2d = length(p.xy);
    float kifsD = abs(max(len2d - 4.0, -len2d * p.z / 4.0)) / safeScale;

    // Box fold distance [-10, 10]
    vec3 clamped = p - clamp(p, -10.0, 10.0);
    float boxD = length(clamped) / safeScale;

    // Morph between distance formulas
    float d = mix(kifsD, boxD, finalMix);
    return vec2(d, orbit.w);
  }

  // ── Full orbit trap for texture sampling ──
  vec4 axiomataDEFull(vec3 pos, float transformMix, float finalMix, float wBias, float invPower) {
    vec3 p = pos;
    p = vec3(p.x, p.z, p.y);
    float scaleAccum = 1.0;
    vec4 orbit = vec4(1e3);
    vec3 tekOffset = p * 0.2;

    vec3 foldBounds = vec3(1.0, 1.0, 1.3);
    float polynomialScale = 0.3;
    float l_z = 2.0;

    for (int i = 0; i < 7; i++) {
      StepResult yResult = yiaqorusStep(p, foldBounds, wBias);
      StepResult tResult = tekloniumStep(p, polynomialScale, invPower, l_z, tekOffset);
      StepResult blended = blendSteps(yResult, tResult, transformMix);

      p = blended.p;
      scaleAccum *= blended.gain;

      if (i < 3) orbit = min(orbit, blended.orbit);
    }

    return orbit;
  }

  float sd(vec3 p, float tM, float fM, float wB, float iP) {
    return axiomataDE(p, tM, fM, wB, iP).x;
  }

  vec3 calcNormal(vec3 p, float tM, float fM, float wB, float iP) {
    float e = 0.005;
    vec2 k = vec2(1.0, -1.0);
    return normalize(
      k.xyy * sd(p + k.xyy * e, tM, fM, wB, iP) +
      k.yyx * sd(p + k.yyx * e, tM, fM, wB, iP) +
      k.yxy * sd(p + k.yxy * e, tM, fM, wB, iP) +
      k.xxx * sd(p + k.xxx * e, tM, fM, wB, iP)
    );
  }

  void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float t = uTime;

    // ── Camera: orbit around fractal origin ──
    // Axiomata uses repetition=1000 (effectively no tiling), so orbit locally
    float camRadius = 18.0 + sin(t * 0.08) * 6.0;
    vec3 ro = vec3(
      sin(t * 0.12) * camRadius,
      cos(t * 0.09) * 8.0 + sin(t * 0.15) * 4.0,
      cos(t * 0.12) * camRadius
    );
    vec3 lookAt = vec3(
      sin(t * 0.06) * 3.0,
      cos(t * 0.04) * 2.0,
      cos(t * 0.06) * 3.0
    );
    vec3 forward = normalize(lookAt - ro);
    vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, forward);
    vec3 rd = normalize(forward + right * uv.x * 0.5 + up * uv.y * 0.5);

    // ── Axiomata parameters (from fractal-defs.js) ──
    // L = {x:0.35, y:0.25, z:0.3, w:5}
    float transformMix = 0.35 + sin(t * 0.04) * 0.15;  // Slowly morph between DE types
    float finalMix = 0.25 + cos(t * 0.05) * 0.1;        // Slowly morph distance formulas
    float wBias = 0.3 + sin(t * 0.03) * 0.1;             // Sphere inversion weight
    float invPower = 5.0;                                  // Teklonium power

    vec3 lightPos = vec3(0.0, 50.0, -60.0);
    vec3 lightDir = normalize(lightPos - ro);
    vec3 sunColor = vec3(1.0, 0.94, 0.88);

    // ── Raymarch ──
    float tDist = hash(ro + rd);
    float dist;
    const int MAX_STEPS = 96;
    const float MAX_DIST = 90.0;
    const float HIT_THRESH = 0.001;

    for (int i = 0; i < MAX_STEPS; i++) {
      vec3 pos = ro + rd * tDist;
      dist = sd(pos, transformMix, finalMix, wBias, invPower);
      if (abs(dist) < HIT_THRESH || tDist > MAX_DIST) break;
      tDist += dist * 0.7;
    }

    vec3 color;

    if (tDist < MAX_DIST) {
      vec3 hitPos = ro + rd * tDist;
      vec3 normal = calcNormal(hitPos, transformMix, finalMix, wBias, invPower);
      float diff = clamp(dot(normal, lightDir), 0.0, 1.0);

      // ── Orbit trap coloring (springTime-like gradient) ──
      vec4 orbitTrap = axiomataDEFull(hitPos, transformMix, finalMix, wBias, invPower);
      float orbitVal = (orbitTrap.x + orbitTrap.y + orbitTrap.z) / 3.0 + 0.72;
      // Synthetic warm gradient (springTime palette)
      vec3 texColor = mix(
        vec3(0.2, 0.6, 0.4),
        mix(vec3(0.95, 0.75, 0.3), vec3(0.9, 0.3, 0.5), orbitVal),
        clamp(orbitVal * 1.5, 0.0, 1.0)
      );

      // ── PBR-like: metallic 0.55, roughness 0.15, ambient 0.1, emissive 1.5 ──
      vec3 surfaceColor = texColor * (0.1 + diff * 0.5) * sunColor * 2.5;

      // Emissive glow from orbit trap
      float emissive = pow(clamp(1.0 - orbitVal, 0.0, 1.0), 2.0) * 1.5;
      surfaceColor += texColor * emissive;

      // Specular (low roughness = tight highlight)
      vec3 halfVec = normalize(lightDir - rd);
      float spec = pow(max(dot(normal, halfVec), 0.0), 32.0);
      surfaceColor += sunColor * spec * 0.5;

      // ── Fog: fogIntensity 0.015 ──
      vec3 fogSky = vec3(0.78, 0.9, 0.98) * 0.35;
      vec3 fogSun = sunColor * pow(max(dot(rd, lightDir), 0.0), 8.0) * 0.8;
      vec3 fogColor = fogSky + fogSun;
      // stepsFog: warm pink tint during raymarching
      vec3 stepsFogColor = vec3(0.92, 0.78, 0.84);
      float stepsFog = 1.0 - exp(-tDist * 0.015);
      color = mix(surfaceColor, fogColor, stepsFog);
    } else {
      vec3 fogSky = vec3(0.78, 0.9, 0.98) * 0.35;
      vec3 fogSun = sunColor * pow(max(dot(rd, lightDir), 0.0), 32.0) * 2.0;
      color = fogSky + fogSun;
    }

    // ── Post-processing ──
    // Tone mapping: exposure 1.2, Reinhard
    color *= 1.2;
    color = color / (color + 1.0);

    // Contrast 1.03
    color = (color - 0.5) * 1.03 + 0.5;

    // Saturation 1.05
    float grey = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(vec3(grey), color, 1.05);

    // Vignette: intensity 0.65
    float cd = length(uv * vec2(1.0, uResolution.y / uResolution.x));
    color *= 1.0 - smoothstep(0.3, 1.3, cd) * 0.65;

    gl_FragColor = vec4(color, uOpacity);
  }
`
};
