export const deepFractalTheme = {
    id: 'deep-fractal',
    label: 'Deep Fractal (3D)',
    kind: 'three',
    renderOrder: -99,
    opacity: 0.95,
    fragmentShader: `
  precision highp float;

  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uAccentA;
  uniform vec3 uAccentB;
  uniform float uOpacity;

  // Rotate 2D point around origin
  mat2 rot(float a) {
    float s = sin(a), c = cos(a);
    return mat2(c, -s, s, c);
  }

  // Smooth noise for domain warping
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    // Domain warp: flowing distortion field
    float warpScale = 3.5;
    float warpAmp = 0.25;
    vec2 warp = vec2(
      noise(uv * warpScale + uTime * 0.15),
      noise(uv * warpScale + uTime * 0.15 + 3.7)
    );
    uv += (warp - 0.5) * warpAmp;

    // KIFS — Kaleidoscopic Iterated Function System
    vec2 p = uv;
    float orbit = 0.0;
    float foldCount = 0.0;
    float scale = 1.0;

    // Animate fold angles
    float baseAngle = uTime * 0.12;
    int folds = 6 + int(sin(uTime * 0.08) * 2.0);  // 4-8 fold symmetry, slowly changing

    for (int i = 0; i < 8; i++) {
      // Fold into first sector
      float angle = 6.2831853 / float(folds);
      float sector = floor(atan(p.y, p.x) / angle + 0.5);
      float rotAngle = sector * angle;
      p = p * rot(-rotAngle);  // rotate to sector 0
      p.x = abs(p.x);           // mirror into positive x

      // Record orbit for coloring
      orbit += length(p) * scale;
      foldCount += 1.0;

      // Scale and translate for next iteration
      p = p * 2.2 - 1.0;
      p = p * rot(baseAngle + float(i) * 0.4);
      scale *= 0.45;
    }

    // Coloring from orbit distance — use sin() for infinite, never-resetting bands
    float t = orbit * 0.6;

    // Smooth infinite color bands
    float band1 = sin(t * 4.5 + uTime * 0.08) * 0.5 + 0.5;
    float band2 = sin(t * 3.2 - uTime * 0.06) * 0.5 + 0.5;
    float band3 = sin(t * 7.0 + uTime * 0.11) * 0.5 + 0.5;

    // Neon palette: cyan, magenta, gold, violet
    vec3 c1 = vec3(0.0, 1.0, 0.9);    // cyan
    vec3 c2 = vec3(1.0, 0.35, 0.9);   // magenta
    vec3 c3 = vec3(1.0, 0.7, 0.1);    // gold
    vec3 c4 = vec3(0.6, 0.1, 1.0);    // violet
    vec3 c5 = vec3(0.1, 0.95, 0.5);   // emerald

    vec3 col = c1;
    col = mix(col, c2, smoothstep(0.0, 0.2, band1));
    col = mix(col, c3, smoothstep(0.2, 0.4, band1));
    col = mix(col, c4, smoothstep(0.4, 0.6, band1));
    col = mix(col, c5, smoothstep(0.6, 0.8, band1));
    col = mix(col, c1, smoothstep(0.8, 1.0, band1));

    // Add accent-tinted banding from orbit
    col = mix(col, uAccentA, band2 * 0.35);
    col = mix(col, uAccentB, band3 * 0.25);

    // Fold-line glow: smooth infinite ripples, never repeats
    float foldGlow = sin(orbit * 8.0 + uTime * 0.15) * 0.5 + 0.5;
    foldGlow = pow(foldGlow, 4.0) * 0.45;
    col += uAccentA * foldGlow;

    // Brightness
    float brightness = 0.55 + orbit * 0.08;
    brightness = clamp(brightness, 0.3, 1.3);

    vec3 darkBase = vec3(0.004, 0.005, 0.015);
    vec3 color = darkBase + col * brightness;

    // Center readability: keep play area slightly subdued
    float centerDist = length(uv);
    float centerFade = 1.0 - smoothstep(0.0, 0.5, centerDist) * 0.3;
    color *= centerFade;

    // Vignette
    float vignette = 1.0 - smoothstep(0.55, 1.4, centerDist) * 0.5;
    color *= vignette;

    // Gentle contrast
    color = pow(color, vec3(0.92));

    gl_FragColor = vec4(color, uOpacity);
  }
`
};
