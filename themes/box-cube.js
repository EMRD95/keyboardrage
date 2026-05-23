import * as THREE from 'three';
import { GRANITE_BOX_EMBEDDING_MODEL, GRANITE_BOX_MAX_DOTS_PER_LANGUAGE, GRANITE_BOX_WORD_POINTS, GRANITE_BOX_WORD_POINTS_BY_LANGUAGE, getGraniteBoxWordPoints, resolveGraniteBoxPointIndex } from './box-embedding-data.js';
import { isGalaxyLanguage, loadGalaxyData } from './galaxy-data.js';
import { buildExpandedBoxPointPositions } from './box-point-layout.js';
const BOX_CUBE_RENDER_ORDER = -90;
const CUBE_SIZE = 1.92;
const CUBE_GRID_DIVISIONS = 10;
const CUBE_POINT_SCALE = CUBE_SIZE * 0.46;
const CUBE_BASE_ROTATION = new THREE.Euler(-0.28, 0.62, 0.10);
const ACTIVE_DOT_COLOR = new THREE.Color('#ff174d');
const BASE_DOT_BRIGHT = new THREE.Color('#00ff33');
function getSparsityMetrics(pointCount) {
    // Use log10 to handle the massive range gracefully
    // Math.log10(300000) is ~5.47 | Math.log10(200) is ~2.30
    const logCount = Math.log10(Math.max(pointCount, 200));
    // 0.0 means completely dense (300k+), 1.0 means extremely sparse (<=200)
    const sparsity = THREE.MathUtils.clamp(1.0 - (logCount - 2.3) / (5.47 - 2.3), 0, 1);
    // Use a Smoothstep curve so the visual transition feels natural
    const easeSparsity = sparsity * sparsity * (3 - 2 * sparsity);
    return {
        // Base size 0.015 (at 300k), scaling up to 0.09 (at 200)
        size: 0.015 + (easeSparsity * 0.075),
        // Base opacity 0.15 (at 300k), scaling up to 0.90 (at 200)
        opacity: 0.15 + (easeSparsity * 0.75)
    };
}
const CUBE_DISPLAY_VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const CUBE_DISPLAY_FRAGMENT_SHADER = `
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
function normalizeMatrixLetters(value, stripAccents = false) {
    let normalized = value.trim().toLowerCase().normalize(stripAccents ? 'NFKD' : 'NFKC');
    if (stripAccents) {
        normalized = normalized.replace(/[\u0300-\u036f]/g, '');
    }
    return normalized.replace(/[^\p{L}]/gu, '');
}
function getMatrixLookupKeys(value) {
    const exact = normalizeMatrixLetters(value, false);
    const folded = normalizeMatrixLetters(value, true);
    return exact === folded ? [exact] : [exact, folded];
}
function createCubeGridGeometry(size, divisions) {
    const half = size / 2;
    const step = size / divisions;
    const vertices = [];
    const pushLine = (a, b) => {
        vertices.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    };
    for (let i = 0; i <= divisions; i += 1) {
        const value = -half + i * step;
        // Front/back XY matrices.
        pushLine([-half, value, -half], [half, value, -half]);
        pushLine([value, -half, -half], [value, half, -half]);
        pushLine([-half, value, half], [half, value, half]);
        pushLine([value, -half, half], [value, half, half]);
        // Floor/ceiling XZ matrices.
        pushLine([-half, -half, value], [half, -half, value]);
        pushLine([value, -half, -half], [value, -half, half]);
        pushLine([-half, half, value], [half, half, value]);
        pushLine([value, half, -half], [value, half, half]);
        // Left/right YZ matrices.
        pushLine([-half, -half, value], [-half, half, value]);
        pushLine([-half, value, -half], [-half, value, half]);
        pushLine([half, -half, value], [half, half, value]);
        pushLine([half, value, -half], [half, value, half]);
    }
    // Three bright center axes make the cube read as one fixed semantic space.
    pushLine([-half, 0, 0], [half, 0, 0]);
    pushLine([0, -half, 0], [0, half, 0]);
    pushLine([0, 0, -half], [0, 0, half]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    return geometry;
}
export class BoxCubeBackground {
    constructor(context, renderOrder = BOX_CUBE_RENDER_ORDER) {
        this.cubeScene = new THREE.Scene();
        this.cubeRoot = new THREE.Group();
        this.pointGeometry = new THREE.BufferGeometry();
        this.highlightGeometry = new THREE.BufferGeometry();
        this.lightSphereGeometry = new THREE.SphereGeometry(0.042, 18, 10);
        this.wordPoints = GRANITE_BOX_WORD_POINTS;
        this.wordIndex = new Map();
        this.sourceIndexToPointIndex = new Map();
        this.galaxyPointSet = null;
        this.galaxyLoadStarted = false;
        this.lightOrbits = [];
        this.accent = new THREE.Color('#6dfff2');
        this.accent2 = new THREE.Color('#ff174d');
        this.visible = false;
        this.animTime = 0;
        this.activeWord = '';
        this.activeIndex = -1;
        this.mainScene = context.scene;
        this.renderer = context.renderer;
        this.cubeScene.fog = new THREE.FogExp2(0x02020c, 0.12);
        this.cubeCamera = new THREE.PerspectiveCamera(34, context.logicalWidth / context.logicalHeight, 0.01, 40);
        this.cubeCamera.position.set(0, 0, 4.65);
        this.cubeCamera.lookAt(0, 0, 0);
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        this.renderTarget = new THREE.WebGLRenderTarget(Math.floor(context.logicalWidth * pixelRatio), Math.floor(context.logicalHeight * pixelRatio), { depthBuffer: true, stencilBuffer: false });
        this.displayUniforms = {
            uTexture: { value: this.renderTarget.texture },
            uOpacity: { value: 0.98 }
        };
        this.display = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), new THREE.ShaderMaterial({
            uniforms: this.displayUniforms,
            vertexShader: CUBE_DISPLAY_VERTEX_SHADER,
            fragmentShader: CUBE_DISPLAY_FRAGMENT_SHADER,
            transparent: true,
            depthTest: false,
            depthWrite: false
        }));
        this.display.visible = false;
        this.display.renderOrder = renderOrder;
        this.display.position.z = -500;
        this.mainScene.add(this.display);
        this.cubeFaceGeometry = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE, 1, 1, 1);
        this.cubeEdgeGeometry = new THREE.EdgesGeometry(this.cubeFaceGeometry);
        this.cubeGridGeometry = createCubeGridGeometry(CUBE_SIZE, CUBE_GRID_DIVISIONS);
        this.faceMaterial = new THREE.MeshStandardMaterial({
            color: 0x061816,
            emissive: this.accent,
            emissiveIntensity: 0.055,
            roughness: 0.42,
            metalness: 0.18,
            transparent: true,
            opacity: 0.055,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.shellMaterial = new THREE.LineBasicMaterial({
            color: this.accent,
            transparent: true,
            opacity: 0.90,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.gridMaterial = new THREE.LineBasicMaterial({
            color: this.accent,
            transparent: true,
            opacity: 0.20,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.pointMaterial = new THREE.PointsMaterial({
            size: 0.015, // Reduced from 0.026 to handle 300k density
            sizeAttenuation: true,
            vertexColors: true,
            transparent: true,
            opacity: 0.15, // Lowered base opacity
            depthTest: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending // Caps overlaps at pure green, never white
        });
        this.highlightMaterial = new THREE.PointsMaterial({
            color: ACTIVE_DOT_COLOR,
            size: 22,
            sizeAttenuation: false,
            transparent: true,
            opacity: 1.0,
            depthTest: false,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.highlightHaloMaterial = new THREE.PointsMaterial({
            color: ACTIVE_DOT_COLOR,
            size: 56,
            sizeAttenuation: false,
            transparent: true,
            opacity: 0.46,
            depthTest: false,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        const pointCount = this.wordPoints.length;
        this.basePointColors = new Float32Array(pointCount * 3);
        this.livePointColors = new Float32Array(pointCount * 3);
        this.buildPointCloudGeometry();
        this.highlightGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3));
        const cubeFace = new THREE.Mesh(this.cubeFaceGeometry, this.faceMaterial);
        const cubeShell = new THREE.LineSegments(this.cubeEdgeGeometry, this.shellMaterial);
        const cubeGrid = new THREE.LineSegments(this.cubeGridGeometry, this.gridMaterial);
        const cubePoints = new THREE.Points(this.pointGeometry, this.pointMaterial);
        const activeDot = new THREE.Points(this.highlightGeometry, this.highlightMaterial);
        const activeHalo = new THREE.Points(this.highlightGeometry, this.highlightHaloMaterial);
        [cubeFace, cubeShell, cubeGrid, cubePoints, activeDot, activeHalo].forEach((child) => {
            child.frustumCulled = false;
        });
        activeDot.visible = false;
        activeHalo.visible = false;
        activeDot.name = 'BoxCubeActiveDot';
        activeHalo.name = 'BoxCubeActiveHalo';
        cubePoints.renderOrder = 1;
        activeHalo.renderOrder = 998;
        activeDot.renderOrder = 999;
        this.cubeRoot.add(cubeFace, cubeShell, cubeGrid, cubePoints, activeHalo, activeDot);
        this.cubeScene.add(this.cubeRoot);
        this.createRotatingLights();
    }
    setVisible(visible) {
        this.visible = visible;
        this.display.visible = visible;
        if (visible) {
            this.renderCubeToTarget();
        }
    }
    resize({ width, height, visibleWidth, visibleHeight, centerX, centerY, pixelRatio }) {
        this.display.position.set(centerX, centerY, -500);
        this.display.scale.set(visibleWidth, visibleHeight, 1);
        this.cubeCamera.aspect = width / Math.max(height, 1);
        this.cubeCamera.updateProjectionMatrix();
        this.renderTarget.setSize(Math.max(1, Math.floor(width * pixelRatio)), Math.max(1, Math.floor(height * pixelRatio)));
    }
    update({ deltaTime, activeWord, activeWordSourceIndex, language, frequencyLimit }) {
        const dt = Math.min(Math.max(deltaTime * 0.001, 0), 0.05);
        this.animTime += dt;
        const pointLanguage = language || 'english';
        this.updatePointLanguage(pointLanguage, frequencyLimit);
        this.updateActiveWord(activeWord || '', activeWordSourceIndex, pointLanguage);
        if (!this.visible)
            return;
        const t = this.animTime;
        this.cubeRoot.rotation.x = CUBE_BASE_ROTATION.x + Math.sin(t * 0.31) * 0.13;
        this.cubeRoot.rotation.y = CUBE_BASE_ROTATION.y + t * 0.115;
        this.cubeRoot.rotation.z = CUBE_BASE_ROTATION.z + Math.sin(t * 0.23 + 0.7) * 0.075;
        this.cubeRoot.scale.setScalar(1);
        // Keep the cube itself visually stable: no shell opacity or face-emissive pulsing.
        // Only the active red marker breathes, so the semantic target remains easy to find.
        const markerPulse = Math.sin(t * 4.2) * 0.5 + 0.5;
        // Dynamically apply logarithmic size/opacity based on dataset size
        const metrics = getSparsityMetrics(this.wordPoints.length);
        this.pointMaterial.size = metrics.size;
        this.pointMaterial.opacity = metrics.opacity;
        this.shellMaterial.opacity = 0.82;
        this.faceMaterial.emissiveIntensity = 0.045;
        this.highlightMaterial.size = this.activeIndex >= 0 ? 15 + markerPulse * 5 : 15;
        this.highlightMaterial.opacity = this.activeIndex >= 0 ? 0.84 + markerPulse * 0.12 : 0.0;
        this.highlightHaloMaterial.size = this.activeIndex >= 0 ? 36 + markerPulse * 10 : 36;
        this.highlightHaloMaterial.opacity = this.activeIndex >= 0 ? 0.26 + markerPulse * 0.10 : 0.0;
        this.lightOrbits.forEach((orbit, index) => {
            orbit.root.rotation.y = t * orbit.speed + orbit.phase;
            orbit.root.rotation.x = Math.sin(t * (0.19 + index * 0.04) + orbit.phase) * orbit.tilt;
            orbit.root.rotation.z = Math.cos(t * (0.16 + index * 0.05) + orbit.phase) * orbit.tilt * 0.65;
            orbit.light.intensity = 0.42;
            orbit.light.distance = orbit.radius * 2.4;
        });
        this.renderCubeToTarget();
    }
    updateColors({ accent, accent2 }) {
        this.accent.set(accent);
        this.accent2.set(accent2);
        this.faceMaterial.emissive.copy(this.accent);
        this.shellMaterial.color.copy(this.accent);
        this.gridMaterial.color.copy(this.accent);
        this.highlightMaterial.color.copy(this.accent2);
        this.highlightHaloMaterial.color.copy(this.accent2);
        this.lightOrbits.forEach((orbit, index) => {
            const lightColor = index === 1 ? this.accent2 : this.accent;
            orbit.light.color.copy(lightColor);
            orbit.sphere.material.color.copy(lightColor);
        });
        this.rebuildPointColors();
    }
    dispose() {
        this.mainScene.remove(this.display);
        this.cubeScene.remove(this.cubeRoot);
        this.lightOrbits.forEach(({ root, sphere }) => {
            this.cubeScene.remove(root);
            sphere.material.dispose();
        });
        this.display.geometry.dispose();
        this.display.material.dispose();
        this.renderTarget.dispose();
        this.pointGeometry.dispose();
        this.highlightGeometry.dispose();
        this.cubeFaceGeometry.dispose();
        this.cubeEdgeGeometry.dispose();
        this.cubeGridGeometry.dispose();
        this.lightSphereGeometry.dispose();
        this.faceMaterial.dispose();
        this.shellMaterial.dispose();
        this.gridMaterial.dispose();
        this.pointMaterial.dispose();
        this.highlightMaterial.dispose();
        this.highlightHaloMaterial.dispose();
    }
    createRotatingLights() {
        const lightSettings = [
            { color: this.accent, radius: 2.35, speed: 0.44, phase: 0.0, tilt: 0.55 },
            { color: this.accent2, radius: 2.05, speed: -0.36, phase: Math.PI * 0.72, tilt: 0.42 },
            { color: new THREE.Color('#ffffff'), radius: 2.60, speed: 0.24, phase: Math.PI * 1.34, tilt: 0.34 }
        ];
        lightSettings.forEach(({ color, radius, speed, phase, tilt }) => {
            const root = new THREE.Group();
            const light = new THREE.PointLight(color, 1.25, radius * 3.0, 1.5);
            const sphere = new THREE.Mesh(this.lightSphereGeometry, new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.72,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            }));
            light.position.set(radius, 0, 0);
            sphere.position.copy(light.position);
            sphere.visible = false;
            // Keep the rotating point lights, but do not render visible orbit markers.
            root.add(light);
            root.frustumCulled = false;
            sphere.frustumCulled = false;
            this.cubeScene.add(root);
            this.lightOrbits.push({ root, light, sphere, phase, speed, radius, tilt });
        });
    }
    buildPointCloudGeometry() {
        const positions = this.galaxyPointSet
            ? this.galaxyPointSet.positions
            : buildExpandedBoxPointPositions(this.wordPoints, CUBE_POINT_SCALE);
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
            // Use precomputed colors from the data layer — skip rebuildPointColors() iter
            this.basePointColors.set(this.galaxyPointSet.baseColors);
            this.livePointColors.set(this.galaxyPointSet.baseColors);
        }
        this.pointGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        this.pointGeometry.setAttribute('color', new THREE.BufferAttribute(this.livePointColors, 3));
        // Manual bounding sphere avoids NaN during Three.js auto-computation on huge position arrays
        this.pointGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100);
        this.pointGeometry.setDrawRange(0, Infinity);
        if (!this.galaxyPointSet) {
            this.rebuildPointColors();
        }
    }
    rebuildPointColors() {
        const attr = this.pointGeometry.getAttribute('color');
        const color = new THREE.Color();
        this.wordPoints.forEach(([, x, y, z], index) => {
            const semanticDepth = THREE.MathUtils.clamp((z + 0.82) / 1.64, 0, 1);
            const electricBand = Math.sin((x * 8.5) + (y * 5.0) + (z * 6.0)) * 0.5 + 0.5;
            // Calculate only the green intensity. Keep R and B strictly at 0.
            const greenIntensity = 0.2 + (semanticDepth * 0.5) + (electricBand * 0.3);
            color.setRGB(0, greenIntensity, 0);
            color.lerp(BASE_DOT_BRIGHT, 0.4);
            this.basePointColors[index * 3] = color.r;
            this.basePointColors[index * 3 + 1] = color.g;
            this.basePointColors[index * 3 + 2] = color.b;
        });
        this.livePointColors.set(this.basePointColors);
        if (this.activeIndex >= 0) {
            this.paintActivePoint(this.activeIndex);
        }
        if (attr)
            attr.needsUpdate = true;
    }
    updatePointLanguage(language, frequencyLimit) {
        if (isGalaxyLanguage(language)) {
            if (!this.galaxyLoadStarted) {
                this.galaxyLoadStarted = true;
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
                    this.hideActiveDot();
                })
                    .catch((error) => console.error('Failed to load galaxy data for Box Cube:', error));
            }
            else {
                loadGalaxyData(language).then((data) => {
                    // Only update the frequency gate — geometry stays (full cloud, no blink)
                    data.getPointSet(frequencyLimit);
                }).catch(() => undefined);
            }
            return;
        }
        this.galaxyPointSet = null;
        const nextPoints = getGraniteBoxWordPoints(language);
        if (nextPoints === this.wordPoints)
            return;
        this.wordPoints = nextPoints;
        this.activeWord = '';
        this.activeSourceIndex = undefined;
        this.activeIndex = -1;
        this.buildPointCloudGeometry();
        this.hideActiveDot();
    }
    hideActiveDot() {
        const activeDot = this.cubeRoot.getObjectByName('BoxCubeActiveDot');
        const activeHalo = this.cubeRoot.getObjectByName('BoxCubeActiveHalo');
        if (activeDot)
            activeDot.visible = false;
        if (activeHalo)
            activeHalo.visible = false;
    }
    addWordIndex(word, index) {
        getMatrixLookupKeys(word).forEach((key) => {
            if (key && !this.wordIndex.has(key)) {
                this.wordIndex.set(key, index);
            }
        });
    }
    lookupWordIndex(word) {
        for (const key of getMatrixLookupKeys(word)) {
            const index = this.wordIndex.get(key);
            if (index !== undefined)
                return index;
        }
        return -1;
    }
    updateActiveWord(rawWord, sourceIndex, language) {
        const normalized = getMatrixLookupKeys(rawWord)[0] || '';
        if (normalized === this.activeWord && sourceIndex === this.activeSourceIndex)
            return;
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
        const activeDot = this.cubeRoot.getObjectByName('BoxCubeActiveDot');
        const activeHalo = this.cubeRoot.getObjectByName('BoxCubeActiveHalo');
        if (index >= 0) {
            this.paintActivePoint(index);
            this.moveHighlightToPoint(index);
            if (activeDot)
                activeDot.visible = true;
            if (activeHalo)
                activeHalo.visible = true;
        }
        else {
            if (activeDot)
                activeDot.visible = false;
            if (activeHalo)
                activeHalo.visible = false;
        }
        const colorAttr = this.pointGeometry.getAttribute('color');
        colorAttr.needsUpdate = true;
    }
    paintActivePoint(index) {
        this.livePointColors[index * 3] = ACTIVE_DOT_COLOR.r;
        this.livePointColors[index * 3 + 1] = ACTIVE_DOT_COLOR.g;
        this.livePointColors[index * 3 + 2] = ACTIVE_DOT_COLOR.b;
    }
    moveHighlightToPoint(index) {
        const positions = this.pointGeometry.getAttribute('position');
        const highlightPositions = this.highlightGeometry.getAttribute('position');
        highlightPositions.setXYZ(0, positions.getX(index), positions.getY(index), positions.getZ(index));
        highlightPositions.needsUpdate = true;
        this.highlightGeometry.computeBoundingSphere();
    }
    renderCubeToTarget() {
        const previousRenderTarget = this.renderer.getRenderTarget();
        const previousClearColor = new THREE.Color();
        this.renderer.getClearColor(previousClearColor);
        const previousClearAlpha = this.renderer.getClearAlpha();
        this.renderer.setClearColor(0x02020c, 1);
        this.renderer.setRenderTarget(this.renderTarget);
        this.renderer.clear(true, true, true);
        this.renderer.render(this.cubeScene, this.cubeCamera);
        this.renderer.setRenderTarget(previousRenderTarget);
        this.renderer.setClearColor(previousClearColor, previousClearAlpha);
        this.displayUniforms.uTexture.value = this.renderTarget.texture;
    }
}
export const boxCubeTheme = {
    id: 'box-cube',
    label: 'Box Cube (3D)',
    kind: 'three',
    backgroundType: 'custom',
    renderOrder: BOX_CUBE_RENDER_ORDER,
    createBackground: (context) => new BoxCubeBackground(context, BOX_CUBE_RENDER_ORDER)
};
console.debug(`Box Cube uses up to ${GRANITE_BOX_MAX_DOTS_PER_LANGUAGE} Granite points across ${Object.keys(GRANITE_BOX_WORD_POINTS_BY_LANGUAGE).length} language sets from ${GRANITE_BOX_EMBEDDING_MODEL}`);
