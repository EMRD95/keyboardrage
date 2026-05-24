import * as THREE from 'three';
import { GRANITE_BOX_WORD_POINTS, getGraniteBoxWordPoints, resolveGraniteBoxPointIndex } from './box-embedding-data.js';
import { isGalaxyLanguage, loadGalaxyData } from './galaxy-data.js';
const MILKY_WAY_RENDER_ORDER = -88;
const MILKY_WAY_POINT_SCALE = 1.90;
const ACTIVE_STAR_COLOR = new THREE.Color('#ffffff');
const CORE_WHITE = new THREE.Color('#ffffff');
const CORE_GOLD = new THREE.Color('#ffc966');
const BULGE_ORANGE = new THREE.Color('#ff7b00');
const HOT_MAGENTA = new THREE.Color('#ff4fd8');
const DUST_VIOLET = new THREE.Color('#9b5cff');
const DUST_BROWN = new THREE.Color('#c9713c');
const NEBULA_CYAN = new THREE.Color('#3399dd');
const NEBULA_BLUE = new THREE.Color('#3572ff');
const DEEP_SPACE = new THREE.Color('#3b2266');
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
        this.accent = new THREE.Color('#3399dd');
        this.accent2 = new THREE.Color('#ff4fd8');
        this.visible = false;
        this.animTime = 0;
        this.baseCamX = 0;
        this.baseCamY = 0.18;
        this.baseCamZ = 2.0;
        this.initGalaxyRotX = -0.18;
        this.initGalaxyRotY = 0;
        this.initGalaxyRotZ = -0.11;
        this.activeWord = '';
        this.activeIndex = -1;
        this.mainScene = context.scene;
        this.renderer = context.renderer;
        this.spaceScene.fog = new THREE.FogExp2(0x000000, 0.16);
        this.spaceCamera = new THREE.PerspectiveCamera(38, context.logicalWidth / context.logicalHeight, 0.01, 60);
        // Random initial 3D viewing angle — same distance, random orientation
        const camDist = 2.02;
        const theta = Math.random() * Math.PI * 2; // azimuth (0 to 2π)
        const phi = Math.acos(2 * Math.random() - 1) * 0.65 + 0.6; // polar, biased away from poles
        this.baseCamX = camDist * Math.sin(phi) * Math.cos(theta);
        this.baseCamY = camDist * Math.cos(phi);
        this.baseCamZ = camDist * Math.sin(phi) * Math.sin(theta);
        this.spaceCamera.position.set(this.baseCamX, this.baseCamY, this.baseCamZ);
        this.spaceCamera.lookAt(0, 0, 0);
        // Random initial galaxy rotation
        this.initGalaxyRotX = (Math.random() - 0.5) * 0.4;
        this.initGalaxyRotY = Math.random() * Math.PI * 2;
        this.initGalaxyRotZ = (Math.random() - 0.5) * 0.25;
        this.galaxyRoot.rotation.set(this.initGalaxyRotX, this.initGalaxyRotY, this.initGalaxyRotZ);
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
        const stars = new THREE.Points(this.pointGeometry, this.pointMaterial);
        const dust = new THREE.Points(this.pointGeometry, this.dustMaterial);
        stars.frustumCulled = false;
        dust.frustumCulled = false;
        stars.renderOrder = 1;
        dust.renderOrder = 0;
        this.galaxyRoot.add(dust, stars);
        this.highlightGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3));
        const activeHalo = new THREE.Points(this.highlightGeometry, this.activeHaloMaterial);
        const activeCore = new THREE.Points(this.highlightGeometry, this.activeCoreMaterial);
        activeHalo.name = 'MilkyWayActiveHalo';
        activeCore.name = 'MilkyWayActiveCore';
        [activeHalo, activeCore].forEach((child, index) => {
            child.frustumCulled = false;
            child.renderOrder = 997 + index;
        });
        this.activeGroup.add(activeHalo, activeCore);
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
        this.galaxyRoot.rotation.x = this.initGalaxyRotX + Math.sin(t * 0.11) * 0.045;
        this.galaxyRoot.rotation.y = this.initGalaxyRotY + t * 0.045;
        this.galaxyRoot.rotation.z = this.initGalaxyRotZ + Math.sin(t * 0.07 + 1.5) * 0.025;
        this.spaceCamera.position.x = this.baseCamX + Math.sin(t * 0.18) * 0.20;
        this.spaceCamera.position.y = this.baseCamY + Math.cos(t * 0.14) * 0.09;
        this.spaceCamera.position.z = this.baseCamZ + Math.cos(t * 0.22) * 0.15;
        this.spaceCamera.lookAt(0, 0, 0);
        const metrics = getStarMetrics(this.wordPoints.length);
        this.pointMaterial.size = metrics.size;
        this.pointMaterial.opacity = metrics.opacity;
        this.dustMaterial.size = metrics.size * 2.8;
        this.dustMaterial.opacity = metrics.opacity * 0.24;
        if (this.activeIndex >= 0) {
            const pulse = Math.sin(t * 2.7) * 0.5 + 0.5;
            const slow = Math.sin(t * 0.85) * 0.5 + 0.5;
            this.activeGroup.visible = true;
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
        const posAttr = this.pointGeometry.getAttribute('position');
        if (!posAttr)
            return;
        const color = new THREE.Color();
        const count = this.wordPoints.length;
        // 9-color palette for spatial clusters (original Milky Way hues)
        // Warm side: gold, orange, magenta, brown — Cool side: violet, cyan, blue, deep-space
        const PALETTE = [
            CORE_GOLD, // warm inner disk
            BULGE_ORANGE, // older stellar populations
            HOT_MAGENTA, // H-alpha emission nebulae
            DUST_BROWN, // dust lane brown
            DUST_VIOLET, // cooler regions / reflection nebulae
            NEBULA_CYAN, // young hot stars
            NEBULA_BLUE, // spiral arm blue giants
            DEEP_SPACE, // faint outer halo
            CORE_WHITE, // bright sparkle outlier
        ];
        const PALETTE_LEN = PALETTE.length;
        for (let i = 0; i < count; i += 1) {
            const px = posAttr.getX(i);
            const py = posAttr.getY(i);
            const pz = posAttr.getZ(i);
            // Distances
            const r3d = Math.sqrt(px * px + py * py + pz * pz);
            const radius = THREE.MathUtils.clamp(r3d / MILKY_WAY_POINT_SCALE, 0, 1);
            const zDist = Math.abs(pz);
            const zNorm = THREE.MathUtils.clamp(zDist / (MILKY_WAY_POINT_SCALE * 0.25), 0, 1);
            // Spatial noise for organic smoothing between clusters
            const nx = px * 3.5, ny = py * 3.5, nz = pz * 3.5;
            const clusterNoise1 = Math.sin(nx + ny) + Math.sin(ny + nz) + Math.sin(nz + nx);
            const clusterNoise2 = Math.sin(nx * 2.3 + ny * 2.1) + Math.sin(ny * 2.4 + nz * 2.2) + Math.sin(nz * 2.5 + nx * 2.0);
            const spatialNoise = (clusterNoise1 + clusterNoise2 * 0.5) / 4.5 + 0.5; // 0-1
            const n1 = hash01(i, 19);
            const n2 = hash01(i, 23);
            const isCore = radius < 0.12;
            const isBulge = radius < 0.25;
            // Plane dropoff — disk is flatter, bulge is rounder
            let planeDropoff = 1.0;
            if (!isBulge) {
                planeDropoff = Math.max(0.35, 1.0 - zNorm * 1.2);
            }
            else {
                planeDropoff = Math.max(0.6, 1.0 - zNorm * 0.6);
            }
            let brightness = 0;
            // === ORGANIC CONTINUOUS COLOR: multi-octave spatial noise ===
            // No grids, no hard edges — smooth flowing color from position
            // Nearby points naturally share similar hues; distant points diverge
            // Three-octave noise for primary hue (large + medium + fine scale)
            const hueNoise = Math.sin(px * 2.7 + py * 3.1) * 0.45 +
                Math.sin(py * 4.3 + pz * 5.1) * 0.30 +
                Math.sin(pz * 3.7 + px * 4.9) * 0.30 +
                Math.sin(px * 8.3 + pz * 6.1) * 0.20 +
                Math.sin(py * 9.1 + px * 7.3) * 0.18 +
                Math.sin(pz * 10.7 + py * 8.9) * 0.18;
            // Second noise channel for saturation-like variation
            const varNoise = Math.sin(px * 5.1 + pz * 6.7) * 0.40 +
                Math.sin(py * 7.9 + px * 5.3) * 0.30 +
                Math.sin(pz * 9.7 + py * 8.1) * 0.25;
            // Map hueNoise (-1.6 to 1.6) to palette index (0 to PALETTE_LEN-1)
            const hueNorm = THREE.MathUtils.clamp((hueNoise / 1.6) * 0.5 + 0.5, 0, 1);
            const palettePos = hueNorm * (PALETTE_LEN - 1);
            const idxA = Math.min(Math.floor(palettePos), PALETTE_LEN - 1);
            const idxB = Math.min(idxA + 1, PALETTE_LEN - 1);
            color.copy(PALETTE[idxA]).lerp(PALETTE[idxB], palettePos - idxA);
            // Subtle secondary variation — pull slightly toward a nearby palette neighbor
            const varShift = THREE.MathUtils.clamp((varNoise / 1.2) * 0.5 + 0.5, 0, 1);
            const shiftIdx = (idxA + 2 + Math.floor(varShift * 3)) % PALETTE_LEN;
            color.lerp(PALETTE[shiftIdx], 0.08 + varShift * 0.12); // 8-20% secondary tint
            if (isCore) {
                // Core: brightest, subtle white-hot glow on top
                const f = 1.0 - (radius / 0.12);
                brightness = 1.0 + f * 0.5 + n1 * 0.15;
                color.lerp(CORE_WHITE, 0.08 + f * 0.25); // 8-33% white glow
            }
            else if (isBulge) {
                // Bulge: bright, subtle gold warmth
                const f = 1.0 - ((radius - 0.12) / 0.13);
                brightness = 0.7 + f * 0.4 + spatialNoise * 0.3;
                color.lerp(CORE_GOLD, 0.05 + f * 0.20); // 5-25% gold warmth
            }
            else {
                // Disk: pure organic noise color, no warmth overlay
                const diskF = Math.max(0, 1.0 - ((radius - 0.25) / 0.75));
                brightness = 0.35 + diskF * 0.45 + spatialNoise * 0.25;
                brightness += (1.0 - zNorm) * 0.2;
            }
            brightness *= planeDropoff;
            // Occasional super-bright sparkle stars (~1.5% chance)
            if (n2 > 0.985) {
                brightness *= 1.6;
                color.lerp(CORE_WHITE, 0.8);
            }
            // Edge fade — outer regions dim smoothly
            const edgeFade = Math.max(0.2, 1.0 - Math.pow(radius, 2.5));
            brightness *= edgeFade;
            brightness = Math.max(0.15, brightness);
            brightness = Math.min(brightness, 1.5);
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
