import * as THREE from 'three';
import { GRANITE_BOX_WORD_POINTS, getGraniteBoxWordPoints, resolveGraniteBoxPointIndex } from './box-embedding-data.js';
import { isGalaxyLanguage, loadGalaxyData } from './galaxy-data.js';
const MILKY_WAY_RENDER_ORDER = -88;
const MILKY_WAY_POINT_SCALE = 1.90;
const ACTIVE_STAR_COLOR = new THREE.Color('#ffffff');
const CORE_WHITE = new THREE.Color('#ffffff');
const CORE_GOLD = new THREE.Color('#ffd36a');
const HOT_MAGENTA = new THREE.Color('#ff4fd8');
const DUST_VIOLET = new THREE.Color('#9b5cff');
const NEBULA_CYAN = new THREE.Color('#57efff');
const NEBULA_BLUE = new THREE.Color('#3572ff');
const DEEP_SPACE = new THREE.Color('#05020d');
const DISPLAY_VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const DISPLAY_FRAGMENT_SHADER = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float uOpacity;

  void main() {
    vec4 tex = texture2D(uTexture, vUv);
    vec2 p = vUv - 0.5;
    float vignette = smoothstep(0.92, 0.18, length(p));
    vec3 color = tex.rgb * (0.92 + vignette * 0.26);
    gl_FragColor = vec4(color, tex.a * uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
function normalizeLetters(value, stripAccents = false) {
    let normalized = value.trim().toLowerCase().normalize(stripAccents ? 'NFKD' : 'NFKC');
    if (stripAccents)
        normalized = normalized.replace(/[\u0300-\u036f]/g, '');
    return normalized.replace(/[^\p{L}]/gu, '');
}
function lookupKeys(value) {
    const exact = normalizeLetters(value, false);
    const folded = normalizeLetters(value, true);
    return exact === folded ? [exact] : [exact, folded];
}
function getStarMetrics(pointCount) {
    const logCount = Math.log10(Math.max(pointCount, 200));
    const sparsity = THREE.MathUtils.clamp(1.0 - (logCount - 2.3) / (5.47 - 2.3), 0, 1);
    const eased = sparsity * sparsity * (3 - 2 * sparsity);
    return {
        size: 0.010 + eased * 0.055,
        opacity: 0.22 + eased * 0.48
    };
}
function makeRadialTexture(size = 128, inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0.0, inner);
    gradient.addColorStop(0.22, inner);
    gradient.addColorStop(0.55, 'rgba(255,255,255,0.34)');
    gradient.addColorStop(1.0, outer);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}
function makeWideGlowTexture(size = 192) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    const center = size / 2;
    const gradient = ctx.createRadialGradient(center, center, 0, center, center, size * 0.50);
    gradient.addColorStop(0.00, 'rgba(255,255,255,0.82)');
    gradient.addColorStop(0.16, 'rgba(255,255,255,0.36)');
    gradient.addColorStop(0.42, 'rgba(255,255,255,0.13)');
    gradient.addColorStop(0.72, 'rgba(255,255,255,0.035)');
    gradient.addColorStop(1.00, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}
function hash01(index, salt) {
    const x = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453123;
    return x - Math.floor(x);
}
export class MilkyWayBackground {
    constructor(context, renderOrder = MILKY_WAY_RENDER_ORDER) {
        this.spaceScene = new THREE.Scene();
        this.galaxyRoot = new THREE.Group();
        this.pointGeometry = new THREE.BufferGeometry();
        this.highlightGeometry = new THREE.BufferGeometry();
        this.activeGroup = new THREE.Group();
        this.starTexture = makeRadialTexture(128);
        this.haloTexture = makeRadialTexture(192, 'rgba(255,255,255,0.95)');
        this.wideGlowTexture = makeWideGlowTexture(256);
        this.basePointColors = new Float32Array(0);
        this.livePointColors = new Float32Array(0);
        this.wordPoints = GRANITE_BOX_WORD_POINTS;
        this.wordIndex = new Map();
        this.sourceIndexToPointIndex = new Map();
        this.galaxyPointSet = null;
        this.galaxyLoadStarted = false;
        this.galaxyLanguage = null;
        this.accent = new THREE.Color('#57efff');
        this.accent2 = new THREE.Color('#ff4fd8');
        this.visible = false;
        this.animTime = 0;
        this.activeWord = '';
        this.activeIndex = -1;
        this.mainScene = context.scene;
        this.renderer = context.renderer;
        this.spaceScene.fog = new THREE.FogExp2(0x000000, 0.16);
        this.spaceCamera = new THREE.PerspectiveCamera(38, context.logicalWidth / context.logicalHeight, 0.01, 60);
        this.spaceCamera.position.set(0, 0.18, 4.8);
        this.spaceCamera.lookAt(0, 0, 0);
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        this.renderTarget = new THREE.WebGLRenderTarget(Math.floor(context.logicalWidth * pixelRatio), Math.floor(context.logicalHeight * pixelRatio), { depthBuffer: true, stencilBuffer: false });
        this.displayUniforms = { uTexture: { value: this.renderTarget.texture }, uOpacity: { value: 0.99 } };
        this.display = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), new THREE.ShaderMaterial({
            uniforms: this.displayUniforms,
            vertexShader: DISPLAY_VERTEX_SHADER,
            fragmentShader: DISPLAY_FRAGMENT_SHADER,
            transparent: true,
            depthTest: false,
            depthWrite: false
        }));
        this.display.visible = false;
        this.display.renderOrder = renderOrder;
        this.display.position.z = -500;
        this.mainScene.add(this.display);
        this.pointMaterial = new THREE.PointsMaterial({
            size: 0.012,
            sizeAttenuation: true,
            map: this.starTexture,
            alphaTest: 0.025,
            vertexColors: true,
            transparent: true,
            opacity: 0.36,
            depthTest: true,
            depthWrite: false,
            blending: THREE.NormalBlending
        });
        this.dustMaterial = new THREE.PointsMaterial({
            size: 0.030,
            sizeAttenuation: true,
            map: this.starTexture,
            alphaTest: 0.01,
            vertexColors: true,
            transparent: true,
            opacity: 0.12,
            depthTest: true,
            depthWrite: false,
            blending: THREE.NormalBlending
        });
        this.activeCoreMaterial = new THREE.PointsMaterial({
            size: 0.22,
            sizeAttenuation: true,
            map: this.starTexture,
            color: ACTIVE_STAR_COLOR,
            transparent: true,
            opacity: 1,
            depthTest: false,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.activeHaloMaterial = new THREE.PointsMaterial({
            size: 0.48,
            sizeAttenuation: true,
            map: this.haloTexture,
            color: NEBULA_CYAN,
            transparent: true,
            opacity: 0.42,
            depthTest: false,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        this.activeGlowMaterial = new THREE.PointsMaterial({
            size: 0.92,
            sizeAttenuation: true,
            map: this.wideGlowTexture,
            color: HOT_MAGENTA,
            transparent: true,
            opacity: 0.22,
            depthTest: false,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        const stars = new THREE.Points(this.pointGeometry, this.pointMaterial);
        const dust = new THREE.Points(this.pointGeometry, this.dustMaterial);
        stars.frustumCulled = false;
        dust.frustumCulled = false;
        stars.renderOrder = 1;
        dust.renderOrder = 0;
        this.galaxyRoot.add(dust, stars);
        this.highlightGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3));
        const activeGlow = new THREE.Points(this.highlightGeometry, this.activeGlowMaterial);
        const activeHalo = new THREE.Points(this.highlightGeometry, this.activeHaloMaterial);
        const activeCore = new THREE.Points(this.highlightGeometry, this.activeCoreMaterial);
        activeGlow.name = 'MilkyWayActiveGlow';
        activeHalo.name = 'MilkyWayActiveHalo';
        activeCore.name = 'MilkyWayActiveCore';
        [activeGlow, activeHalo, activeCore].forEach((child, index) => {
            child.frustumCulled = false;
            child.renderOrder = 997 + index;
        });
        this.activeGroup.add(activeGlow, activeHalo, activeCore);
        this.activeGroup.visible = false;
        this.galaxyRoot.add(this.activeGroup);
        this.spaceScene.add(this.galaxyRoot);
        this.spaceScene.add(new THREE.AmbientLight(0x14072a, 0.22));
        const coreLight = new THREE.PointLight(0xff4fd8, 1.10, 6.5, 1.6);
        coreLight.position.set(0, 0, 0.25);
        this.spaceScene.add(coreLight);
        this.buildPointCloudGeometry();
    }
    setVisible(visible) {
        this.visible = visible;
        this.display.visible = visible;
        if (visible)
            this.renderSpaceToTarget();
    }
    resize({ width, height, visibleWidth, visibleHeight, centerX, centerY, pixelRatio }) {
        this.display.position.set(centerX, centerY, -500);
        this.display.scale.set(visibleWidth, visibleHeight, 1);
        this.spaceCamera.aspect = width / Math.max(height, 1);
        this.spaceCamera.updateProjectionMatrix();
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
        this.galaxyRoot.rotation.x = -0.18 + Math.sin(t * 0.11) * 0.045;
        this.galaxyRoot.rotation.y = t * 0.045;
        this.galaxyRoot.rotation.z = -0.11 + Math.sin(t * 0.07 + 1.5) * 0.025;
        this.spaceCamera.position.x = Math.sin(t * 0.18) * 0.20;
        this.spaceCamera.position.y = 0.20 + Math.cos(t * 0.14) * 0.09;
        this.spaceCamera.lookAt(0, 0, 0);
        const metrics = getStarMetrics(this.wordPoints.length);
        this.pointMaterial.size = metrics.size;
        this.pointMaterial.opacity = metrics.opacity;
        this.dustMaterial.size = metrics.size * 2.8;
        this.dustMaterial.opacity = metrics.opacity * 0.24;
        if (this.activeIndex >= 0) {
            const pulse = Math.sin(t * 5.4) * 0.5 + 0.5;
            const slow = Math.sin(t * 1.7) * 0.5 + 0.5;
            this.activeGroup.visible = true;
            this.activeGlowMaterial.size = 0.86 + slow * 0.15 + pulse * 0.03;
            this.activeGlowMaterial.opacity = 0.14 + slow * 0.08;
            this.activeGlowMaterial.color.copy(HOT_MAGENTA).lerp(DUST_VIOLET, 0.32 + slow * 0.24);
            this.activeHaloMaterial.size = 0.38 + pulse * 0.08;
            this.activeHaloMaterial.opacity = 0.22 + pulse * 0.12;
            this.activeHaloMaterial.color.copy(NEBULA_CYAN).lerp(CORE_WHITE, 0.18 + slow * 0.16);
            this.activeCoreMaterial.size = 0.16 + pulse * 0.025;
            this.activeCoreMaterial.opacity = 0.84 + pulse * 0.10;
        }
        this.renderSpaceToTarget();
    }
    updateColors({ accent, accent2 }) {
        this.accent.set(accent);
        this.accent2.set(accent2);
        this.activeHaloMaterial.color.copy(NEBULA_CYAN);
        this.activeGlowMaterial.color.copy(HOT_MAGENTA);
        this.rebuildPointColors();
    }
    dispose() {
        this.mainScene.remove(this.display);
        this.spaceScene.remove(this.galaxyRoot);
        this.display.geometry.dispose();
        this.display.material.dispose();
        this.renderTarget.dispose();
        this.pointGeometry.dispose();
        this.highlightGeometry.dispose();
        this.pointMaterial.dispose();
        this.dustMaterial.dispose();
        this.activeCoreMaterial.dispose();
        this.activeHaloMaterial.dispose();
        this.activeGlowMaterial.dispose();
        this.starTexture.dispose();
        this.haloTexture.dispose();
        this.wideGlowTexture.dispose();
    }
    buildPointCloudGeometry() {
        const positions = this.buildRawPreprocessedPositions();
        this.basePointColors = new Float32Array(this.wordPoints.length * 3);
        this.livePointColors = new Float32Array(this.wordPoints.length * 3);
        this.wordIndex.clear();
        this.sourceIndexToPointIndex.clear();
        if (this.galaxyPointSet) {
            this.galaxyPointSet.sourceIndexToPointIndex.forEach((pointIndex, sourceIndex) => {
                this.sourceIndexToPointIndex.set(sourceIndex, pointIndex);
            });
        }
        else {
            this.wordPoints.forEach(([word], index) => this.addWordIndex(word, index));
        }
        this.pointGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        this.pointGeometry.setAttribute('color', new THREE.BufferAttribute(this.livePointColors, 3));
        this.pointGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100);
        this.pointGeometry.setDrawRange(0, Infinity);
        this.rebuildPointColors();
    }
    buildRawPreprocessedPositions() {
        const count = this.wordPoints.length;
        const positions = new Float32Array(count * 3);
        let cx = 0, cy = 0, cz = 0;
        for (let i = 0; i < count; i += 1) {
            const [, x, y, z] = this.wordPoints[i];
            cx += x || 0;
            cy += y || 0;
            cz += z || 0;
        }
        cx /= Math.max(count, 1);
        cy /= Math.max(count, 1);
        cz /= Math.max(count, 1);
        let maxDist = 1e-6;
        for (let i = 0; i < count; i += 1) {
            const [, x, y, z] = this.wordPoints[i];
            const dx = (x || 0) - cx;
            const dy = (y || 0) - cy;
            const dz = (z || 0) - cz;
            maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
        const scale = MILKY_WAY_POINT_SCALE / maxDist;
        for (let i = 0; i < count; i += 1) {
            const [, x, y, z] = this.wordPoints[i];
            positions[i * 3] = ((x || 0) - cx) * scale;
            positions[i * 3 + 1] = ((y || 0) - cy) * scale;
            positions[i * 3 + 2] = ((z || 0) - cz) * scale;
        }
        return positions;
    }
    rebuildPointColors() {
        const attr = this.pointGeometry.getAttribute('color');
        const color = new THREE.Color();
        const count = this.wordPoints.length;
        for (let i = 0; i < count; i += 1) {
            const [_, x, y, z] = this.wordPoints[i];
            const radius = THREE.MathUtils.clamp(Math.sqrt(x * x + y * y + z * z) / 1.42, 0, 1);
            const band = Math.sin(x * 6.8 + y * 9.1 + z * 4.7) * 0.5 + 0.5;
            const hueChoice = hash01(i, 19);
            if (radius < 0.18) {
                color.copy(CORE_WHITE).lerp(CORE_GOLD, band * 0.48);
            }
            else if (radius < 0.42) {
                color.copy(CORE_GOLD).lerp(HOT_MAGENTA, 0.30 + band * 0.40);
            }
            else if (hueChoice < 0.28) {
                color.copy(HOT_MAGENTA).lerp(DUST_VIOLET, band * 0.62);
            }
            else if (hueChoice < 0.58) {
                color.copy(DUST_VIOLET).lerp(NEBULA_BLUE, band * 0.58);
            }
            else if (hueChoice < 0.82) {
                color.copy(NEBULA_CYAN).lerp(NEBULA_BLUE, 0.22 + band * 0.50);
            }
            else {
                color.copy(CORE_WHITE).lerp(DEEP_SPACE, 0.14 + band * 0.22);
            }
            const brightness = 0.48 + (1.0 - radius) * 0.42 + hash01(i, 23) * 0.18;
            this.basePointColors[i * 3] = color.r * brightness;
            this.basePointColors[i * 3 + 1] = color.g * brightness;
            this.basePointColors[i * 3 + 2] = color.b * brightness;
        }
        this.livePointColors.set(this.basePointColors);
        if (this.activeIndex >= 0)
            this.paintActivePoint(this.activeIndex);
        if (attr)
            attr.needsUpdate = true;
    }
    updatePointLanguage(language, frequencyLimit) {
        if (isGalaxyLanguage(language)) {
            if (!this.galaxyLoadStarted) {
                this.galaxyLoadStarted = true;
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
                    this.hideActiveStar();
                })
                    .catch((error) => console.error('Failed to load galaxy data for Milky Way:', error));
            }
            else if (language !== this.galaxyLanguage) {
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
                    this.hideActiveStar();
                })
                    .catch((error) => console.error('Failed to switch galaxy language in Milky Way:', error));
            }
            else {
                loadGalaxyData(language).then((data) => data.getPointSet(frequencyLimit)).catch(() => undefined);
            }
            return;
        }
        this.galaxyPointSet = null;
        this.galaxyLoadStarted = false;
        this.galaxyLanguage = null;
        const nextPoints = getGraniteBoxWordPoints(language);
        if (nextPoints === this.wordPoints)
            return;
        this.wordPoints = nextPoints;
        this.activeWord = '';
        this.activeSourceIndex = undefined;
        this.activeIndex = -1;
        this.buildPointCloudGeometry();
        this.hideActiveStar();
    }
    hideActiveStar() {
        this.activeGroup.visible = false;
    }
    addWordIndex(word, index) {
        lookupKeys(word).forEach((key) => {
            if (key && !this.wordIndex.has(key))
                this.wordIndex.set(key, index);
        });
    }
    lookupWordIndex(word) {
        for (const key of lookupKeys(word)) {
            const index = this.wordIndex.get(key);
            if (index !== undefined)
                return index;
        }
        return -1;
    }
    updateActiveWord(rawWord, sourceIndex, language) {
        const normalized = lookupKeys(rawWord)[0] || '';
        if (normalized === this.activeWord && sourceIndex === this.activeSourceIndex)
            return;
        this.activeWord = normalized;
        this.activeSourceIndex = sourceIndex;
        const routedIndex = sourceIndex !== undefined ? this.sourceIndexToPointIndex.get(sourceIndex) : undefined;
        const gatedIndex = (routedIndex !== undefined && this.galaxyPointSet && sourceIndex !== undefined && sourceIndex >= this.galaxyPointSet.frequencyLimit)
            ? undefined
            : routedIndex;
        const clusterIndex = gatedIndex !== undefined ? gatedIndex : resolveGraniteBoxPointIndex(language, sourceIndex);
        const index = clusterIndex >= 0 ? clusterIndex : (normalized ? this.lookupWordIndex(rawWord) : -1);
        this.activeIndex = index;
        this.livePointColors.set(this.basePointColors);
        if (index >= 0) {
            this.paintActivePoint(index);
            this.moveActiveStarToPoint(index);
            this.activeGroup.visible = true;
        }
        else {
            this.hideActiveStar();
        }
        const colorAttr = this.pointGeometry.getAttribute('color');
        colorAttr.needsUpdate = true;
    }
    paintActivePoint(index) {
        this.livePointColors[index * 3] = ACTIVE_STAR_COLOR.r;
        this.livePointColors[index * 3 + 1] = ACTIVE_STAR_COLOR.g;
        this.livePointColors[index * 3 + 2] = ACTIVE_STAR_COLOR.b;
    }
    moveActiveStarToPoint(index) {
        const positions = this.pointGeometry.getAttribute('position');
        const highlightPositions = this.highlightGeometry.getAttribute('position');
        highlightPositions.setXYZ(0, positions.getX(index), positions.getY(index), positions.getZ(index));
        highlightPositions.needsUpdate = true;
        this.highlightGeometry.computeBoundingSphere();
    }
    renderSpaceToTarget() {
        const previousRenderTarget = this.renderer.getRenderTarget();
        const previousClearColor = new THREE.Color();
        this.renderer.getClearColor(previousClearColor);
        const previousClearAlpha = this.renderer.getClearAlpha();
        this.renderer.setClearColor(0x000000, 1);
        this.renderer.setRenderTarget(this.renderTarget);
        this.renderer.clear(true, true, true);
        this.renderer.render(this.spaceScene, this.spaceCamera);
        this.renderer.setRenderTarget(previousRenderTarget);
        this.renderer.setClearColor(previousClearColor, previousClearAlpha);
        this.displayUniforms.uTexture.value = this.renderTarget.texture;
    }
}
export const milkyWayTheme = {
    id: 'milky-way',
    label: 'Milky Way (3D)',
    kind: 'three',
    backgroundType: 'custom',
    renderOrder: MILKY_WAY_RENDER_ORDER,
    createBackground: (context) => new MilkyWayBackground(context, MILKY_WAY_RENDER_ORDER)
};
