import { defaultTheme } from './default.js';
import { highwayTheme } from './highway.js';
import { oceanTheme } from './ocean.js';
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
import { psy2Theme } from './psy2.js';
import { rollercoasterTheme } from './rollercoaster.js';
import { spaceTheme } from './space.js';
import { space2Theme } from './space2.js';
import { axiomataTheme } from './axiomata.js';
import { castleTheme } from './castle.js';
import { castleTheme as boxTheme } from './box.js';
export const THEME_OPTIONS = [
    defaultTheme,
    highwayTheme,
    oceanTheme,
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
    psy2Theme,
    rollercoasterTheme,
    spaceTheme,
    space2Theme,
    axiomataTheme,
    castleTheme,
    boxTheme
];
function isVideoTheme(theme) {
    return theme.kind === 'video';
}
function isThreeTheme(theme) {
    return theme.kind === 'three';
}
export const VIDEO_THEME_DEFINITIONS = THEME_OPTIONS.filter(isVideoTheme);
export const VIDEO_THEMES = Object.fromEntries(VIDEO_THEME_DEFINITIONS.map((theme) => [theme.id, { id: theme.youtubeId, maxStart: theme.maxStart }]));
export const THREE_BACKGROUND_THEMES = THEME_OPTIONS.filter(isThreeTheme);
export const THREE_THEME_BY_ID = Object.fromEntries(THREE_BACKGROUND_THEMES.map((theme) => [theme.id, theme]));
export function isThreeBackgroundTheme(themeId) {
    return Object.prototype.hasOwnProperty.call(THREE_THEME_BY_ID, themeId);
}
