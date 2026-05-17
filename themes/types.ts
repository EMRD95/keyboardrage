import * as THREE from 'three';

export type ThemeKind = 'css' | 'video' | 'three';

export type BaseThemeDefinition = {
  id: string;
  label: string;
  kind: ThemeKind;
};

export type CssThemeDefinition = BaseThemeDefinition & {
  kind: 'css';
};

export type VideoThemeDefinition = BaseThemeDefinition & {
  kind: 'video';
  youtubeId: string;
  maxStart: number;
};

export type ShaderUniformValue = {
  value: number | THREE.Vector2 | THREE.Color | THREE.Texture | null;
};

export type ThemeUniforms = {
  uTime: { value: number };
  uResolution: { value: THREE.Vector2 };
  uAccentA: { value: THREE.Color };
  uAccentB: { value: THREE.Color };
  uOpacity: { value: number };
} & Record<string, ShaderUniformValue>;

export type ThreeThemeResizeInfo = {
  width: number;
  height: number;
  visibleWidth: number;
  visibleHeight: number;
  centerX: number;
  centerY: number;
  pixelRatio: number;
};

export type ThreeThemeUpdateInfo = {
  timestamp: number;
  deltaTime: number;
  activeWord?: string;
  activeWordSourceIndex?: number;
  language?: string;
};

export type ThreeThemeColorInfo = {
  accent: string;
  accent2: string;
};

export type ThreeThemeRuntime = {
  setVisible: (visible: boolean) => void;
  resize: (info: ThreeThemeResizeInfo) => void;
  update: (info: ThreeThemeUpdateInfo) => void;
  updateColors?: (info: ThreeThemeColorInfo) => void;
  dispose?: () => void;
};

export type ThreeThemeContext = {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  logicalWidth: number;
  logicalHeight: number;
};

export type ShaderThreeThemeDefinition = BaseThemeDefinition & {
  kind: 'three';
  backgroundType?: 'shader';
  renderOrder: number;
  fragmentShader: string;
  opacity?: number;
  createUniforms?: () => Record<string, ShaderUniformValue>;
};

export type CustomThreeThemeDefinition = BaseThemeDefinition & {
  kind: 'three';
  backgroundType: 'custom';
  renderOrder: number;
  createBackground: (context: ThreeThemeContext) => ThreeThemeRuntime;
};

export type ThreeThemeDefinition = ShaderThreeThemeDefinition | CustomThreeThemeDefinition;

export type ThemeDefinition = CssThemeDefinition | VideoThemeDefinition | ThreeThemeDefinition;

export type VideoThemeEmbed = {
  id: string;
  maxStart: number;
};
