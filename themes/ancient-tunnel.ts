import * as THREE from 'three';

// --- Interfaces ---

export interface ThreeThemeContext {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  logicalWidth: number;
  logicalHeight: number;
}

export interface ThreeThemeResizeInfo {
  width: number;
  height: number;
  visibleWidth: number;
  visibleHeight: number;
  centerX: number;
  centerY: number;
  pixelRatio: number;
}

export interface ThreeThemeUpdateInfo {
  deltaTime: number;
}

export interface ThreeThemeRuntime {
  setVisible(visible: boolean): void;
  resize(info: ThreeThemeResizeInfo): void;
  update(info: ThreeThemeUpdateInfo): void;
  dispose(): void;
}

export interface CustomThreeThemeDefinition {
  id: string;
  label: string;
  kind: 'three';
  backgroundType: 'custom';
  renderOrder: number;
  createBackground: (context: ThreeThemeContext) => ThreeThemeRuntime;
}

// --- Shader Definitions ---

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

// --- Dynamic Texture Generation ---

function generateScriptureTextures(): { diffuse: THREE.CanvasTexture, bump: THREE.CanvasTexture } {
  const canvasSize = 1024;
  const canvas = document.createElement('canvas');
  const bumpCanvas = document.createElement('canvas');
  canvas.width = canvasSize;
  canvas.height = canvasSize;
  bumpCanvas.width = canvasSize;
  bumpCanvas.height = canvasSize;

  const ctx = canvas.getContext('2d')!;
  const bumpCtx = bumpCanvas.getContext('2d')!;

  // 1. Fill base backgrounds (clay/stone color for diffuse, mid-grey for bump)
  ctx.fillStyle = '#6e5c47'; // Base ancient stone/clay color
  ctx.fillRect(0, 0, canvasSize, canvasSize);
  
  bumpCtx.fillStyle = '#808080'; // Neutral bump
  bumpCtx.fillRect(0, 0, canvasSize, canvasSize);

  // 2. Add some procedural noise/grain to the stone base
  for (let i = 0; i < 40000; i++) {
    const x = Math.random() * canvasSize;
    const y = Math.random() * canvasSize;
    const l = Math.random() > 0.5 ? 255 : 0;
    ctx.fillStyle = `rgba(${l}, ${l}, ${l}, 0.03)`;
    ctx.fillRect(x, y, 2, 2);
    bumpCtx.fillStyle = `rgba(${l}, ${l}, ${l}, 0.02)`;
    bumpCtx.fillRect(x, y, 2, 2);
  }

  // 3. Setup text rendering
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  bumpCtx.textAlign = 'center';
  bumpCtx.textBaseline = 'middle';

  const cols = 22;
  const rows = 22;
  const stepX = canvasSize / cols;
  const stepY = canvasSize / rows;

  // 4. Draw random Ge'ez and Cuneiform characters
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Random chance to skip a character to look ancient and worn
      if (Math.random() > 0.85) continue;

      const isGeez = Math.random() > 0.5;
      let char = '';
      
      if (isGeez) {
        // Ge'ez Unicode Block (U+1200 - U+137F)
        char = String.fromCharCode(0x1200 + Math.floor(Math.random() * 380));
        ctx.font = 'bold 36px sans-serif';
        bumpCtx.font = 'bold 36px sans-serif';
      } else {
        // Sumerian Cuneiform Unicode Block (U+12000 - U+123FF)
        char = String.fromCodePoint(0x12000 + Math.floor(Math.random() * 800));
        ctx.font = '32px sans-serif';
        bumpCtx.font = '32px sans-serif';
      }

      const x = c * stepX + stepX / 2 + (Math.random() * 6 - 3);
      const y = r * stepY + stepY / 2 + (Math.random() * 6 - 3);
      const rotation = (Math.random() - 0.5) * 0.2;

      // Draw Diffuse (Dark etched ink/shadow)
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rotation);
      ctx.fillStyle = '#2b2118';
      // Slight alpha for natural wearing
      ctx.globalAlpha = 0.6 + Math.random() * 0.4;
      ctx.fillText(char, 0, 0);
      ctx.restore();

      // Draw Bump (Black pushes inward for depth)
      bumpCtx.save();
      bumpCtx.translate(x, y);
      bumpCtx.rotate(rotation);
      bumpCtx.fillStyle = '#000000';
      bumpCtx.globalAlpha = ctx.globalAlpha;
      bumpCtx.fillText(char, 0, 0);
      bumpCtx.restore();
    }
  }

  // 5. Create Three.js textures
  const diffuseTex = new THREE.CanvasTexture(canvas);
  diffuseTex.wrapS = THREE.RepeatWrapping;
  diffuseTex.wrapT = THREE.RepeatWrapping;
  diffuseTex.colorSpace = THREE.SRGBColorSpace;
  diffuseTex.needsUpdate = true;

  const bumpTex = new THREE.CanvasTexture(bumpCanvas);
  bumpTex.wrapS = THREE.RepeatWrapping;
  bumpTex.wrapT = THREE.RepeatWrapping;
  bumpTex.needsUpdate = true;

  return { diffuse: diffuseTex, bump: bumpTex };
}


// --- Theme Class Implementation ---

class AncientTunnelBackground implements ThreeThemeRuntime {
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
  
  // Adapted repeats for the dynamically generated square textures
  private textureParams = { offsetX: 0, offsetY: 0, repeatX: 10, repeatY: 4 };

  private currentWander = { x: 0.5, y: 0.5 };
  private animTime = 0;
  private visible = false;

  constructor(context: ThreeThemeContext, renderOrder: number) {
    this.mainScene = context.scene;
    this.renderer = context.renderer;

    // Dark sandy fog
    this.tunnelScene.fog = new THREE.Fog(0x1a1510, 0.8, 3.0);

    const hemiLight = new THREE.HemisphereLight(0xffffbb, 0x887979, 0.9 * Math.PI);
    this.tunnelScene.add(hemiLight);

    // Warmer directional light to look like torchlight
    const dirLight = new THREE.DirectionalLight(0xffeedd, 0.8 * Math.PI);
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

    // Immediate dynamic generation
    this.initDynamicTextures();
  }

  private initDynamicTextures() {
    const { diffuse, bump } = generateScriptureTextures();
    this.createTunnelMesh(diffuse, bump);
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
      bumpScale: 0.005,
      fog: true
    });

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

    this.tunnelTubeGeometry = new THREE.TubeGeometry(this.tunnelCurve, 70, 0.04, 4, false);
    this.tunnelTubeGeometry.rotateZ(Math.PI / 4);

    const positionArray = this.tunnelTubeGeometry.getAttribute('position').array as Float32Array;
    this.tunnelGeometryOrigins = new Float32Array(positionArray);

    this.tunnelMesh = new THREE.Mesh(this.tunnelTubeGeometry, tubeMaterial);
    
    // Apply initial repeating setup
    stoneTexture.repeat.set(this.textureParams.repeatX, this.textureParams.repeatY);
    bumpTexture.repeat.set(this.textureParams.repeatX, this.textureParams.repeatY);

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

    this.textureParams.offsetX += 0.005; // Slightly slower scroll
    map.offset.x = this.textureParams.offsetX;
    map.offset.y = this.textureParams.offsetY;

    const bump = this.tunnelMesh.material.bumpMap;
    if (bump) {
      bump.offset.x = this.textureParams.offsetX;
      bump.offset.y = this.textureParams.offsetY;
    }
  }

  private updateCameraPosition() {
    const targetX = 0.5 + Math.sin(this.animTime * 0.4) * 0.4;
    const targetY = 0.5 + Math.cos(this.animTime * 0.25) * 0.4;

    this.currentWander.x += (targetX - this.currentWander.x) / 50;
    this.currentWander.y += (targetY - this.currentWander.y) / 50;

    const mx = (this.currentWander.x - 0.5) * 2;
    const my = (this.currentWander.y - 0.5) * 2;

    this.tunnelCamera.rotation.z = mx * 0.2;
    this.tunnelCamera.rotation.y = Math.PI - mx * 0.06;
    this.tunnelCamera.position.x = mx * 0.015;
    this.tunnelCamera.position.y = -my * 0.015;
  }

  private updateCurve() {
    if (!this.tunnelCurve || !this.tunnelTubeGeometry || !this.tunnelGeometryOrigins || !this.tunnelSplineMesh) return;

    const mx = (this.currentWander.x - 0.5) * 2; 
    const my = (this.currentWander.y - 0.5) * 2; 

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
    
    const ringStride = 5; 
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

      tubePositions.setXYZ(i, cx + (ox + sx - cx) / 10, cy + (oy + sy - cy) / 10, oz);
    }
    tubePositions.needsUpdate = true;
  }

  private renderTunnelToTarget() {
    const previousRenderTarget = this.renderer.getRenderTarget();
    const previousClearColor = new THREE.Color();
    this.renderer.getClearColor(previousClearColor);
    const previousClearAlpha = this.renderer.getClearAlpha();

    // Matching fog color
    this.renderer.setClearColor(0x1a1510, 1);
    this.renderer.setRenderTarget(this.tunnelRenderTarget);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.tunnelScene, this.tunnelCamera);
    this.renderer.setRenderTarget(previousRenderTarget);
    this.renderer.setClearColor(previousClearColor, previousClearAlpha);

    this.tunnelDisplayUniforms.uTexture.value = this.tunnelRenderTarget.texture;
  }
}

// Default export structure tailored for the custom theme loader
export const ancientTunnelTheme: CustomThreeThemeDefinition = {
  id: 'ancient-tunnel',
  label: 'Ancient Tunnel (3D)',
  kind: 'three',
  backgroundType: 'custom',
  renderOrder: -91,
  createBackground: (context) => new AncientTunnelBackground(context, -91)
};
