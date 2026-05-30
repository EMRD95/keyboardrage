import type { ThemeDefinition, ThreeThemeDefinition, VideoThemeDefinition, VideoThemeEmbed } from './types.js';
import { defaultTheme } from './default.js';
import { psychedelicTheme } from './psychedelic.js';
import { psychedelicSpinTheme } from './psychedelic-spin.js';
import { fractalFlowTheme } from './fractal-flow.js';
import { deepFractalTheme } from './deep-fractal.js';
import { fractalTunnelTheme } from './fractal-tunnel.js';
import { kleinianAtmoTheme } from './kleinian-atmo.js';
import { aestrethraTheme } from './aestrethra.js';
import { infiniteTubesTheme } from './infinite-tubes.js';
import { hyperspaceTheme } from './hyperspace.js';
import { fractalWorldsTheme } from './fractal-worlds.js';
import { axiomataTheme } from './axiomata.js';
import { castleTheme } from './castle.js';
import { boxTheme } from './box.js';
import { boxCubeTheme } from './box-cube.js';
import { milkyWayTheme } from './milky-way.js';
import { ancientTunnelTheme } from './ancient-tunnel.js';

export const THEME_OPTIONS: ThemeDefinition[] = [
  defaultTheme,
  psychedelicTheme,
  psychedelicSpinTheme,
  fractalFlowTheme,
  deepFractalTheme,
  fractalTunnelTheme,
  kleinianAtmoTheme,
  aestrethraTheme,
  infiniteTubesTheme,
  hyperspaceTheme,
  fractalWorldsTheme,
  axiomataTheme,
  castleTheme,
  boxTheme,
  boxCubeTheme,
  milkyWayTheme,
  ancientTunnelTheme
];

function isVideoTheme(theme: ThemeDefinition): theme is VideoThemeDefinition {
  return theme.kind === 'video';
}

function isThreeTheme(theme: ThemeDefinition): theme is ThreeThemeDefinition {
  return theme.kind === 'three';
}

export const VIDEO_THEME_DEFINITIONS = THEME_OPTIONS.filter(isVideoTheme);

export const VIDEO_THEMES = Object.fromEntries(
  VIDEO_THEME_DEFINITIONS.map((theme) => [theme.id, { id: theme.youtubeId, maxStart: theme.maxStart }])
) as Record<string, VideoThemeEmbed>;

export const THREE_BACKGROUND_THEMES = THEME_OPTIONS.filter(isThreeTheme);

export const THREE_THEME_BY_ID = Object.fromEntries(
  THREE_BACKGROUND_THEMES.map((theme) => [theme.id, theme])
) as Record<string, ThreeThemeDefinition>;

export function isThreeBackgroundTheme(themeId: string) {
  return Object.prototype.hasOwnProperty.call(THREE_THEME_BY_ID, themeId);
}
