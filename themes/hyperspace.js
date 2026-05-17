import * as THREE from 'three';
const TUNNEL_DISPLAY_VERTEX_SHADER = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const TUNNEL_DISPLAY_FRAGMENT_SHADER = `
  precision highp float;

  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float uOpacity;

  void main() {
    vec4 tex = texture2D(uTexture, vUv);
    gl_FragColor = vec4(tex.rgb, tex.a * uOpacity);
  }
`;
class HyperspaceTunnelBackground {
    constructor(context, renderOrder) {
        this.tunnelScene = new THREE.Scene();
        this.tunnelMesh = null;
        this.tunnelTubeGeometry = null;
        this.tunnelGeometryOrigins = null;
        this.tunnelCurve = null;
        this.tunnelSplineMesh = null;
        this.textureParams = { offsetX: 0, offsetY: 0, repeatX: 10, repeatY: 4 };
        this.cameraShake = { x: 0, y: 0 };
        // Replaces mouse state with an internal procedural wander state
        this.currentWander = { x: 0.5, y: 0.5 };
        this.animTime = 0;
        this.visible = false;
        this.mainScene = context.scene;
        this.renderer = context.renderer;
        // Fog completely hides the far edge of the tunnel geometry to create infinite depth
        this.tunnelScene.fog = new THREE.Fog(0x000000, 1.0, 2.5);
        this.tunnelCamera = new THREE.PerspectiveCamera(15, context.logicalWidth / context.logicalHeight, 0.01, 1000);
        this.tunnelCamera.rotation.y = Math.PI;
        this.tunnelCamera.position.z = 0.35;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        this.tunnelRenderTarget = new THREE.WebGLRenderTarget(Math.floor(context.logicalWidth * pixelRatio), Math.floor(context.logicalHeight * pixelRatio), 
        // ENABLE DEPTH BUFFER: This is critical so the far end of the tunnel correctly 
        // hides behind the near walls when the tube bends.
        { depthBuffer: true, stencilBuffer: false });
        this.tunnelDisplayUniforms = {
            uTexture: { value: this.tunnelRenderTarget.texture },
            uOpacity: { value: 1.0 }
        };
        const displayGeometry = new THREE.PlaneGeometry(1, 1, 1, 1);
        const displayMaterial = new THREE.ShaderMaterial({
            uniforms: this.tunnelDisplayUniforms,
            vertexShader: TUNNEL_DISPLAY_VERTEX_SHADER,
            fragmentShader: TUNNEL_DISPLAY_FRAGMENT_SHADER,
            transparent: true,
            depthTest: false,
            depthWrite: false
        });
        this.tunnelDisplay = new THREE.Mesh(displayGeometry, displayMaterial);
        this.tunnelDisplay.visible = false;
        this.tunnelDisplay.renderOrder = renderOrder;
        this.tunnelDisplay.position.z = -500;
        this.mainScene.add(this.tunnelDisplay);
        this.initAnimation();
        this.loadGalaxyTunnelTexture();
    }
    setVisible(visible) {
        this.visible = visible;
        this.tunnelDisplay.visible = visible;
        if (visible) {
            this.updateAnimationTimeline();
            this.updateMaterialOffset();
            this.updateCameraPosition();
            this.updateCurve();
            this.renderTunnelToTarget();
        }
    }
    resize({ width, height, visibleWidth, visibleHeight, centerX, centerY, pixelRatio }) {
        this.tunnelDisplay.position.set(centerX, centerY, -500);
        this.tunnelDisplay.scale.set(visibleWidth, visibleHeight, 1);
        this.tunnelCamera.aspect = width / Math.max(height, 1);
        this.tunnelCamera.updateProjectionMatrix();
        this.tunnelRenderTarget.setSize(Math.max(1, Math.floor(width * pixelRatio)), Math.max(1, Math.floor(height * pixelRatio)));
    }
    update({ deltaTime }) {
        const dt = Math.min(Math.max(deltaTime * 0.001, 0), 0.05);
        this.animTime += dt;
        if (!this.visible)
            return;
        if (this.tunnelMesh) {
            this.updateAnimationTimeline();
            this.updateMaterialOffset();
            this.updateCameraPosition();
            this.updateCurve();
        }
        this.renderTunnelToTarget();
    }
    dispose() {
        this.mainScene.remove(this.tunnelDisplay);
        this.tunnelDisplay.geometry.dispose();
        this.tunnelDisplay.material.dispose();
        this.tunnelRenderTarget.dispose();
        this.tunnelTubeGeometry?.dispose();
        this.tunnelSplineMesh?.geometry.dispose();
        this.tunnelSplineMesh?.material?.dispose?.();
        this.tunnelMesh?.material.dispose();
        if (this.tunnelMesh)
            this.tunnelScene.remove(this.tunnelMesh);
    }
    initAnimation() {
        this.textureParams = {
            offsetX: 0,
            offsetY: 0,
            repeatX: 10,
            repeatY: 4
        };
        this.cameraShake = { x: 0, y: 0 };
    }
    loadGalaxyTunnelTexture() {
        const loader = new THREE.TextureLoader();
        loader.load('/assets/galaxyTexture.jpg', (texture) => {
            texture.wrapS = THREE.MirroredRepeatWrapping;
            texture.wrapT = THREE.MirroredRepeatWrapping;
            texture.repeat.set(this.textureParams.repeatX, this.textureParams.repeatY);
            texture.offset.set(this.textureParams.offsetX, this.textureParams.offsetY);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.needsUpdate = true;
            this.createTunnelMesh(texture);
        }, undefined, (error) => {
            console.error('Failed to load Hyperspace galaxy texture', error);
        });
    }
    createTunnelMesh(texture) {
        if (this.tunnelMesh) {
            this.tunnelScene.remove(this.tunnelMesh);
            this.tunnelTubeGeometry?.dispose();
            this.tunnelSplineMesh?.geometry.dispose();
            this.tunnelMesh.material.dispose();
        }
        const tubeMaterial = new THREE.MeshBasicMaterial({
            side: THREE.BackSide,
            map: texture,
            fog: true
        });
        // Create the foundational straight line curve that we will bend via vertex manipulation
        const points = [
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, 0, 0.75),
            new THREE.Vector3(0, 0, 1.5),
            new THREE.Vector3(0, 0, 2.25),
            new THREE.Vector3(0, 0, 3.0)
        ];
        this.tunnelCurve = new THREE.CatmullRomCurve3(points, false, 'catmullrom');
        // Generate reference spline geometry to track points mathematically
        const splineGeometry = new THREE.BufferGeometry().setFromPoints(this.tunnelCurve.getPoints(70));
        this.tunnelSplineMesh = new THREE.Line(splineGeometry, new THREE.LineBasicMaterial());
        // Generate the original rigid Tube geometry (radius bumped to 0.04 to give camera safe breathing room)
        this.tunnelTubeGeometry = new THREE.TubeGeometry(this.tunnelCurve, 70, 0.04, 30, false);
        // Save the completely straight cylinder so we have a fixed baseline to bend outward from
        const positionArray = this.tunnelTubeGeometry.getAttribute('position').array;
        this.tunnelGeometryOrigins = new Float32Array(positionArray);
        this.tunnelMesh = new THREE.Mesh(this.tunnelTubeGeometry, tubeMaterial);
        this.tunnelScene.add(this.tunnelMesh);
        if (this.visible) {
            this.updateAnimationTimeline();
            this.updateMaterialOffset();
            this.updateCameraPosition();
            this.updateCurve();
            this.renderTunnelToTarget();
        }
    }
    updateAnimationTimeline() {
        const cycle = this.animTime % 13;
        if (cycle < 4) {
            this.textureParams.repeatX = 10 + (0.3 - 10) * this.easePower1InOut(cycle / 4);
        }
        else if (cycle < 7) {
            this.textureParams.repeatX = 0.3;
        }
        else {
            this.textureParams.repeatX = 0.3 + (10 - 0.3) * this.easePower2InOut((cycle - 7) / 6);
        }
        this.textureParams.offsetX = cycle < 12 ? 8 * this.easePower2InOut(cycle / 12) : 8;
        this.textureParams.repeatY = 4;
        if (cycle < 4 || cycle >= 8) {
            this.cameraShake.x = 0;
        }
        else if (cycle < 6) {
            this.cameraShake.x = -0.01 * this.roughEase((cycle - 4) / 2, 1);
        }
        else {
            this.cameraShake.x = -0.01 * (1 - this.roughEase((cycle - 6) / 2, 2));
        }
    }
    updateMaterialOffset() {
        if (!this.tunnelMesh)
            return;
        const map = this.tunnelMesh.material.map;
        if (!map)
            return;
        this.textureParams.offsetY += 0.001;
        map.offset.x = this.textureParams.offsetX;
        map.offset.y = this.textureParams.offsetY;
        map.repeat.set(this.textureParams.repeatX, this.textureParams.repeatY);
    }
    updateCameraPosition() {
        // Generate a smooth procedural target using Lissajous curves (sine/cosine with different frequencies)
        // Oscillates smoothly between ~0.1 and ~0.9
        const targetX = 0.5 + Math.sin(this.animTime * 0.4) * 0.4;
        const targetY = 0.5 + Math.cos(this.animTime * 0.25) * 0.4;
        // Smoothly interpolate current wander state towards the procedural target
        this.currentWander.x += (targetX - this.currentWander.x) / 50;
        this.currentWander.y += (targetY - this.currentWander.y) / 50;
        this.tunnelCamera.position.x = this.currentWander.x * 0.044 - 0.025 + this.cameraShake.x;
        this.tunnelCamera.position.y = this.currentWander.y * 0.044 - 0.025;
    }
    updateCurve() {
        if (!this.tunnelCurve || !this.tunnelTubeGeometry || !this.tunnelGeometryOrigins || !this.tunnelSplineMesh) {
            return;
        }
        // Determine the max target bend coordinates based on the procedural wander state
        const bendX = (this.currentWander.x - 0.5) * 1.5;
        const bendY = (this.currentWander.y - 0.5) * 1.5;
        // Update the control points to form a perfectly smooth parabolic curve 
        // This stops CatmullRomCurve3 from zigzagging, twisting its Frenet frames, and pinching/folding the tube walls
        this.tunnelCurve.points[1].x = bendX * 0.0625;
        this.tunnelCurve.points[1].y = bendY * 0.0625;
        this.tunnelCurve.points[2].x = bendX * 0.25;
        this.tunnelCurve.points[2].y = bendY * 0.25;
        this.tunnelCurve.points[3].x = bendX * 0.5625;
        this.tunnelCurve.points[3].y = bendY * 0.5625;
        this.tunnelCurve.points[4].x = bendX;
        this.tunnelCurve.points[4].y = bendY;
        // Update our reference spline mesh
        const splinePositions = this.tunnelSplineMesh.geometry.getAttribute('position');
        const splineVerts = this.tunnelCurve.getPoints(70);
        for (let i = 0; i < splineVerts.length; i += 1) {
            splinePositions.setXYZ(i, splineVerts[i].x, splineVerts[i].y, splineVerts[i].z);
        }
        splinePositions.needsUpdate = true;
        // Perform high-performance vertex shifting. Instead of generating thousands of new polygons 
        // every frame, we just slide the rings of the original straight cylinder toward the new bent spline.
        const tubePositions = this.tunnelTubeGeometry.getAttribute('position');
        const origins = this.tunnelGeometryOrigins;
        const ringStride = 31; // 30 radialSegments + 1 duplicate seam vertex
        const maxSplineIndex = splinePositions.count - 1;
        for (let i = 0; i < tubePositions.count; i += 1) {
            const splineIndex = Math.min(maxSplineIndex, Math.floor(i / ringStride));
            const ox = origins[i * 3];
            const oy = origins[i * 3 + 1];
            const oz = origins[i * 3 + 2];
            const cx = tubePositions.getX(i);
            const cy = tubePositions.getY(i);
            const sx = splinePositions.getX(splineIndex);
            const sy = splinePositions.getY(splineIndex);
            tubePositions.setXYZ(i, cx + (ox + sx - cx) / 15, // smoothly interpolate current X position toward (Original_X + Spline_Target_X)
            cy + (oy + sy - cy) / 15, // smoothly interpolate current Y position toward (Original_Y + Spline_Target_Y)
            oz // Z spacing safely remains locked to its original generation intervals
            );
        }
        tubePositions.needsUpdate = true;
    }
    renderTunnelToTarget() {
        const previousRenderTarget = this.renderer.getRenderTarget();
        const previousClearColor = new THREE.Color();
        this.renderer.getClearColor(previousClearColor);
        const previousClearAlpha = this.renderer.getClearAlpha();
        this.renderer.setClearColor(0x000000, 1);
        this.renderer.setRenderTarget(this.tunnelRenderTarget);
        this.renderer.clear(true, true, true);
        this.renderer.render(this.tunnelScene, this.tunnelCamera);
        this.renderer.setRenderTarget(previousRenderTarget);
        this.renderer.setClearColor(previousClearColor, previousClearAlpha);
        this.tunnelDisplayUniforms.uTexture.value = this.tunnelRenderTarget.texture;
    }
    easePower1InOut(t) {
        const x = this.clamp(t, 0, 1);
        return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    }
    easePower2InOut(t) {
        const x = this.clamp(t, 0, 1);
        return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    }
    roughEase(t, seed) {
        const x = this.clamp(t, 0, 1);
        const jitter = (Math.sin((x * 37.0 + seed * 11.13) * Math.PI) * 0.09 +
            Math.sin((x * 91.0 + seed * 3.71) * Math.PI) * 0.04) * Math.sin(Math.PI * x);
        return this.clamp(x + jitter, 0, 1);
    }
    clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }
}
export const hyperspaceTheme = {
    id: 'hyperspace',
    label: 'Hyperspace (3D)',
    kind: 'three',
    backgroundType: 'custom',
    renderOrder: -94,
    createBackground: (context) => new HyperspaceTunnelBackground(context, -94)
};
