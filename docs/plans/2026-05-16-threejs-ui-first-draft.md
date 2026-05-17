# Three.js UI First Draft Implementation Plan

> **For Hermes:** Implement directly in this repository; no subagent handoff required for this first local draft.

**Goal:** Replace the old visible HTML canvas playfield with a modern Three.js-rendered playfield and a coherent cinematic UI while preserving KeyboardRage gameplay, WPM speed math, modes, scoring, language packs, YouTube themes, and spinner/psychedelic themes.

**Architecture:** Keep the existing Express/static app and TypeScript entrypoint. Convert `#game` from a `<canvas>` into a responsive playfield `<div>`, mount a Three.js `WebGLRenderer` inside it, and render falling words as textured Three.js sprites in an orthographic camera whose coordinate system mirrors the old 800x600 canvas. Keep all manual gameplay math intact: the WPM-to-fall-speed formula, infinite-ranked acceleration, typo penalties, precision calculation, and score POST payload.

**Tech Stack:** TypeScript, Three.js ES modules through browser import map + npm typings, Express static server, CSS variables/themes.

---

### Task 1: Add Three.js build/runtime support

**Objective:** Make `game.ts` compile with Three.js imports and make the browser resolve the Three.js module without adding a bundler.

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `index.html`

**Steps:**
1. Add `three` as a dependency and `typescript` + `@types/three` as dev dependencies.
2. Add `build` and `start` npm scripts.
3. Set `module: "ES2020"`, `moduleResolution: "bundler"`, and `skipLibCheck: true` in `tsconfig.json`.
4. Add an import map in `index.html` mapping `three` to `/node_modules/three/build/three.module.js` so localhost works without a bundler or CDN dependency.

**Verify:**
- Run `npm install`.
- Run `npm run build`.
- Expected: `game.js` emits successfully.

---

### Task 2: Modernize the page shell without changing IDs used by game logic

**Objective:** Replace the old centered canvas layout with a cinematic game shell, while keeping stable IDs for `wpm`, `language`, `mode`, `theme`, `player-name`, `settings-button`, `settings-menu`, `score`, `capsLockIndicator`, and `GamePaused`.

**Files:**
- Modify: `index.html`
- Modify: `styles.css`

**Steps:**
1. Replace `<canvas id="game">` with `<div id="game" class="game-stage" role="application" aria-label="KeyboardRage playfield"></div>`.
2. Add HUD regions for title, current score, WPM, active theme, player, and help text.
3. Keep the hidden mobile input and the YouTube iframe `#myVideo`.
4. Keep settings controls but present them in a glass/dark panel.
5. Preserve theme option values exactly.

**Verify:**
- Existing selectors still resolve in `game.ts`.
- Browser shows a playable stage and settings can open/close.

---

### Task 3: Replace canvas rendering with a Three.js renderer

**Objective:** Render falling words with Three.js while preserving the old coordinate/math behavior.

**Files:**
- Modify: `game.ts`

**Steps:**
1. Import Three.js.
2. Change the constructor parameter from `HTMLCanvasElement` to `HTMLElement`.
3. Initialize `THREE.Scene`, `THREE.OrthographicCamera`, and `THREE.WebGLRenderer({ alpha: true, antialias: true })`.
4. Use logical stage dimensions `800x600` to preserve old word placement and game-over threshold.
5. Convert each word into a `THREE.Sprite` backed by a canvas texture.
6. Redraw the word texture when typed text/color/current index changes.
7. In `animate`, move `sprite.position.y` from logical `word.y` and call `renderer.render(scene, camera)` instead of drawing text on the old canvas.
8. Preserve exactly: `lastWordSpeed = (this.WPM * 20) / 60 / 60 / this.averageCharLength`, `word.y += word.speed * deltaTime`, typo `speed *= 1.1`, and infinite WPM acceleration `+0.00001`.

**Verify:**
- Words fall at the same logical rate for equivalent WPM.
- Space is still displayed as `⎵`.
- Rage, precision, and fast modes behave as before.

---

### Task 4: Integrate themes coherently

**Objective:** Make all existing themes feel deliberate in the new UI.

**Files:**
- Modify: `game.ts`
- Modify: `styles.css`

**Steps:**
1. Keep the YouTube URLs and random start ranges for `highway`, `ocean`, `psy2`, `rollercoaster`, `space`, and `space2`.
2. Clear the iframe for non-video themes so old video backgrounds do not leak.
3. Use CSS variables per theme for accent colors, stage border, glow, and overlays.
4. Keep psychedelic and psychedelic-spin as CSS-generated animated backgrounds/spinners.
5. Add a visible theme label to the HUD.

**Verify:**
- Switching themes updates body `data-theme`, iframe background, and UI colors without breaking play.

---

### Task 5: Keep scoring and WPM/manual calculation coherent

**Objective:** Preserve the manual WPM model and expose it in the UI.

**Files:**
- Modify: `game.ts`
- Modify: `index.html`

**Steps:**
1. Do not alter score validation payload fields or mode suffix construction.
2. Reset `startTime`, `keystrokes`, and `typos` correctly on restart.
3. Update HUD with selected WPM and a compact “manual WPM model” hint.
4. Keep ranked WPMs unchanged: 30, 50, 100, 101, 150, 200, 250, 300, 350, 400.

**Verify:**
- Game over redirects to `/game-over.html?score=...&language=...&WPM=...`.
- LocalStorage values for precision, timeElapsed, mode, playerName are still written.

---

### Task 6: Browser smoke test

**Objective:** Verify the draft is usable locally.

**Files:**
- No code changes unless bugs are found.

**Steps:**
1. Run `npm run build`.
2. Run `npm start`.
3. Open `http://localhost:3000`.
4. Check console for JS errors.
5. Type through a few words, open settings, change WPM/theme/mode/language, pause/resume with Tab.

**Verify:**
- No blocking JS errors.
- Words render and fall in Three.js.
- Typing removes characters and increments score.
- Themes and settings remain usable.
