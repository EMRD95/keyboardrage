import * as THREE from 'three';
import type {
  CustomThreeThemeDefinition,
  ThreeThemeColorInfo,
  ThreeThemeContext,
  ThreeThemeResizeInfo,
  ThreeThemeRuntime,
  ThreeThemeUpdateInfo
} from './types.js';
import {
  GRANITE_BOX_EMBEDDING_MODEL,
  GRANITE_BOX_MAX_DOTS_PER_LANGUAGE,
  GRANITE_BOX_WORD_POINTS,
  GRANITE_BOX_WORD_POINTS_BY_LANGUAGE,
  getGraniteBoxWordPoints,
  resolveGraniteBoxPointIndex,
  type GraniteBoxWordPoint
} from './box-embedding-data.js';
import { isGalaxyLanguage, loadGalaxyData } from './galaxy-data.js';
import type { GalaxyPointSet } from './galaxy-data.js';
import { buildExpandedBoxPointPositions } from './box-point-layout.js';

const BOX_RENDER_ORDER = -91;
const BOX_DISPLAY_VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BOX_DISPLAY_FRAGMENT_SHADER = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float uOpacity;

  void main() {
    vec4 tex = texture2D(uTexture, vUv);
    gl_FragColor = vec4(tex.rgb, tex.a * uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const MATRIX_BOX_COUNT = 8;
const MATRIX_BOX_SIZE = 0.46;
const MATRIX_POINT_SCALE = MATRIX_BOX_SIZE * 0.49;
const MATRIX_NEAR_Z = 0.92;
const MATRIX_BOX_SPACING = 0.72;
const MATRIX_BOX_SPEED = 0.24;
const MATRIX_TUNNEL_RADIUS = 0.50;
const MATRIX_TUNNEL_LENGTH = 6.7;

const ACTIVE_DOT_COLOR = new THREE.Color('#ff174d');
const BASE_DOT_BRIGHT = new THREE.Color('#b8ffd2');

function sparseDotScale(pointCount: number) {
  // Do not move/scale the boxes themselves by frequency. Only make sparse point
  // clouds a little more readable inside the same fixed boxes.
  const density = THREE.MathUtils.clamp(pointCount / 10000, 0.02, 1);
  return THREE.MathUtils.clamp(1 / Math.pow(density, 0.12), 1, 1.42);
}

type BoxInstance = {
  root: THREE.Group;
  highlight: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
};

function normalizeMatrixLetters(value: string, stripAccents = false) {
  let normalized = value.trim().toLowerCase().normalize(stripAccents ? 'NFKD' : 'NFKC');
  if (stripAccents) {
    normalized = normalized.replace(/[\u0300-\u036f]/g, '');
  }
  return normalized.replace(/[^\p{L}]/gu, '');
}

function getMatrixLookupKeys(value: string) {
  const exact = normalizeMatrixLetters(value, false);
  const folded = normalizeMatrixLetters(value, true);
  return exact === folded ? [exact] : [exact, folded];
}

function createMatrixGridGeometry(size: number, divisions: number) {
  const half = size / 2;
  const step = size / divisions;
  const vertices: number[] = [];

  const pushLine = (a: [number, number, number], b: [number, number, number]) => {
    vertices.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  };

  for (let i = 0; i <= divisions; i += 1) {
    const v = -half + i * step;

    // Front/back XY planes.
    pushLine([-half, v, -half], [half, v, -half]);
    pushLine([v, -half, -half], [v, half, -half]);
    pushLine([-half, v, half], [half, v, half]);
    pushLine([v, -half, half], [v, half, half]);

    // Floor/ceiling XZ planes.
    pushLine([-half, -half, v], [half, -half, v]);
    pushLine([v, -half, -half], [v, -half, half]);
    pushLine([-half, half, v], [half, half, v]);
    pushLine([v, half, -half], [v, half, half]);

    // Left/right YZ planes.
    pushLine([-half, -half, v], [-half, half, v]);
    pushLine([-half, v, -half], [-half, v, half]);
    pushLine([half, -half, v], [half, half, v]);
    pushLine([half, v, -half], [half, v, half]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  return geometry;
}

function createTunnelGeometry() {
  const points: THREE.Vector3[] = [];
  const segments = 7;
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    points.push(new THREE.Vector3(
      Math.sin(t * Math.PI * 2.0) * 0.035,
      Math.cos(t * Math.PI * 1.7) * 0.025,
      t * MATRIX_TUNNEL_LENGTH
    ));
  }
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom');
  return new THREE.TubeGeometry(curve, 108, MATRIX_TUNNEL_RADIUS, 28, false);
}

export class BoxMatrixBackground implements ThreeThemeRuntime {
  private readonly mainScene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly matrixScene = new THREE.Scene();
  private readonly matrixCamera: THREE.PerspectiveCamera;
  private readonly renderTarget: THREE.WebGLRenderTarget;
  private readonly display: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly displayUniforms: {
    uTexture: { value: THREE.Texture };
    uOpacity: { value: number };
  };

  private readonly pointGeometry = new THREE.BufferGeometry();
  private readonly pointMaterial: THREE.PointsMaterial;
  private readonly highlightGeometry = new THREE.BufferGeometry();
  private readonly highlightMaterial: THREE.PointsMaterial;
  private readonly edgeGeometry: THREE.EdgesGeometry;
  private readonly gridGeometry: THREE.BufferGeometry;
  private readonly shellMaterial: THREE.LineBasicMaterial;
  private readonly gridMaterial: THREE.LineBasicMaterial;
  private readonly tunnelGeometry: THREE.TubeGeometry;
  private readonly tunnelMaterial: THREE.MeshBasicMaterial;
  private readonly tunnelMesh: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>;
  private basePointColors: Float32Array;
  private livePointColors: Float32Array;
  private wordPoints: readonly GraniteBoxWordPoint[] = GRANITE_BOX_WORD_POINTS;
  private readonly wordIndex = new Map<string, number>();
  private readonly sourceIndexToPointIndex = new Map<number, number>();
  private galaxyPointSet: GalaxyPointSet | null = null;
  private galaxyLoadStarted = false;
  private galaxyLanguage: string | null = null;
  private readonly boxes: BoxInstance[] = [];

  private readonly accent = new THREE.Color('#22ffd6');
  private readonly accent2 = new THREE.Color('#ff174d');
  private visible = false;
  private animTime = 0;
  private activeWord = '';
  private activeSourceIndex: number | undefined;
  private activeIndex = -1;

  constructor(context: ThreeThemeContext, renderOrder = BOX_RENDER_ORDER) {
    this.mainScene = context.scene;
    this.renderer = context.renderer;
    this.matrixScene.fog = new THREE.FogExp2(0x000806, 0.42);

    this.matrixCamera = new THREE.PerspectiveCamera(42, context.logicalWidth / context.logicalHeight, 0.01, 30);
    this.matrixCamera.rotation.y = Math.PI;
    this.matrixCamera.position.z = 0.18;

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderTarget = new THREE.WebGLRenderTarget(
      Math.floor(context.logicalWidth * pixelRatio),
      Math.floor(context.logicalHeight * pixelRatio),
      { depthBuffer: true, stencilBuffer: false }
    );

    this.displayUniforms = {
      uTexture: { value: this.renderTarget.texture },
      uOpacity: { value: 0.98 }
    };

    this.display = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1, 1, 1),
      new THREE.ShaderMaterial({
        uniforms: this.displayUniforms,
        vertexShader: BOX_DISPLAY_VERTEX_SHADER,
        fragmentShader: BOX_DISPLAY_FRAGMENT_SHADER,
        transparent: true,
        depthTest: false,
        depthWrite: false
      })
    );
    this.display.visible = false;
    this.display.renderOrder = renderOrder;
    this.display.position.z = -500;
    this.mainScene.add(this.display);

    const cubeGeometry = new THREE.BoxGeometry(MATRIX_BOX_SIZE, MATRIX_BOX_SIZE, MATRIX_BOX_SIZE);
    this.edgeGeometry = new THREE.EdgesGeometry(cubeGeometry);
    cubeGeometry.dispose();
    this.gridGeometry = createMatrixGridGeometry(MATRIX_BOX_SIZE, 6);

    this.shellMaterial = new THREE.LineBasicMaterial({
      color: this.accent,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.gridMaterial = new THREE.LineBasicMaterial({
      color: this.accent,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.pointMaterial = new THREE.PointsMaterial({
      size: 0.012,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.24,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending
    });
    this.highlightMaterial = new THREE.PointsMaterial({
      color: ACTIVE_DOT_COLOR,
      size: 20,
      sizeAttenuation: false,
      transparent: true,
      opacity: 1.0,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    const pointCount = this.wordPoints.length;
    this.basePointColors = new Float32Array(pointCount * 3);
    this.livePointColors = new Float32Array(pointCount * 3);
    this.buildPointCloudGeometry();

    this.highlightGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3)
    );

    this.tunnelGeometry = createTunnelGeometry();
    this.tunnelMaterial = new THREE.MeshBasicMaterial({
      color: this.accent,
      wireframe: true,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.10,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.tunnelMesh = new THREE.Mesh(this.tunnelGeometry, this.tunnelMaterial);
    this.tunnelMesh.frustumCulled = false;
    this.matrixScene.add(this.tunnelMesh);

    this.createMatrixBoxes();
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.display.visible = visible;
    if (visible) {
      this.renderMatrixToTarget();
    }
  }

  resize({ width, height, visibleWidth, visibleHeight, centerX, centerY, pixelRatio }: ThreeThemeResizeInfo) {
    this.display.position.set(centerX, centerY, -500);
    this.display.scale.set(visibleWidth, visibleHeight, 1);

    this.matrixCamera.aspect = width / Math.max(height, 1);
    this.matrixCamera.updateProjectionMatrix();
    this.renderTarget.setSize(
      Math.max(1, Math.floor(width * pixelRatio)),
      Math.max(1, Math.floor(height * pixelRatio))
    );
  }

  update({ deltaTime, activeWord, activeWordSourceIndex, language, frequencyLimit }: ThreeThemeUpdateInfo) {
    const dt = Math.min(Math.max(deltaTime * 0.001, 0), 0.05);
    this.animTime += dt;
    const pointLanguage = language || 'english';
    this.updatePointLanguage(pointLanguage, frequencyLimit);
    this.updateActiveWord(activeWord || '', activeWordSourceIndex, pointLanguage);

    if (!this.visible) return;

    const cycle = MATRIX_BOX_COUNT * MATRIX_BOX_SPACING;
    const travel = (this.animTime * MATRIX_BOX_SPEED) % cycle;
    const pulse = Math.sin(this.animTime * 7.5) * 0.5 + 0.5;
    const dotScale = sparseDotScale(this.wordPoints.length);
    this.pointMaterial.size = 0.024 * dotScale;
    this.pointMaterial.opacity = 0.32 + (dotScale - 1) * 0.08;
    this.highlightMaterial.size = this.activeIndex >= 0 ? 13 + pulse * 4 : 13;
    this.highlightMaterial.opacity = this.activeIndex >= 0 ? 0.82 + pulse * 0.12 : 0.0;
    this.tunnelMesh.rotation.z = this.animTime * 0.045;

    this.boxes.forEach(({ root }, index) => {
      const lane = (index * MATRIX_BOX_SPACING - travel + cycle) % cycle;
      const z = MATRIX_NEAR_Z + lane;
      const sway = this.animTime * 0.55 + index * 1.7;
      root.position.set(Math.sin(sway) * 0.018, Math.cos(sway * 0.8) * 0.014, z);
      root.scale.setScalar(1);
      root.rotation.x = Math.sin(this.animTime * 0.34 + index) * 0.18;
      root.rotation.y = Math.cos(this.animTime * 0.29 + index * 0.7) * 0.16;
      root.rotation.z = this.animTime * 0.10 + index * 0.27;
    });

    this.renderMatrixToTarget();
  }

  updateColors({ accent, accent2 }: ThreeThemeColorInfo) {
    this.accent.set(accent);
    this.accent2.set(accent2);
    this.shellMaterial.color.copy(this.accent);
    this.gridMaterial.color.copy(this.accent);
    this.tunnelMaterial.color.copy(this.accent);
    this.highlightMaterial.color.copy(this.accent2);
    this.rebuildPointColors();
  }

  dispose() {
    this.mainScene.remove(this.display);
    this.display.geometry.dispose();
    this.display.material.dispose();
    this.renderTarget.dispose();

    this.boxes.forEach(({ root }) => this.matrixScene.remove(root));
    this.matrixScene.remove(this.tunnelMesh);

    this.pointGeometry.dispose();
    this.pointMaterial.dispose();
    this.highlightGeometry.dispose();
    this.highlightMaterial.dispose();
    this.edgeGeometry.dispose();
    this.gridGeometry.dispose();
    this.shellMaterial.dispose();
    this.gridMaterial.dispose();
    this.tunnelGeometry.dispose();
    this.tunnelMaterial.dispose();
  }

  private buildPointCloudGeometry() {
    const positions = this.buildPointPositions();
    this.basePointColors = new Float32Array(this.wordPoints.length * 3);
    this.livePointColors = new Float32Array(this.wordPoints.length * 3);
    this.wordIndex.clear();
    this.sourceIndexToPointIndex.clear();
    if (!this.galaxyPointSet) {
      this.wordPoints.forEach(([word], index) => {
        this.addWordIndex(word, index);
      });
    }
    if (this.galaxyPointSet) {
      this.galaxyPointSet.sourceIndexToPointIndex.forEach((pointIndex, sourceIndex) => {
        this.sourceIndexToPointIndex.set(sourceIndex, pointIndex);
      });
    }
    this.pointGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.pointGeometry.setAttribute('color', new THREE.BufferAttribute(this.livePointColors, 3));
    // Manual bounding sphere avoids NaN during Three.js auto-computation on huge position arrays
    this.pointGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100);
    this.pointGeometry.setDrawRange(0, Infinity);
    this.rebuildPointColors();
  }

  private buildPointPositions(): Float32Array {
    // For galaxy data use the precomputed axis stats (exact same as buildExpandedBoxPointPositions)
    // so dot positions are identical to the old stats-pipeline output.
    if (this.galaxyPointSet) {
      const positions = new Float32Array(this.wordPoints.length * 3);
      const target = MATRIX_POINT_SCALE;
      const [sx, sy, sz] = this.galaxyPointSet.axisStats;
      for (let i = 0; i < this.wordPoints.length; i += 1) {
        const expand = (v: number, s: import('./galaxy-data.js').AxisStats) => {
          const n = Math.min(1, Math.max(-1, (v - s.center) / s.halfRange));
          return Math.sign(n) * Math.pow(Math.abs(n), 0.72) * target;
        };
        positions[i * 3]     = expand(this.wordPoints[i][1], sx);
        positions[i * 3 + 1] = expand(this.wordPoints[i][2], sy);
        positions[i * 3 + 2] = expand(this.wordPoints[i][3], sz);
      }
      return positions;
    }
    return buildExpandedBoxPointPositions(this.wordPoints, MATRIX_POINT_SCALE);
  }

  private createMatrixBoxes() {
    for (let i = 0; i < MATRIX_BOX_COUNT; i += 1) {
      const root = new THREE.Group();
      root.frustumCulled = false;

      const shell = new THREE.LineSegments(this.edgeGeometry, this.shellMaterial);
      shell.frustumCulled = false;
      const grid = new THREE.LineSegments(this.gridGeometry, this.gridMaterial);
      grid.frustumCulled = false;
      const points = new THREE.Points(this.pointGeometry, this.pointMaterial);
      points.frustumCulled = false;
      const highlight = new THREE.Points(this.highlightGeometry, this.highlightMaterial);
      highlight.visible = false;
      highlight.frustumCulled = false;
      points.renderOrder = 1;
      highlight.renderOrder = 999;

      root.add(shell, grid, points, highlight);
      this.matrixScene.add(root);
      this.boxes.push({ root, highlight });
    }
  }

  private rebuildPointColors() {
    const attr = this.pointGeometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    const color = new THREE.Color();

    this.wordPoints.forEach(([, x, y, z], index) => {
      const depthTint = THREE.MathUtils.clamp((z + 0.82) / 1.64, 0, 1);
      const verticalTint = THREE.MathUtils.clamp((y + 0.82) / 1.64, 0, 1);
      const electricBand = Math.sin((x * 8.5) + (y * 5.0) + (z * 6.0)) * 0.5 + 0.5;
      const depthGlow = 0.55 + depthTint * 0.45;
      color.setRGB(
        0.020 + verticalTint * 0.028 + electricBand * 0.010,
        0.34 + depthTint * 0.18 + electricBand * 0.055,
        0.065 + depthTint * 0.060 + electricBand * 0.040
      );
      color.multiplyScalar(depthGlow);
      color.lerp(BASE_DOT_BRIGHT, 0.018);
      color.offsetHSL((x * 0.006) + (verticalTint * 0.006), 0.035, 0.010 * verticalTint);
      this.basePointColors[index * 3] = color.r;
      this.basePointColors[index * 3 + 1] = color.g;
      this.basePointColors[index * 3 + 2] = color.b;
    });

    this.livePointColors.set(this.basePointColors);
    if (this.activeIndex >= 0) {
      this.paintActivePoint(this.activeIndex);
    }
    if (attr) attr.needsUpdate = true;
  }

  private updatePointLanguage(language: string, frequencyLimit?: number) {
    if (isGalaxyLanguage(language)) {
      if (!this.galaxyLoadStarted) {
        this.galaxyLoadStarted = true;
        this.galaxyLanguage = language;
        // Hide old Granite dots during fetch (drawRange=0 instead of clearing
        // attributes, which would trigger NaN bounding spheres)
        this.pointGeometry.setDrawRange(0, 0);
        loadGalaxyData(language)
          .then((data) => {
            this.galaxyPointSet = data.getPointSet(frequencyLimit);
            this.wordPoints = this.galaxyPointSet.points;
            this.activeWord = '';
            this.activeSourceIndex = undefined;
            this.activeIndex = -1;
            this.buildPointCloudGeometry();
            this.hideHighlights();
          })
          .catch((error) => console.error('Failed to load galaxy data for Box Matrix:', error));
      } else if (language !== this.galaxyLanguage) {
        // Galaxy language changed: full reload
        this.galaxyLanguage = language;
        this.pointGeometry.setDrawRange(0, 0);
        loadGalaxyData(language)
          .then((data) => {
            this.galaxyPointSet = data.getPointSet(frequencyLimit);
            this.wordPoints = this.galaxyPointSet.points;
            this.activeWord = '';
            this.activeSourceIndex = undefined;
            this.activeIndex = -1;
            this.buildPointCloudGeometry();
            this.hideHighlights();
          })
          .catch((error) => console.error('Failed to switch galaxy language in Box Matrix:', error));
      } else {
        loadGalaxyData(language).then((data) => {
          // Only update the frequency gate — geometry stays (full cloud, no blink)
          data.getPointSet(frequencyLimit);
        }).catch(() => undefined);
      }
      return;
    }

    this.galaxyPointSet = null;
    const nextPoints = getGraniteBoxWordPoints(language);
    if (nextPoints === this.wordPoints) return;

    this.wordPoints = nextPoints;
    this.activeWord = '';
    this.activeSourceIndex = undefined;
    this.activeIndex = -1;
    this.buildPointCloudGeometry();
    this.hideHighlights();
  }

  private hideHighlights() {
    this.boxes.forEach(({ highlight }) => {
      highlight.visible = false;
    });
  }

  private addWordIndex(word: string, index: number) {
    getMatrixLookupKeys(word).forEach((key) => {
      if (key && !this.wordIndex.has(key)) {
        this.wordIndex.set(key, index);
      }
    });
  }

  private lookupWordIndex(word: string) {
    for (const key of getMatrixLookupKeys(word)) {
      const index = this.wordIndex.get(key);
      if (index !== undefined) return index;
    }
    return -1;
  }

  private updateActiveWord(rawWord: string, sourceIndex: number | undefined, language: string) {
    const normalized = getMatrixLookupKeys(rawWord)[0] || '';
    if (normalized === this.activeWord && sourceIndex === this.activeSourceIndex) return;

    this.activeWord = normalized;
    this.activeSourceIndex = sourceIndex;
    const routedIndex = sourceIndex !== undefined ? this.sourceIndexToPointIndex.get(sourceIndex) : undefined;
    // Gate: words beyond the frequency limit are visible but not "active"
    const gatedIndex = (routedIndex !== undefined && this.galaxyPointSet &&
      sourceIndex !== undefined && sourceIndex >= this.galaxyPointSet.frequencyLimit)
      ? undefined
      : routedIndex;
    const clusterIndex = gatedIndex !== undefined ? gatedIndex : resolveGraniteBoxPointIndex(language, sourceIndex);
    const index = clusterIndex >= 0 ? clusterIndex : (normalized ? this.lookupWordIndex(rawWord) : -1);
    this.activeIndex = index;
    this.livePointColors.set(this.basePointColors);

    if (index >= 0) {
      this.paintActivePoint(index);
      this.moveHighlightToPoint(index);
      this.boxes.forEach(({ highlight }) => {
        highlight.visible = true;
      });
    } else {
      this.boxes.forEach(({ highlight }) => {
        highlight.visible = false;
      });
    }

    const colorAttr = this.pointGeometry.getAttribute('color') as THREE.BufferAttribute;
    colorAttr.needsUpdate = true;
  }

  private paintActivePoint(index: number) {
    this.livePointColors[index * 3] = ACTIVE_DOT_COLOR.r;
    this.livePointColors[index * 3 + 1] = ACTIVE_DOT_COLOR.g;
    this.livePointColors[index * 3 + 2] = ACTIVE_DOT_COLOR.b;
  }

  private moveHighlightToPoint(index: number) {
    const positions = this.pointGeometry.getAttribute('position') as THREE.BufferAttribute;
    const highlightPositions = this.highlightGeometry.getAttribute('position') as THREE.BufferAttribute;
    highlightPositions.setXYZ(0, positions.getX(index), positions.getY(index), positions.getZ(index));
    highlightPositions.needsUpdate = true;
    this.highlightGeometry.computeBoundingSphere();
  }

  private renderMatrixToTarget() {
    const previousRenderTarget = this.renderer.getRenderTarget();
    const previousClearColor = new THREE.Color();
    this.renderer.getClearColor(previousClearColor);
    const previousClearAlpha = this.renderer.getClearAlpha();

    this.renderer.setClearColor(0x000806, 1);
    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.matrixScene, this.matrixCamera);
    this.renderer.setRenderTarget(previousRenderTarget);
    this.renderer.setClearColor(previousClearColor, previousClearAlpha);

    this.displayUniforms.uTexture.value = this.renderTarget.texture;
  }
}

export const boxTheme: CustomThreeThemeDefinition = {
  id: 'box',
  label: 'Box Matrix (3D)',
  kind: 'three',
  backgroundType: 'custom',
  renderOrder: BOX_RENDER_ORDER,
  createBackground: (context) => new BoxMatrixBackground(context, BOX_RENDER_ORDER)
};

console.debug(
  `Box Matrix uses up to ${GRANITE_BOX_MAX_DOTS_PER_LANGUAGE} Granite points across ${Object.keys(GRANITE_BOX_WORD_POINTS_BY_LANGUAGE).length} language sets from ${GRANITE_BOX_EMBEDDING_MODEL}`
);
