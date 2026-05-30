export const fractalFlowTheme = {
    id: 'fractal-flow',
    label: 'Neon Fractal (3D)',
    kind: 'three',
    renderOrder: -100,
    opacity: 0.92,
    fragmentShader: `
  precision highp float;

  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uAccentA;
  uniform vec3 uAccentB;
  uniform float uOpacity;

  mat2 rotate2d(float angle) {
    float s = sin(angle);
    float c = cos(angle);
    return mat2(c, -s, s, c);
  }

  void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float t = uTime * 0.18;
    vec2 p = uv;
    float filaments = 0.0;
    float mist = 0.0;

    // Compact kaleidoscopic fractal inspired by classic WebGL shader toys.
    // Kept intentionally low-contrast so the falling words remain the focus.
    for (int i = 0; i < 7; i++) {
      float fi = float(i);
      p = abs(p * rotate2d(0.22 + sin(t * 0.35 + fi) * 0.08));
      p = p / clamp(dot(p, p), 0.34, 1.42) - vec2(0.62, 0.48);
      p += 0.13 * vec2(cos(t + fi * 1.71), sin(t * 1.13 + fi * 2.03));

      float r = length(p);
      float beam = 0.012 / (0.035 + abs(sin(r * 9.0 - t * 2.6 + fi)));
      filaments += beam * (0.64 + 0.36 * sin(fi + t));
      mist += exp(-r * 2.0) * 0.035;
    }

    float vignette = smoothstep(1.65, 0.25, length(uv * vec2(0.82, 1.0)));
    float centerReadability = smoothstep(0.18, 0.72, length(uv));
    float pulse = 0.55 + 0.45 * sin(t * 1.7 + length(uv) * 5.0);
    vec3 neon = mix(uAccentA, uAccentB, pulse);
    vec3 coldBase = vec3(0.04, 0.05, 0.10);
    vec3 color = coldBase + neon * min(filaments * 0.85 + mist * 2.5, 1.0);

    // Keep the exact typing area readable: slightly darker center, brighter edges.
    color *= mix(0.88, 1.0, centerReadability);
    color *= vignette;
    color += vec3(0.02, 0.01, 0.04) * (1.0 - vignette);

    gl_FragColor = vec4(color, uOpacity);
  }
`
};
