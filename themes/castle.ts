import * as THREE from 'three';
import type { CustomThreeThemeDefinition, ThreeThemeContext, ThreeThemeResizeInfo, ThreeThemeRuntime, ThreeThemeUpdateInfo } from './types.js';

const CASTLE_DISPLAY_VERTEX_SHADER = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CASTLE_DISPLAY_FRAGMENT_SHADER = `
  precision highp float;

  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float uOpacity;

  void main() {
    vec4 tex = texture2D(uTexture, vUv);
    gl_FragColor = vec4(tex.rgb, tex.a * uOpacity);

    // Convert the linear render target math back to sRGB for the screen
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

class CastleTunnelBackground implements ThreeThemeRuntime {
  private readonly mainScene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly tunnelScene = new THREE.Scene();
  private readonly tunnelCamera: THREE.PerspectiveCamera;
  private readonly tunnelRenderTarget: THREE.WebGLRenderTarget;
  private readonly tunnelDisplay: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly tunnelDisplayUniforms: {
    uTexture: { value: THREE.Texture };
    uOpacity: { value: number };
  };

  private tunnelMesh: THREE.Mesh<THREE.TubeGeometry, THREE.MeshStandardMaterial> | null = null;
  private tunnelTubeGeometry: THREE.TubeGeometry | null = null;
  private tunnelGeometryOrigins: Float32Array | null = null;
  private tunnelCurve: THREE.CatmullRomCurve3 | null = null;
  private tunnelSplineMesh: THREE.Line | null = null;
  private textureParams = { offsetX: 0, offsetY: 0, repeatX: 30, repeatY: 6 };

  // Procedural wander state for natural movement
  private currentWander = { x: 0.5, y: 0.5 };
  private animTime = 0;
  private visible = false;

  constructor(context: ThreeThemeContext, renderOrder: number) {
    this.mainScene = context.scene;
    this.renderer = context.renderer;

    // Dark grey fog that seamlessly matches the clearColor to hide the far edge
    // Near set to 0.8, Far set to 3.0 to smoothly fade the narrowed end
    this.tunnelScene.fog = new THREE.Fog(0x222222, 0.8, 3.0);

    // Lights
    const hemiLight = new THREE.HemisphereLight(0xffffbb, 0x887979, 0.9 * Math.PI);
    this.tunnelScene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8 * Math.PI);
    dirLight.position.set(0, 1, 0.5);
    this.tunnelScene.add(dirLight);

    this.tunnelCamera = new THREE.PerspectiveCamera(15, context.logicalWidth / context.logicalHeight, 0.01, 1000);
    this.tunnelCamera.rotation.y = Math.PI;
    this.tunnelCamera.position.z = 0.35;

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.tunnelRenderTarget = new THREE.WebGLRenderTarget(
      Math.floor(context.logicalWidth * pixelRatio),
      Math.floor(context.logicalHeight * pixelRatio),
      { depthBuffer: true, stencilBuffer: false }
    );

    this.tunnelDisplayUniforms = {
      uTexture: { value: this.tunnelRenderTarget.texture },
      uOpacity: { value: 1.0 }
    };
    const displayGeometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    const displayMaterial = new THREE.ShaderMaterial({
      uniforms: this.tunnelDisplayUniforms,
      vertexShader: CASTLE_DISPLAY_VERTEX_SHADER,
      fragmentShader: CASTLE_DISPLAY_FRAGMENT_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false
    });
    this.tunnelDisplay = new THREE.Mesh(displayGeometry, displayMaterial);
    this.tunnelDisplay.visible = false;
    this.tunnelDisplay.renderOrder = renderOrder;
    this.tunnelDisplay.position.z = -500;
    this.mainScene.add(this.tunnelDisplay);

    this.loadCastleTextures();
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.tunnelDisplay.visible = visible;
    if (visible) {
      this.updateMaterialOffset();
      this.updateCameraPosition();
      this.updateCurve();
      this.renderTunnelToTarget();
    }
  }

  resize({ width, height, visibleWidth, visibleHeight, centerX, centerY, pixelRatio }: ThreeThemeResizeInfo) {
    this.tunnelDisplay.position.set(centerX, centerY, -500);
    this.tunnelDisplay.scale.set(visibleWidth, visibleHeight, 1);

    this.tunnelCamera.aspect = width / Math.max(height, 1);
    this.tunnelCamera.updateProjectionMatrix();

    this.tunnelRenderTarget.setSize(
      Math.max(1, Math.floor(width * pixelRatio)),
      Math.max(1, Math.floor(height * pixelRatio))
    );
  }

  update({ deltaTime }: ThreeThemeUpdateInfo) {
    const dt = Math.min(Math.max(deltaTime * 0.001, 0), 0.05);
    this.animTime += dt;

    if (!this.visible) return;

    if (this.tunnelMesh) {
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
    (this.tunnelSplineMesh?.material as THREE.Material | undefined)?.dispose?.();
    this.tunnelMesh?.material.dispose();
    if (this.tunnelMesh) this.tunnelScene.remove(this.tunnelMesh);
  }

  private loadCastleTextures() {
    const loader = new THREE.TextureLoader();

    let stoneTexture: THREE.Texture | null = null;
    let bumpTexture: THREE.Texture | null = null;
    let loadedCount = 0;

    const tryCreate = () => {
      loadedCount++;
      if (loadedCount < 2) return;
      if (!stoneTexture || !bumpTexture) return;
      this.createTunnelMesh(stoneTexture, bumpTexture);
    };

    loader.load(
      '/textures/stonePattern.jpg',
      (texture) => {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(this.textureParams.repeatX, this.textureParams.repeatY);
        texture.offset.set(this.textureParams.offsetX, this.textureParams.offsetY);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        stoneTexture = texture;
        tryCreate();
      },
      undefined,
      (error) => console.error('Castle: stone texture load error', error)
    );

    loader.load(
      '/textures/stonePatternBump.jpg',
      (texture) => {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(this.textureParams.repeatX, this.textureParams.repeatY);
        texture.needsUpdate = true;
        bumpTexture = texture;
        tryCreate();
      },
      undefined,
      (error) => console.error('Castle: bump texture load error', error)
    );
  }

  private createTunnelMesh(stoneTexture: THREE.Texture, bumpTexture: THREE.Texture) {
    if (this.tunnelMesh) {
      this.tunnelScene.remove(this.tunnelMesh);
      this.tunnelTubeGeometry?.dispose();
      this.tunnelSplineMesh?.geometry.dispose();
      this.tunnelMesh.material.dispose();
    }

    const tubeMaterial = new THREE.MeshStandardMaterial({
      side: THREE.BackSide,
      map: stoneTexture,
      bumpMap: bumpTexture,
      bumpScale: 0.0003,
      fog: true
    });

    // Pushed the depth to 3.2 to make the far end narrower before the fog fully covers it
    const points = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 0.8),
      new THREE.Vector3(0, 0, 1.6),
      new THREE.Vector3(0, 0, 2.4),
      new THREE.Vector3(0, 0, 3.2)
    ];
    this.tunnelCurve = new THREE.CatmullRomCurve3(points, false, 'catmullrom');

    const splineGeometry = new THREE.BufferGeometry().setFromPoints(this.tunnelCurve.getPoints(70));
    this.tunnelSplineMesh = new THREE.Line(splineGeometry, new THREE.LineBasicMaterial());

    // Using strictly 30 radial segments (like your working Hyperspace code) to prevent geometry twisting/tearing
    this.tunnelTubeGeometry = new THREE.TubeGeometry(this.tunnelCurve, 70, 0.04, 30, false);

    const positionArray = this.tunnelTubeGeometry.getAttribute('position').array as Float32Array;
    this.tunnelGeometryOrigins = new Float32Array(positionArray);

    this.tunnelMesh = new THREE.Mesh(this.tunnelTubeGeometry, tubeMaterial);
    this.tunnelScene.add(this.tunnelMesh);

    if (this.visible) {
      this.updateMaterialOffset();
      this.updateCameraPosition();
      this.updateCurve();
      this.renderTunnelToTarget();
    }
  }

  private updateMaterialOffset() {
    if (!this.tunnelMesh) return;
    const map = this.tunnelMesh.material.map;
    if (!map) return;

    this.textureParams.offsetX += 0.02;
    map.offset.x = this.textureParams.offsetX;
    map.offset.y = this.textureParams.offsetY;
    map.repeat.set(this.textureParams.repeatX, this.textureParams.repeatY);

    const bump = this.tunnelMesh.material.bumpMap;
    if (bump) {
      bump.offset.x = this.textureParams.offsetX;
      bump.offset.y = this.textureParams.offsetY;
      bump.repeat.set(this.textureParams.repeatX, this.textureParams.repeatY);
    }
  }

  private updateCameraPosition() {
    // Smooth procedural wander for natural movement
    const targetX = 0.5 + Math.sin(this.animTime * 0.4) * 0.4;
    const targetY = 0.5 + Math.cos(this.animTime * 0.25) * 0.4;

    this.currentWander.x += (targetX - this.currentWander.x) / 50;
    this.currentWander.y += (targetY - this.currentWander.y) / 50;

    const mx = (this.currentWander.x - 0.5) * 2;
    const my = (this.currentWander.y - 0.5) * 2;

    // Track the curve so the camera always looks at the stone walls, avoiding black holes
    this.tunnelCamera.rotation.z = mx * 0.2;
    this.tunnelCamera.rotation.y = Math.PI - mx * 0.06;
    this.tunnelCamera.position.x = mx * 0.015;
    this.tunnelCamera.position.y = -my * 0.015;
  }

  private updateCurve() {
    if (!this.tunnelCurve || !this.tunnelTubeGeometry || !this.tunnelGeometryOrigins || !this.tunnelSplineMesh) {
      return;
    }

    const mx = (this.currentWander.x - 0.5) * 2; 
    const my = (this.currentWander.y - 0.5) * 2; 

    // Gentle bending logic that prevents CatmullRomCurve3 from twisting and shattering the geometry
    this.tunnelCurve.points[2].x = -mx * 0.15;
    this.tunnelCurve.points[4].x = -mx * 0.15;
    this.tunnelCurve.points[2].y = my * 0.15;

    const splinePositions = this.tunnelSplineMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const splineVerts = this.tunnelCurve.getPoints(70);
    for (let i = 0; i < splineVerts.length; i += 1) {
      splinePositions.setXYZ(i, splineVerts[i].x, splineVerts[i].y, splineVerts[i].z);
    }
    splinePositions.needsUpdate = true;

    const tubePositions = this.tunnelTubeGeometry.getAttribute('position') as THREE.BufferAttribute;
    const origins = this.tunnelGeometryOrigins;
    const ringStride = 31; // 30 radialSegments + 1 duplicate seam vertex (Matches Hyperspace setup perfectly)
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

      // Uniform lerp speeds so the mesh smoothly interpolates without tearing diagonals
      tubePositions.setXYZ(
        i,
        cx + (ox + sx - cx) / 10,
        cy + (oy + sy - cy) / 10,
        oz
      );
    }
    tubePositions.needsUpdate = true;
  }

  private renderTunnelToTarget() {
    const previousRenderTarget = this.renderer.getRenderTarget();
    const previousClearColor = new THREE.Color();
    this.renderer.getClearColor(previousClearColor);
    const previousClearAlpha = this.renderer.getClearAlpha();

    // Exactly matches the fog to ensure the narrow end blends seamlessly
    this.renderer.setClearColor(0x222222, 1);
    this.renderer.setRenderTarget(this.tunnelRenderTarget);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.tunnelScene, this.tunnelCamera);
    this.renderer.setRenderTarget(previousRenderTarget);
    this.renderer.setClearColor(previousClearColor, previousClearAlpha);

    this.tunnelDisplayUniforms.uTexture.value = this.tunnelRenderTarget.texture;
  }
}

export const castleTheme: CustomThreeThemeDefinition = {
  id: 'castle',
  label: 'Castle (3D)',
  kind: 'three',
  backgroundType: 'custom',
  renderOrder: -91,
  createBackground: (context) => new CastleTunnelBackground(context, -91)
};
