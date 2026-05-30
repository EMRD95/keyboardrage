import * as THREE from 'three';
import { FRACTAL_VERTEX_SHADER } from './themes/shader-core.js';
import { THEME_OPTIONS, VIDEO_THEMES, isThreeBackgroundTheme, THREE_THEME_BY_ID } from './themes/registry.js';
import { shouldIgnoreDeadAccentKey, typedKeyPrefixLength } from './typing-input.js';
import { effectiveAverageWordLength, textDirectionForLanguage, needsShapedRendering } from './language-support.js';
const LOGICAL_WIDTH = 800;
const LOGICAL_HEIGHT = 600;
// ── WPM → fall speed derivation ──────────────────────────────────
// Standard international definition: 1 WPM = 5 correct keystrokes
// per minute (the space between words counts as one of the 5).  In
// KeyboardRage the word completes on its last character — no trailing
// space required — so each game-word of L characters costs exactly
// L keystrokes.
//
// Words are stacked 80 px apart.  After typing word N in msPerWord ms,
// word N+1 has fallen S × msPerWord px.  For the game to require
// exactly WPM typing speed, word N+1 must occupy the same position
// word N had when it was active — no harder, no easier:
//
//   S × msPerWord = 80          ⇔    S = 80 / msPerWord
//
// keystrokesPerWord = averageCharLength + 1: the +1 accounts for the
// trailing space that applyGrammar() always appends (line 618), even
// when grammar mode is off.  The player must type that space to
// complete the word — it's a real keystroke, not a difficulty margin.
//
// If the player types at WPM:    words stay at y=0 indefinitely.
// If the player types slower:    words creep downward → game over.
// If the player types faster:    words creep upward → margin earned.
//
// Framerate-independent: animate() uses performance.now() deltaTime
// (ms), so word.y += speed × deltaTime is correct at any fps.
const CHARS_PER_STANDARD_WORD = 5; // international WPM definition
const MS_PER_MINUTE = 60000;
const WORD_SPACING = 80; // px between consecutive words
const WORD_FONT_SIZE = 48;
const WORD_FONT = `700 ${WORD_FONT_SIZE}px 'Roboto', 'Inter', system-ui, -apple-system, sans-serif`;
const WORD_FILL = '#f8f8f2';
const WORD_MUTED = '#777777';
const WORD_DANGER = '#FF0000';
const DEFAULT_THEME = 'milky-way';
const DEFAULT_LANGUAGE = 'english';
const DEFAULT_FREQUENCY_LIMIT = 200;
const CUSTOM_YOUTUBE_THEME_ID = 'custom-youtube';
/** Extract a YouTube video ID from any common URL format.
 *  Supported: watch?v=, youtu.be/, embed/, shorts/, or bare ID.
 *  Returns null if the input doesn't look like a valid YouTube ID. */
function extractYouTubeId(input) {
    if (!input)
        return null;
    const trimmed = input.trim();
    // Bare 11-char ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed))
        return trimmed;
    try {
        const url = new URL(trimmed);
        // youtu.be/VIDEO_ID
        if (url.hostname.endsWith('youtu.be')) {
            const id = url.pathname.slice(1).split('/')[0];
            return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
        }
        // youtube.com/watch?v=VIDEO_ID
        if (url.hostname.includes('youtube.com')) {
            const id = url.searchParams.get('v');
            if (id && /^[a-zA-Z0-9_-]{11}$/.test(id))
                return id;
            // youtube.com/embed/VIDEO_ID or youtube.com/shorts/VIDEO_ID
            const parts = url.pathname.split('/').filter(Boolean);
            if ((parts[0] === 'embed' || parts[0] === 'shorts') && /^[a-zA-Z0-9_-]{11}$/.test(parts[1])) {
                return parts[1];
            }
        }
    }
    catch { /* not a valid URL, try bare ID below */ }
    return null;
}
class Game {
    constructor(container, playerName, WPM = 60, language = DEFAULT_LANGUAGE) {
        this.ambientParticles = null;
        this.ambientParticleMaterial = null;
        this.threeThemeInstances = new Map();
        this.isGameOver = false;
        this.batchSize = 10;
        this.wordIndex = 0;
        this.animationFrame = null;
        this.mode = localStorage.getItem('mode') || 'rage';
        this.applyGrammarSetting = localStorage.getItem('applyGrammar') === 'true';
        this.addNumbersSetting = localStorage.getItem('addNumbers') === 'true';
        this.requireDiacriticsSetting = localStorage.getItem('requireDiacritics') !== 'false';
        this.pendingDeadAccentKey = null;
        this.semanticActive = false;
        this.semanticAllWords = [];
        this.semanticRawWords = [];
        // HUD dirty-check: skip DOM writes when value unchanged
        this._hudScore = -1;
        this._hudWpm = -1;
        this._hudTheme = '';
        this._hudMode = '';
        this.semanticDebounceTimer = null;
        this.theme = (() => {
            const savedTheme = localStorage.getItem('theme');
            return savedTheme && (THEME_OPTIONS.some(t => t.id === savedTheme) || savedTheme === 'custom-youtube') ? savedTheme : DEFAULT_THEME;
        })();
        this.frequencyLimit = (() => {
            const savedLimit = localStorage.getItem('frequencyLimit');
            if (!savedLimit || savedLimit === '1000')
                return DEFAULT_FREQUENCY_LIMIT;
            return Number(savedLimit) || DEFAULT_FREQUENCY_LIMIT;
        })();
        this.themeLoader = null;
        this.themeLoaderText = null;
        this.startSequence = 0;
        this.telemetry = this.createTelemetry();
        this.activeWordStartedAt = 0;
        this.activeWordKeystrokes = 0;
        this.activeWordTypos = 0;
        this.container = container;
        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(0, LOGICAL_WIDTH, LOGICAL_HEIGHT, 0, -1000, 1000);
        this.camera.position.z = 10;
        this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.domElement.className = 'three-canvas';
        this.renderer.domElement.setAttribute('aria-hidden', 'true');
        this.container.appendChild(this.renderer.domElement);
        this.measureCanvas = document.createElement('canvas');
        const measureContext = this.measureCanvas.getContext('2d');
        if (!measureContext) {
            throw new Error('Could not initialize text measurement context.');
        }
        this.measureContext = measureContext;
        this.measureContext.font = WORD_FONT;
        this.WPM = localStorage.getItem('WPM') ? parseInt(localStorage.getItem('WPM'), 10) : WPM;
        this.words = [];
        this.wordList = [];
        this.score = 0;
        this.language = localStorage.getItem('language') || language;
        this.originalWPM = this.WPM;
        this.playerName = localStorage.getItem('playerName') || playerName;
        this.pause = false;
        this.timeElapsed = 0;
        this.keystrokes = 0;
        this.startTime = Date.now();
        this.allWords = [];
        this.averageCharLength = 5;
        this.lastTimestamp = performance.now();
        this.settingsButton = document.getElementById('settings-button');
        this.settingsMenu = document.getElementById('settings-menu');
        this.settingsButton.addEventListener('click', this.toggleSettingsMenu.bind(this));
        document.addEventListener('click', this.closeSettingsMenuIfClickedOutside.bind(this));
        this.typos = 0;
        this.grammarCheckbox = document.getElementById('grammar');
        this.grammarCheckbox.checked = this.applyGrammarSetting;
        this.grammarCheckbox.addEventListener('change', this.toggleApplyGrammar.bind(this));
        this.addNumbersCheckbox = document.getElementById('addNumbers');
        this.addNumbersCheckbox.checked = this.addNumbersSetting;
        this.addNumbersCheckbox.addEventListener('change', this.toggleAddNumbers.bind(this));
        this.requireDiacriticsCheckbox = document.getElementById('diacritics');
        this.requireDiacriticsCheckbox.checked = this.requireDiacriticsSetting;
        this.requireDiacriticsCheckbox.addEventListener('change', this.toggleRequireDiacritics.bind(this));
        this.themeSelector = document.getElementById('theme');
        this.themeLoader = document.getElementById('theme-loader');
        this.themeLoaderText = document.getElementById('theme-loader-text');
        this.populateThemeSelector();
        this.themeSelector.value = this.theme;
        if (!this.themeSelector.value) {
            this.themeSelector.value = DEFAULT_THEME;
            this.theme = DEFAULT_THEME;
        }
        this.themeSelector.addEventListener('change', this.changeTheme.bind(this));
        this.createThemeBackgrounds();
        this.resizeRenderer();
        // Warm up WebGL so the first animation frame isn't a stutter
        this.renderer.render(this.scene, this.camera);
        window.addEventListener('resize', this.resizeRenderer.bind(this));
        this.createAmbientParticles();
        this.changeTheme();
        this.updateHud();
        this.initSemanticSearch();
        this._boundAnimate = this.animate.bind(this);
    }
    static async create(container, playerName = 'Player', WPM = 60, language = DEFAULT_LANGUAGE) {
        await document.fonts.load('700 48px Roboto');
        const game = new Game(container, playerName, WPM, language);
        await game.fetchWords();
        return game;
    }
    getLanguage() {
        return this.language;
    }
    getWPM() {
        return this.WPM;
    }
    getMode() {
        return this.mode;
    }
    getFrequencyLimit() {
        return this.frequencyLimit;
    }
    getTheme() {
        return this.theme;
    }
    resizeRenderer() {
        const rect = this.container.getBoundingClientRect();
        const width = Math.max(320, Math.floor(rect.width || LOGICAL_WIDTH));
        const height = Math.max(240, Math.floor(rect.height || LOGICAL_HEIGHT));
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.setSize(width, height, false);
        // Keep the original 800x600 gameplay plane and WPM fall calibration, but
        // adapt the orthographic camera to the browser viewport so the Three.js
        // sprites are not visually stretched when the stage becomes full-screen.
        const baseAspect = LOGICAL_WIDTH / LOGICAL_HEIGHT;
        const viewportAspect = width / height;
        if (viewportAspect >= baseAspect) {
            const visibleWidth = LOGICAL_HEIGHT * viewportAspect;
            const horizontalBleed = (visibleWidth - LOGICAL_WIDTH) / 2;
            this.camera.left = -horizontalBleed;
            this.camera.right = LOGICAL_WIDTH + horizontalBleed;
            this.camera.top = LOGICAL_HEIGHT;
            this.camera.bottom = 0;
        }
        else {
            const visibleHeight = LOGICAL_WIDTH / viewportAspect;
            const verticalBleed = (visibleHeight - LOGICAL_HEIGHT) / 2;
            this.camera.left = 0;
            this.camera.right = LOGICAL_WIDTH;
            this.camera.top = LOGICAL_HEIGHT + verticalBleed;
            this.camera.bottom = -verticalBleed;
        }
        this.camera.updateProjectionMatrix();
        this.updateFractalBackgroundBounds(width, height);
    }
    populateThemeSelector() {
        const options = THEME_OPTIONS.map((theme) => {
            const option = document.createElement('option');
            option.value = theme.id;
            option.textContent = theme.label;
            return option;
        });
        // Add Custom YouTube option to the native select so setSelected works
        const ytOption = document.createElement('option');
        ytOption.value = 'custom-youtube';
        ytOption.textContent = 'Custom YouTube';
        options.push(ytOption);
        this.themeSelector.replaceChildren(...options);
    }
    createThemeBackgrounds() {
        // Only create the active theme's background — others are built lazily
        // when first selected, so unused 3D themes don't pay any startup cost.
        this.ensureThemeInstance(this.theme);
    }
    ensureThemeInstance(themeId) {
        if (this.threeThemeInstances.has(themeId))
            return;
        const definition = THREE_THEME_BY_ID[themeId];
        if (!definition)
            return;
        const instance = definition.backgroundType === 'custom'
            ? definition.createBackground({
                scene: this.scene,
                renderer: this.renderer,
                logicalWidth: LOGICAL_WIDTH,
                logicalHeight: LOGICAL_HEIGHT
            })
            : this.createShaderThemeBackground(definition);
        this.threeThemeInstances.set(themeId, instance);
        // Size the new instance immediately so it renders on first frame
        this.resizeThemeInstance(instance);
    }
    resizeThemeInstance(instance) {
        const width = Math.floor(this.renderer.domElement.clientWidth || LOGICAL_WIDTH);
        const height = Math.floor(this.renderer.domElement.clientHeight || LOGICAL_HEIGHT);
        const visibleWidth = this.camera.right - this.camera.left;
        const visibleHeight = this.camera.top - this.camera.bottom;
        const centerX = this.camera.left + visibleWidth / 2;
        const centerY = this.camera.bottom + visibleHeight / 2;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        instance.resize({ width, height, visibleWidth, visibleHeight, centerX, centerY, pixelRatio });
    }
    createShaderThemeBackground(theme) {
        const uniforms = {
            uTime: { value: 0 },
            uResolution: { value: new THREE.Vector2(LOGICAL_WIDTH, LOGICAL_HEIGHT) },
            uAccentA: { value: new THREE.Color('#00f5ff') },
            uAccentB: { value: new THREE.Color('#ff4fd8') },
            uOpacity: { value: theme.opacity ?? 0.95 },
            ...(theme.createUniforms ? theme.createUniforms() : {})
        };
        const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
        const material = new THREE.ShaderMaterial({
            uniforms,
            vertexShader: FRACTAL_VERTEX_SHADER,
            fragmentShader: theme.fragmentShader,
            transparent: true,
            depthTest: false,
            depthWrite: false
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.visible = false;
        mesh.renderOrder = theme.renderOrder;
        mesh.position.z = -500;
        this.scene.add(mesh);
        return {
            setVisible: (visible) => {
                mesh.visible = visible;
            },
            resize: ({ width, height, visibleWidth, visibleHeight, centerX, centerY }) => {
                mesh.position.set(centerX, centerY, -500);
                mesh.scale.set(visibleWidth, visibleHeight, 1);
                uniforms.uResolution.value.set(width, height);
            },
            update: ({ timestamp }) => {
                uniforms.uTime.value = timestamp * 0.001;
            },
            updateColors: ({ accent, accent2 }) => {
                uniforms.uAccentA.value.set(accent);
                uniforms.uAccentB.value.set(accent2);
            },
            dispose: () => {
                this.scene.remove(mesh);
                geometry.dispose();
                material.dispose();
            }
        };
    }
    updateFractalBackgroundBounds(width, height) {
        const visibleWidth = this.camera.right - this.camera.left;
        const visibleHeight = this.camera.top - this.camera.bottom;
        const centerX = this.camera.left + visibleWidth / 2;
        const centerY = this.camera.bottom + visibleHeight / 2;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        for (const instance of this.threeThemeInstances.values()) {
            instance.resize({ width, height, visibleWidth, visibleHeight, centerX, centerY, pixelRatio });
        }
    }
    isThreeFractalTheme() {
        return isThreeBackgroundTheme(this.theme);
    }
    /** Returns a promise that resolves when the active theme's data is loaded.
     *  Non-async themes resolve immediately. */
    themeReady() {
        const instance = this.threeThemeInstances.get(this.theme);
        if (instance?.ready) {
            return instance.ready({
                language: this.language,
                frequencyLimit: this.frequencyLimit,
            });
        }
        return Promise.resolve();
    }
    showThemeLoader(message) {
        if (!this.themeLoader)
            return;
        if (this.themeLoaderText) {
            this.themeLoaderText.textContent = message || 'Loading theme…';
        }
        this.themeLoader.classList.add('is-visible');
        this.themeLoader.setAttribute('aria-hidden', 'false');
    }
    hideThemeLoader() {
        if (!this.themeLoader)
            return;
        this.themeLoader.classList.remove('is-visible');
        this.themeLoader.setAttribute('aria-hidden', 'true');
    }
    async waitForThemeBeforeWords(sequence, message) {
        const instance = this.threeThemeInstances.get(this.theme);
        if (!instance?.ready) {
            this.hideThemeLoader();
            return;
        }
        this.showThemeLoader(message);
        try {
            await this.themeReady();
        }
        finally {
            if (sequence === this.startSequence) {
                this.hideThemeLoader();
            }
        }
    }
    createTelemetry() {
        return {
            gameStartedAt: Date.now(),
            keyEvents: [],
            completedWords: [],
            focusEvents: [],
            clientMeta: {
                userAgent: navigator.userAgent,
                platform: navigator.platform || '',
                language: navigator.language || '',
                screen: `${window.screen?.width || 0}x${window.screen?.height || 0}`,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
            },
        };
    }
    markGameplayStart() {
        this.startTime = Date.now();
        this.timeElapsed = 0;
        this.telemetry = this.createTelemetry();
        this.activeWordStartedAt = 0;
        this.activeWordKeystrokes = 0;
        this.activeWordTypos = 0;
    }
    updateFractalThemeColors() {
        const styles = getComputedStyle(document.body);
        const accent = styles.getPropertyValue('--accent').trim() || '#00f5ff';
        const accent2 = styles.getPropertyValue('--accent-2').trim() || '#ff4fd8';
        for (const instance of this.threeThemeInstances.values()) {
            instance.updateColors?.({ accent, accent2 });
        }
    }
    createAmbientParticles() {
        const particleCount = 180;
        const positions = new Float32Array(particleCount * 3);
        for (let i = 0; i < particleCount; i++) {
            positions[i * 3] = Math.random() * LOGICAL_WIDTH;
            positions[i * 3 + 1] = Math.random() * LOGICAL_HEIGHT;
            positions[i * 3 + 2] = -120 - Math.random() * 160;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        this.ambientParticleMaterial = new THREE.PointsMaterial({
            color: this.currentAccentColor(),
            size: 2.4,
            transparent: true,
            opacity: 0.38,
            depthWrite: false
        });
        this.ambientParticles = new THREE.Points(geometry, this.ambientParticleMaterial);
        this.scene.add(this.ambientParticles);
    }
    currentAccentColor() {
        const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim();
        return accent || '#7df9ff';
    }
    updateThemeVisuals() {
        if (this.ambientParticles) {
            // These ambient particles are the Default theme's star layer. Keep them
            // out of video/CSS/Three.js themes so they don't leak over custom visuals.
            this.ambientParticles.visible = this.theme === 'default';
        }
        if (this.ambientParticleMaterial) {
            this.ambientParticleMaterial.color.set(this.currentAccentColor());
        }
        this.updateFractalThemeColors();
    }
    updateHud() {
        const currentScoreElement = document.getElementById('current-score');
        if (currentScoreElement && this._hudScore !== this.score) {
            currentScoreElement.textContent = `${this.score}`;
            this._hudScore = this.score;
        }
        const hudWpm = document.getElementById('hud-wpm');
        if (hudWpm && this._hudWpm !== this.WPM) {
            hudWpm.textContent = this.formatWPM(this.WPM);
            this._hudWpm = this.WPM;
        }
        const themeLabel = document.getElementById('theme-label');
        if (themeLabel) {
            const themeText = this.selectedOptionText(this.themeSelector);
            if (this._hudTheme !== themeText) {
                themeLabel.textContent = themeText;
                this._hudTheme = themeText;
            }
        }
        const modeLabel = document.getElementById('mode-label');
        if (modeLabel) {
            const modeText = this.formatMode(this.mode);
            if (this._hudMode !== modeText) {
                modeLabel.textContent = modeText;
                this._hudMode = modeText;
            }
        }
    }
    selectedOptionText(select) {
        return select.selectedOptions[0]?.textContent?.replace(' (YT)', '').trim() || select.value || 'Default';
    }
    formatWPM(wpm) {
        if (wpm === 30)
            return '30⇢∞';
        if (wpm === 101)
            return '100⇢∞';
        if (wpm === 201)
            return '200⇢∞';
        return `${wpm}`;
    }
    formatMode(mode) {
        return mode.charAt(0).toUpperCase() + mode.slice(1);
    }
    resumeIfSettingsClosed() {
        if (this.settingsMenu.style.display === 'none') {
            this.resumeGame();
        }
    }
    closeSettingsMenuIfClickedOutside(event) {
        const path = event.composedPath();
        const clickedDropdownMenu = path.some((element) => {
            return element instanceof HTMLElement && (element.classList.contains('kr-menu') ||
                element.classList.contains('kr-option') ||
                element.closest('.kr-menu') !== null);
        });
        if (clickedDropdownMenu)
            return;
        const inputFields = ['player-name', 'wpm', 'mode', 'language', 'frequency-limit', 'theme', 'grammar', 'addNumbers', 'diacritics'];
        if (this.settingsMenu.style.display !== 'none' && !path.includes(this.settingsMenu) && !path.includes(this.settingsButton)) {
            const clickedOnInputField = path.some((element) => element.id && inputFields.includes(element.id));
            if (!clickedOnInputField) {
                this.settingsMenu.style.display = 'none';
                this.resumeGame();
            }
        }
    }
    toggleSettingsMenu() {
        if (this.settingsMenu.style.display === 'none') {
            this.settingsMenu.style.display = 'flex';
            this.pauseGame();
        }
        else {
            this.settingsMenu.style.display = 'none';
            this.resumeGame();
        }
    }
    changeTheme() {
        this.theme = this.themeSelector.value || DEFAULT_THEME;
        localStorage.setItem('theme', this.theme);
        document.body.setAttribute('data-theme', this.theme);
        // Show YouTube URL input only when Custom YouTube is selected
        const ytContainer = document.getElementById('custom-yt-container');
        if (ytContainer) {
            ytContainer.style.display = this.theme === CUSTOM_YOUTUBE_THEME_ID ? '' : 'none';
        }
        const iframe = document.getElementById('myVideo');
        let videoTheme = VIDEO_THEMES[this.theme];
        const isFractalTheme = this.isThreeFractalTheme();
        // Custom YouTube: read user-provided video ID from localStorage,
        // fall back to highway video as default
        if (this.theme === CUSTOM_YOUTUBE_THEME_ID) {
            const customId = localStorage.getItem('customYoutubeId');
            if (customId) {
                videoTheme = { id: customId, maxStart: 3600 };
            }
            else {
                // Default: highway video (same as the Highway theme)
                videoTheme = { id: 'tTBJeT5F4r8', maxStart: 2536 };
            }
        }
        // Lazily build the theme if this is its first selection
        this.ensureThemeInstance(this.theme);
        for (const [themeId, instance] of this.threeThemeInstances) {
            instance.setVisible(this.theme === themeId);
        }
        const activeInstance = this.threeThemeInstances.get(this.theme);
        if (activeInstance && activeInstance.ready) {
            this.showThemeLoader();
            // Start loading theme data for the current game language immediately,
            // even while paused in settings. When the data arrives, hide the loader
            // if this theme is still active.
            activeInstance.ready({
                language: this.language,
                frequencyLimit: this.frequencyLimit,
            }).then(() => {
                if (this.threeThemeInstances.get(this.theme) === activeInstance) {
                    this.hideThemeLoader();
                }
            });
        }
        else {
            this.hideThemeLoader();
        }
        const activeThreeTheme = isFractalTheme ? this.theme : 'false';
        document.body.setAttribute('data-three-theme', activeThreeTheme);
        if (videoTheme && !isFractalTheme) {
            const randomTime = Math.floor(Math.random() * videoTheme.maxStart);
            iframe.src = `https://youtube.com/embed/${videoTheme.id}?start=${randomTime}&autoplay=1&mute=1&modestbranding=1&loop=1&controls=0&playlist=${videoTheme.id}`;
            document.body.setAttribute('data-video-theme', 'true');
        }
        else {
            iframe.removeAttribute('src');
            document.body.setAttribute('data-video-theme', 'false');
        }
        // Let CSS variables settle before sampling --accent for Three.js particles/shader.
        requestAnimationFrame(() => this.updateThemeVisuals());
        this.updateHud();
    }
    toggleAddNumbers() {
        this.addNumbersSetting = this.addNumbersCheckbox.checked;
        localStorage.setItem('addNumbers', this.addNumbersSetting.toString());
        this.restart(this.WPM);
    }
    toggleRequireDiacritics() {
        this.requireDiacriticsSetting = this.requireDiacriticsCheckbox.checked;
        localStorage.setItem('requireDiacritics', this.requireDiacriticsSetting.toString());
    }
    toggleApplyGrammar() {
        this.applyGrammarSetting = this.grammarCheckbox.checked;
        localStorage.setItem('applyGrammar', this.applyGrammarSetting.toString());
        this.restart(this.WPM);
    }
    addRandomNumbers(word) {
        if (this.addNumbersSetting) {
            const shouldAddNumber = Math.random() < 0.2;
            if (shouldAddNumber) {
                const numbersToAdd = Math.floor(Math.random() * 4) + 1;
                let numberString = '';
                for (let i = 0; i < numbersToAdd; i++) {
                    const randomNumber = Math.floor(Math.random() * 10);
                    numberString += randomNumber.toString();
                }
                const shouldAddCurrencySymbol = Math.random() < 0.1;
                if (shouldAddCurrencySymbol) {
                    if (this.language.startsWith('french')) {
                        numberString += '€';
                    }
                    else {
                        numberString = '$' + numberString;
                    }
                }
                word += numberString + ' ';
            }
        }
        return word;
    }
    applyGrammar(word) {
        if (this.applyGrammarSetting) {
            const shouldCapitalize = Math.random() < 0.2;
            const shouldAddPunctuation = Math.random() < 0.2;
            const shouldAddParentheses = Math.random() < 0.02;
            const shouldAddHyphen = Math.random() < 0.02;
            const shouldAddSquareBrackets = Math.random() < 0.015;
            const shouldAddEllipsis = Math.random() < 0.05;
            const shouldAddQuotes = Math.random() < 0.02;
            if (shouldCapitalize && !this.language.startsWith('code')) {
                if (this.language.startsWith('french')) {
                    switch (word.charAt(0).toLowerCase()) {
                        case 'é':
                            word = 'E' + word.slice(1);
                            break;
                        case 'è':
                            word = 'E' + word.slice(1);
                            break;
                        case 'ê':
                            word = 'E' + word.slice(1);
                            break;
                        case 'ë':
                            word = 'E' + word.slice(1);
                            break;
                        case 'à':
                            word = 'A' + word.slice(1);
                            break;
                        case 'â':
                            word = 'A' + word.slice(1);
                            break;
                        case 'ä':
                            word = 'A' + word.slice(1);
                            break;
                        case 'î':
                            word = 'I' + word.slice(1);
                            break;
                        case 'ï':
                            word = 'I' + word.slice(1);
                            break;
                        case 'ô':
                            word = 'O' + word.slice(1);
                            break;
                        case 'ö':
                            word = 'O' + word.slice(1);
                            break;
                        case 'ù':
                            word = 'U' + word.slice(1);
                            break;
                        case 'û':
                            word = 'U' + word.slice(1);
                            break;
                        case 'ü':
                            word = 'U' + word.slice(1);
                            break;
                        case 'ç':
                            word = 'C' + word.slice(1);
                            break;
                        case 'œ':
                            word = 'OE' + word.slice(1);
                            break;
                        case 'æ':
                            word = 'AE' + word.slice(1);
                            break;
                        default: word = word.charAt(0).toUpperCase() + word.slice(1);
                    }
                }
                else {
                    word = word.charAt(0).toUpperCase() + word.slice(1);
                }
            }
            else if (shouldAddPunctuation) {
                let punctuation = ['.', '?', '!', ',', ';'];
                if (this.language.startsWith('french')) {
                    punctuation = ['.', ' ?', ' !', ';', ' :'];
                }
                else if (this.language.startsWith('code_bash')) {
                    punctuation = [';', ' &&', ' ||', ' >', ' <', ' |', ' >>', ' <<', '*', '$', './', '='];
                }
                else if (this.language.startsWith('code')) {
                    punctuation = ['.', '?', '!', ',', ';', '(', ')', '[', ']', '"', '-', '...', ':', '=', '+', '-', '*', '/', '//', '%', '**', '+=', '-=', '*=', '/=', '//=', '%=', '**='];
                }
                word += punctuation[Math.floor(Math.random() * punctuation.length)];
            }
            else if (shouldAddEllipsis && !this.language.startsWith('code')) {
                word += '...';
            }
            else if (shouldAddParentheses) {
                word = '(' + word + ')';
            }
            else if (shouldAddSquareBrackets) {
                word = '[' + word + ']';
            }
            else if (shouldAddQuotes) {
                word = '"' + word + '"';
            }
            else if (shouldAddHyphen) {
                word = '-' + word;
            }
        }
        word += ' ';
        return word;
    }
    async fetchWords() {
        const response = await fetch(`/words/${this.language}/words.json`);
        const data = (await response.json());
        const limit = Math.max(1, Math.min(data.words.length, this.frequencyLimit || data.words.length));
        const selectedWords = data.words.slice(0, limit).map(word => word.trimEnd());
        this.allWords = this.shuffleArray(selectedWords.map((word, sourceIndex) => ({
            text: this.addRandomNumbers(this.applyGrammar(word)),
            baseText: word,
            sourceIndex
        })));
        const freqKey = String(this.frequencyLimit || data.words.length);
        this.averageCharLength = effectiveAverageWordLength(this.language, selectedWords, data.charLengthByFrequency?.[freqKey] ?? data.charLength);
        if (this.applyGrammarSetting) {
            this.averageCharLength += 1;
        }
        if (this.addNumbersSetting) {
            this.averageCharLength += 2;
        }
        this.nextBatch();
    }
    nextBatch() {
        if (this.wordIndex + this.batchSize > this.allWords.length) {
            this.wordIndex = 0;
        }
        this.wordList = this.allWords.slice(this.wordIndex, this.wordIndex + this.batchSize);
        this.wordIndex += this.batchSize;
    }
    setMode(newMode) {
        if (newMode !== this.mode) {
            localStorage.setItem('mode', newMode);
            this.mode = newMode;
            this.updateHud();
            this.restart(this.WPM);
        }
    }
    setLanguage(newLanguage) {
        if (newLanguage !== this.language) {
            localStorage.setItem('language', newLanguage);
            this.clearWords();
            this.language = newLanguage;
            this.allWords = [];
            this.wordList = [];
            this.wordIndex = 0;
            this.restart(this.WPM);
        }
    }
    setWPM(newWPM) {
        if (newWPM !== this.WPM) {
            localStorage.setItem('WPM', newWPM.toString());
            this.WPM = newWPM;
            this.originalWPM = newWPM;
            this.updateHud();
            this.restart(this.WPM);
        }
    }
    setFrequencyLimit(newLimit) {
        const cleanLimit = Math.max(1, Math.floor(newLimit));
        if (cleanLimit !== this.frequencyLimit) {
            localStorage.setItem('frequencyLimit', cleanLimit.toString());
            this.frequencyLimit = cleanLimit;
            this.clearWords();
            this.allWords = [];
            this.wordList = [];
            this.wordIndex = 0;
            this.restart(this.WPM);
        }
    }
    initSemanticSearch() {
        this.semanticSearchInput = document.getElementById('semantic-search');
        this.semanticDropdown = document.getElementById('semantic-dropdown');
        this.semanticActiveDiv = document.getElementById('semantic-active');
        this.semanticSearchInput.addEventListener('input', () => {
            const q = this.semanticSearchInput.value.trim();
            if (q.length < 1) {
                this.semanticDropdown.style.display = 'none';
                return;
            }
            if (this.semanticDebounceTimer)
                clearTimeout(this.semanticDebounceTimer);
            this.semanticDebounceTimer = setTimeout(() => this.semanticAutocomplete(q), 200);
        });
        this.semanticSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.semanticDropdown.style.display = 'none';
                this.semanticSearchInput.blur();
            }
        });
        this.semanticSearchInput.addEventListener('focus', () => this.pauseGame());
        this.semanticSearchInput.addEventListener('blur', () => this.resumeIfSettingsClosed());
        document.addEventListener('click', (e) => {
            if (!this.semanticSearchInput.contains(e.target) &&
                !this.semanticDropdown.contains(e.target)) {
                this.semanticDropdown.style.display = 'none';
            }
        });
    }
    showSemanticServiceError(message = 'Semantic search requires the semantic API on port 8703.') {
        this.semanticDropdown.innerHTML = '';
        const div = document.createElement('div');
        div.textContent = message;
        div.style.color = WORD_DANGER;
        this.semanticDropdown.appendChild(div);
        this.semanticDropdown.style.display = 'block';
    }
    renderSemanticResults(results) {
        if (!results.length) {
            this.semanticDropdown.style.display = 'none';
            return;
        }
        this.semanticDropdown.innerHTML = '';
        results.forEach((r) => {
            const div = document.createElement('div');
            div.textContent = `${r.word} (${r.language})`;
            div.addEventListener('click', () => {
                this.semanticDropdown.style.display = 'none';
                this.semanticSearchInput.value = r.word;
                this.setSemanticSeed(r.id, r.word, r.language);
            });
            this.semanticDropdown.appendChild(div);
        });
        this.semanticDropdown.style.display = 'block';
    }
    async semanticAutocomplete(q) {
        try {
            const resp = await fetch(`http://localhost:8703/search?q=${encodeURIComponent(q)}&limit=8&language=${encodeURIComponent(this.language)}`);
            if (!resp.ok)
                throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this.renderSemanticResults(data.results || []);
        }
        catch (error) {
            console.warn('Semantic API unavailable', error);
            this.showSemanticServiceError('Semantic API unavailable (port 8703). Start galaxy/semantic/semantic_neighbors_server.py.');
        }
    }
    activateSemanticWords(seedWord, rawWords, label) {
        this.semanticActive = true;
        this.semanticRawWords = rawWords.map(word => word.trimEnd()).filter(Boolean);
        this.semanticAllWords = this.semanticRawWords.map((word, i) => ({
            text: this.addRandomNumbers(this.applyGrammar(word)),
            baseText: word,
            sourceIndex: i,
        }));
        const totalChars = this.semanticRawWords.reduce((sum, word) => sum + word.length, 0);
        this.averageCharLength = effectiveAverageWordLength(this.language, this.semanticRawWords, this.semanticRawWords.length > 0 ? totalChars / this.semanticRawWords.length : 5);
        if (this.applyGrammarSetting)
            this.averageCharLength += 1;
        if (this.addNumbersSetting)
            this.averageCharLength += 2;
        this.semanticActiveDiv.innerHTML = '';
        this.semanticActiveDiv.style.display = 'block';
        this.semanticActiveDiv.textContent = `"${seedWord}" → ${this.semanticRawWords.length} neighbors (${label}) `;
        const clearBtn = document.createElement('button');
        clearBtn.textContent = '✕';
        clearBtn.style.cssText = 'background:none;border:1px solid var(--accent);color:var(--accent);cursor:pointer;padding:0 5px;margin-left:6px;border-radius:3px;font-size:0.75rem;';
        clearBtn.addEventListener('click', () => this.clearSemanticMode());
        this.semanticActiveDiv.appendChild(clearBtn);
        this.clearWords();
        this.allWords = this.shuffleArray([...this.semanticAllWords]);
        this.wordList = [];
        this.wordIndex = 0;
        this.nextBatch();
        this.score = 0;
        this.timeElapsed = 0;
        this.keystrokes = 0;
        this.typos = 0;
        this.pendingDeadAccentKey = null;
        this.startTime = Date.now();
        this.isGameOver = false;
        this.updateHud();
        const sequence = ++this.startSequence;
        requestAnimationFrame(async () => {
            await this.waitForThemeBeforeWords(sequence);
            if (sequence !== this.startSequence || this.isGameOver || this.words.length > 0)
                return;
            this.markGameplayStart();
            this.generateWords();
            if (!this.pause && this.animationFrame === null) {
                this.lastTimestamp = performance.now();
                this.animate(this.lastTimestamp);
            }
        });
    }
    async setSemanticSeed(pointId, word, lang) {
        this.semanticActiveDiv.style.display = 'block';
        this.semanticActiveDiv.textContent = `Loading 200 neighbors of "${word}"...`;
        try {
            const resp = await fetch(`http://localhost:8703/neighbors/${pointId}?k=200&language=${encodeURIComponent(lang)}`);
            if (!resp.ok)
                throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const neighbors = data.neighbors || [];
            if (neighbors.length === 0)
                throw new Error('No semantic neighbors returned');
            this.activateSemanticWords(word, neighbors.map((n) => n.word), 'semantic similarity');
            localStorage.setItem('semanticSeedId', String(pointId));
            localStorage.setItem('semanticSeedWord', word);
            localStorage.setItem('semanticSeedLang', lang);
        }
        catch (err) {
            console.warn('Semantic API unavailable', err);
            this.semanticActiveDiv.textContent = 'Semantic API unavailable (port 8703).';
            this.semanticActive = false;
        }
    }
    clearSemanticMode() {
        this.semanticActive = false;
        this.semanticAllWords = [];
        this.semanticRawWords = [];
        this.semanticActiveDiv.style.display = 'none';
        localStorage.removeItem('semanticSeedId');
        localStorage.removeItem('semanticSeedWord');
        localStorage.removeItem('semanticSeedLang');
        this.clearWords();
        this.restart(this.WPM);
    }
    restart(currentWPM) {
        const sequence = ++this.startSequence;
        this.score = 0;
        this.clearWords();
        this.originalWPM = currentWPM;
        this.timeElapsed = 0;
        this.keystrokes = 0;
        this.typos = 0;
        this.pendingDeadAccentKey = null;
        this.startTime = Date.now();
        this.isGameOver = false;
        this.wordIndex = 0;
        this.updateHud();
        if (this.semanticActive) {
            // Rebuild word list with current grammar/numbers settings
            this.semanticAllWords = this.semanticRawWords.map((w, i) => ({
                text: this.addRandomNumbers(this.applyGrammar(w)),
                baseText: w,
                sourceIndex: i,
            }));
            const totalChars = this.semanticRawWords.reduce((sum, w) => sum + w.length, 0);
            this.averageCharLength = effectiveAverageWordLength(this.language, this.semanticRawWords, this.semanticRawWords.length > 0 ? totalChars / this.semanticRawWords.length : 5);
            if (this.applyGrammarSetting)
                this.averageCharLength += 1;
            if (this.addNumbersSetting)
                this.averageCharLength += 2;
            this.allWords = this.shuffleArray([...this.semanticAllWords]);
            this.wordList = [];
            this.nextBatch();
            requestAnimationFrame(async () => {
                await this.waitForThemeBeforeWords(sequence);
                if (sequence !== this.startSequence || this.isGameOver || this.words.length > 0)
                    return;
                this.markGameplayStart();
                this.generateWords();
                if (!this.pause && this.animationFrame === null) {
                    this.lastTimestamp = performance.now();
                    this.animate(this.lastTimestamp);
                }
            });
            return;
        }
        Promise.all([this.fetchWords(), this.waitForThemeBeforeWords(sequence)]).then(() => {
            requestAnimationFrame(() => {
                if (sequence !== this.startSequence || this.isGameOver || this.words.length > 0)
                    return;
                this.markGameplayStart();
                this.generateWords();
                if (!this.pause && this.animationFrame === null) {
                    this.lastTimestamp = performance.now();
                    this.animate(this.lastTimestamp);
                }
            });
        });
    }
    initialize() {
        const sequence = ++this.startSequence;
        this.container.focus({ preventScroll: true });
        // Wait for DOM layout + WebGL to settle, then await theme data before
        // dropping the first word.
        requestAnimationFrame(async () => {
            await this.waitForThemeBeforeWords(sequence);
            if (sequence !== this.startSequence || this.isGameOver || this.words.length > 0)
                return;
            this.markGameplayStart();
            this.generateWords();
            this.lastTimestamp = performance.now();
            this.animate(this.lastTimestamp);
        });
        window.addEventListener('keydown', (event) => this.handleKeydown(event));
    }
    beginActiveWord(word) {
        if (this.activeWordStartedAt === 0) {
            this.activeWordStartedAt = performance.now() + performance.timeOrigin;
            this.activeWordKeystrokes = 0;
            this.activeWordTypos = 0;
        }
    }
    recordCompletedWord(word) {
        const completedAt = performance.now() + performance.timeOrigin;
        this.telemetry.completedWords.push({
            word: word.baseText,
            sourceIndex: word.sourceIndex,
            length: word.baseText.length,
            startedAt: this.activeWordStartedAt || completedAt,
            completedAt,
            keystrokes: this.activeWordKeystrokes,
            typos: this.activeWordTypos,
        });
        if (this.telemetry.completedWords.length > 1200)
            this.telemetry.completedWords.shift();
        this.activeWordStartedAt = 0;
        this.activeWordKeystrokes = 0;
        this.activeWordTypos = 0;
    }
    recordKeyTelemetry(event, word, correct) {
        this.telemetry.keyEvents.push({
            t: performance.now() + performance.timeOrigin,
            key: event.key,
            code: event.code,
            correct,
            isTrusted: event.isTrusted,
            repeat: event.repeat,
            wordIndex: word.sourceIndex,
            charIndex: word.currentIndex,
        });
        if (this.telemetry.keyEvents.length > 2500)
            this.telemetry.keyEvents.shift();
    }
    handleKeydown(event) {
        if (event.target === document.getElementById('hidden-input')) {
            return;
        }
        if (event.key === 'Tab') {
            event.preventDefault();
            if (this.pause) {
                this.resumeGame();
            }
            else {
                this.pauseGame();
            }
            return;
        }
        if (this.pause || this.isGameOver) {
            return;
        }
        const capsLockIndicator = document.getElementById('capsLockIndicator');
        if (capsLockIndicator) {
            capsLockIndicator.style.display = event.getModifierState('CapsLock') ? 'block' : 'none';
        }
        if (["Shift", "Control", "Alt", "AltGraph", "Meta", "Backspace", "CapsLock", "Escape"].includes(event.key)
            || (event.key >= 'F1' && event.key <= 'F12')) {
            return;
        }
        event.preventDefault();
        if (this.words.length === 0)
            return;
        const firstWord = this.words[0];
        if (shouldIgnoreDeadAccentKey(event.key, firstWord.text)) {
            this.pendingDeadAccentKey = event.key;
            return;
        }
        this.keystrokes++;
        this.beginActiveWord(firstWord);
        this.activeWordKeystrokes++;
        const typedLength = typedKeyPrefixLength(firstWord.text, event.key, !this.requireDiacriticsSetting, this.pendingDeadAccentKey);
        this.pendingDeadAccentKey = null;
        if (typedLength > 0) {
            this.recordKeyTelemetry(event, firstWord, true);
            firstWord.text = firstWord.text.slice(typedLength);
            firstWord.color = WORD_FILL;
            firstWord.currentIndex += typedLength;
            if (firstWord.text.length === 0 && !(this.mode === 'fast' && firstWord.isTypoMade && event.key !== ' ')) {
                this.recordCompletedWord(firstWord);
                this.removeWord(firstWord);
                this.words.shift();
                if (this.mode !== 'fast' || !firstWord.isTypoMade) {
                    this.score++;
                }
                if (this.words.length < this.batchSize) {
                    this.generateWords();
                }
            }
            else {
                this.updateWordTexture(firstWord);
            }
        }
        else {
            this.recordKeyTelemetry(event, firstWord, false);
            this.activeWordTypos++;
            this.typos++;
            if (this.mode === 'rage') {
                firstWord.speed *= 1.1;
                firstWord.color = WORD_DANGER;
                this.updateWordTexture(firstWord);
            }
            else if (this.mode === 'precision') {
                firstWord.text = firstWord.originalText;
                firstWord.color = WORD_DANGER;
                firstWord.currentIndex = 0;
                this.updateWordTexture(firstWord);
                setTimeout(() => {
                    if (this.words.includes(firstWord)) {
                        firstWord.color = WORD_FILL;
                        this.updateWordTexture(firstWord);
                    }
                }, 500);
            }
            else if (this.mode === 'fast') {
                if (firstWord.text.length > 1 || event.key === ' ') {
                    firstWord.text = firstWord.text.slice(1);
                    firstWord.currentIndex++;
                }
                firstWord.isTypoMade = true;
                firstWord.color = WORD_DANGER;
                if (firstWord.text.length === 0) {
                    this.recordCompletedWord(firstWord);
                    this.removeWord(firstWord);
                    this.words.shift();
                    if (this.words.length < this.batchSize) {
                        this.generateWords();
                    }
                }
                else {
                    this.updateWordTexture(firstWord);
                }
            }
            firstWord.currentIndex = firstWord.text[0] === ' ' ? 0 : firstWord.currentIndex;
        }
        this.updateHud();
    }
    // ── WPM → critical fall speed (px/ms) ─────────────────────────
    // At this speed, each successive word occupies exactly the same
    // position on screen when it becomes active — if the player types
    // at exactly the selected WPM.  Slower = words sink, faster = margin.
    // See the full derivation in the constants block above.
    computeFallSpeed() {
        const keystrokesPerWord = this.averageCharLength + 1; // +1 = space from applyGrammar()
        const keystrokesPerMinute = this.WPM * CHARS_PER_STANDARD_WORD;
        const msPerWord = (keystrokesPerWord * MS_PER_MINUTE) / keystrokesPerMinute;
        return WORD_SPACING / msPerWord;
    }
    generateWords() {
        this.nextBatch();
        const shuffledList = this.shuffleArray([...this.wordList]);
        const offset = this.words.length > 0 ? this.words[this.words.length - 1].y - 80 : 0;
        const lastWordSpeed = this.words.length > 0
            ? this.words[this.words.length - 1].speed
            : this.computeFallSpeed();
        shuffledList.forEach((entry, index) => {
            const wordText = entry.text;
            const textWidth = this.measureWordWidth(wordText);
            const maxWordX = Math.max(24, LOGICAL_WIDTH - textWidth - 24);
            const word = {
                text: wordText,
                originalText: wordText,
                baseText: entry.baseText,
                sourceIndex: entry.sourceIndex,
                x: 24 + Math.random() * Math.max(1, maxWordX - 24),
                y: offset - index * 80,
                speed: lastWordSpeed,
                originalSpeed: lastWordSpeed,
                color: WORD_FILL,
                currentIndex: 0
            };
            this.createWordSprite(word);
            this.words.push(word);
        });
    }
    measureWordWidth(text) {
        this.measureContext.font = WORD_FONT;
        this.measureContext.direction = textDirectionForLanguage(this.language);
        return this.measureContext.measureText(this.visibleText(text)).width;
    }
    visibleText(text) {
        return text.replace(/ /g, '⎵');
    }
    createWordSprite(word) {
        this.renderWordTexture(word); // creates canvas + draws text, sets word.width/height
        const texture = new THREE.CanvasTexture(word._canvas);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
            depthWrite: false
        });
        const sprite = new THREE.Sprite(material);
        sprite.matrixAutoUpdate = false; // we control position/scale in syncWordSprite
        word.texture = texture;
        word.material = material;
        word.sprite = sprite;
        sprite.renderOrder = 10;
        this.syncWordSprite(word);
        this.scene.add(sprite);
    }
    // Draws word text onto the word's canvas. Reuses an existing canvas when
    // the size matches; recreates it when the text grows OR shrinks enough
    // (avoids squeezing a large canvas into a smaller sprite — the visual bug
    // from the first pass). Returns true when the canvas was recreated and the
    // caller must wrap it in a new CanvasTexture.
    renderWordTexture(word) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.measureContext.font = WORD_FONT;
        const direction = textDirectionForLanguage(this.language);
        const displayText = this.visibleText(word.text);
        const width = Math.max(72, Math.ceil(this.measureContext.measureText(displayText).width + 52));
        const height = 76;
        const neededW = Math.ceil(width * dpr);
        const neededH = Math.ceil(height * dpr);
        let canvas = word._canvas;
        const existingW = canvas?.width ?? 0;
        const existingH = canvas?.height ?? 0;
        // Recreate canvas when size changes in EITHER direction (shrink or grow)
        const mustRecreate = !canvas || existingW < neededW || existingH < neededH
            || existingW > neededW || existingH > neededH;
        if (mustRecreate) {
            canvas = document.createElement('canvas');
            canvas.width = neededW;
            canvas.height = neededH;
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
            word._canvas = canvas;
            word._ctx = canvas.getContext('2d');
        }
        const context = word._ctx;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, width, height);
        context.font = WORD_FONT;
        context.direction = direction;
        context.textBaseline = 'alphabetic';
        context.shadowColor = word.color === WORD_DANGER ? 'rgba(255, 0, 64, 0.9)' : 'rgba(125, 249, 255, 0.42)';
        context.shadowBlur = word.color === WORD_DANGER ? 20 : 12;
        const baseline = 54;
        if (direction === 'rtl') {
            context.textAlign = 'right';
            context.fillStyle = word.color;
            context.fillText(displayText, width - 12, baseline);
        }
        else if (needsShapedRendering(displayText)) {
            context.textAlign = 'left';
            context.fillStyle = word.color;
            context.fillText(displayText, 12, baseline);
        }
        else {
            context.textAlign = 'left';
            let offsetX = 12;
            for (let i = 0; i < word.text.length; i++) {
                const char = word.text[i];
                const printable = char === ' ' ? '⎵' : char;
                if (char === ' ') {
                    context.fillStyle = i === word.currentIndex && word.color === WORD_DANGER ? WORD_DANGER : WORD_MUTED;
                }
                else {
                    context.fillStyle = i === word.currentIndex && word.color === WORD_DANGER ? WORD_DANGER : word.color;
                }
                context.fillText(printable, offsetX, baseline);
                offsetX += this.measureContext.measureText(printable).width;
            }
        }
        word.width = width;
        word.height = height;
        return mustRecreate;
    }
    updateWordTexture(word) {
        if (!word.sprite || !word.material)
            return;
        const canvasRecreated = this.renderWordTexture(word);
        if (canvasRecreated) {
            // Canvas dimensions changed — need a new CanvasTexture wrapping the new canvas
            const newTex = new THREE.CanvasTexture(word._canvas);
            newTex.minFilter = THREE.LinearFilter;
            newTex.magFilter = THREE.LinearFilter;
            newTex.generateMipmaps = false;
            word.texture?.dispose();
            word.texture = newTex;
            word.material.map = newTex;
            word.material.needsUpdate = true;
        }
        else {
            // Same canvas, same dimensions — just flag for Three.js to re-upload
            word.texture.needsUpdate = true;
        }
        this.syncWordSprite(word);
    }
    syncWordSprite(word) {
        if (!word.sprite)
            return;
        const width = word.width || 120;
        const height = word.height || 76;
        word.sprite.scale.set(width, height, 1);
        word.sprite.position.set(word.x + width / 2, LOGICAL_HEIGHT - word.y + height / 2 - WORD_FONT_SIZE, 0);
        word.sprite.updateMatrix();
    }
    removeWord(word) {
        if (word.sprite) {
            this.scene.remove(word.sprite);
        }
        word.texture?.dispose();
        word.material?.dispose();
        word.sprite = undefined;
        word.texture = undefined;
        word.material = undefined;
    }
    clearWords() {
        this.words.forEach(word => this.removeWord(word));
        this.words = [];
    }
    animate(timestamp = performance.now()) {
        this.animationFrame = null;
        const deltaTime = Math.max(0, timestamp - this.lastTimestamp);
        this.lastTimestamp = timestamp;
        const activeWord = this.words[0]?.originalText ?? '';
        const activeWordSourceIndex = this.words[0]?.sourceIndex;
        for (const instance of this.threeThemeInstances.values()) {
            instance.update({
                timestamp,
                deltaTime,
                activeWord,
                activeWordSourceIndex,
                language: this.language,
                frequencyLimit: this.frequencyLimit
            });
        }
        if (this.pause || this.isGameOver) {
            this.renderer.render(this.scene, this.camera);
            return;
        }
        this.timeElapsed += deltaTime;
        if (this.WPM === 30 || this.WPM === 101 || this.WPM === 201) {
            const speedIncrease = 0.00001;
            this.words.forEach(word => {
                word.speed += speedIncrease;
            });
        }
        if (this.ambientParticles) {
            this.ambientParticles.position.y = Math.sin(timestamp * 0.00035) * 8;
            this.ambientParticles.position.x = Math.cos(timestamp * 0.00022) * 5;
        }
        this.words.forEach(word => {
            word.y += word.speed * deltaTime;
            this.syncWordSprite(word);
        });
        this.updateHud();
        this.renderer.render(this.scene, this.camera);
        if (this.words.length > 0 && this.words[0].y > LOGICAL_HEIGHT) {
            this.gameOver();
            return;
        }
        this.animationFrame = requestAnimationFrame(this._boundAnimate);
    }
    pauseGame() {
        if (this.isGameOver)
            return;
        this.pause = true;
        this.telemetry.focusEvents.push({ t: performance.now() + performance.timeOrigin, type: 'blur' });
        const paused = document.getElementById('GamePaused');
        if (paused)
            paused.style.display = 'block';
    }
    resumeGame() {
        if (this.isGameOver)
            return;
        this.pause = false;
        this.telemetry.focusEvents.push({ t: performance.now() + performance.timeOrigin, type: 'focus' });
        this.lastTimestamp = performance.now();
        const paused = document.getElementById('GamePaused');
        if (paused)
            paused.style.display = 'none';
        if (this.animationFrame === null) {
            this.animate(this.lastTimestamp);
        }
    }
    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }
    async gameOver() {
        if (this.isGameOver)
            return;
        this.isGameOver = true;
        if (this.animationFrame !== null) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
        const endTime = Date.now();
        const timeElapsed = endTime - this.startTime;
        const precision = this.keystrokes === 0 ? 100 : ((this.keystrokes - this.typos) / this.keystrokes) * 100;
        localStorage.setItem('precision', precision.toString());
        localStorage.setItem('mode', this.mode);
        localStorage.setItem('playerName', this.playerName);
        localStorage.setItem('timeElapsed', this.timeElapsed.toString());
        try {
            // Read JWT session for authenticated score submission
            let authHeader = {};
            let token = null;
            const sessionStr = localStorage.getItem('kr_session');
            if (sessionStr) {
                try {
                    const session = JSON.parse(sessionStr);
                    if (session.token) {
                        authHeader = { 'Authorization': `Bearer ${session.token}` };
                        token = session.token;
                    }
                }
                catch { /* ignore */ }
            }
            this.telemetry.gameEndedAt = endTime;
            const scorePayload = {
                score: this.score,
                language: this.language,
                WPM: this.WPM,
                keystrokes: this.keystrokes,
                timeElapsed,
                typos: this.typos,
                mode: this.mode
                    + (this.addNumbersSetting ? '+N' : '')
                    + (this.applyGrammarSetting ? '+P' : ''),
                telemetry: this.telemetry
            };
            // Only POST if authenticated; otherwise stash for later
            if (token) {
                const response = await fetch('/score', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeader },
                    body: JSON.stringify(scorePayload)
                });
                if (!response.ok) {
                    console.error('Failed to send score to server', response.status);
                }
                else {
                    localStorage.removeItem('kr_pending_score');
                }
            }
            else {
                localStorage.setItem('kr_pending_score', JSON.stringify(scorePayload));
            }
        }
        catch (error) {
            console.error('Failed to send score to server', error);
        }
        window.location.href = `/game-over.html?score=${this.score}&language=${this.language}&WPM=${this.WPM}`;
    }
    setPlayerName(newName) {
        if (newName.length >= 3 && newName.length <= 30) {
            localStorage.setItem('playerName', newName);
            this.playerName = newName;
        }
        else {
            throw new Error('Player name must be between 3 and 30 characters.');
        }
    }
}
// Global registry so opening one dropdown closes any other
const allDropdowns = [];
function closeAllDropdowns() {
    for (const dd of allDropdowns) {
        if (dd.menu.style.display !== 'none') {
            dd.menu.style.display = 'none';
            dd.onClose();
        }
    }
}
function makeCustomDropdown(selectEl, options, selectedValue, onChange, onOpen, onClose) {
    const wrapper = document.createElement('div');
    wrapper.className = 'kr-select';
    const trigger = document.createElement('div');
    trigger.className = 'kr-trigger';
    const menu = document.createElement('div');
    menu.className = 'kr-menu';
    menu.style.display = 'none';
    allDropdowns.push({ menu, onClose });
    let currentOptions = options;
    const renderMenu = () => {
        menu.innerHTML = '';
        currentOptions.forEach(opt => {
            const row = document.createElement('div');
            row.className = 'kr-option';
            row.innerHTML = opt.markup || opt.text;
            row.addEventListener('click', (event) => {
                event.stopPropagation();
                setSelected(opt.value);
            });
            menu.appendChild(row);
        });
    };
    const setOptions = (opts, selected) => {
        currentOptions = opts;
        renderMenu();
        if (selected !== undefined)
            setSelected(selected);
    };
    const setSelected = (value, silent = false) => {
        const opt = currentOptions.find(o => o.value === value);
        if (opt) {
            trigger.innerHTML = opt.markup || opt.text;
        }
        selectEl.value = value;
        // Only fire onChange for non-silent calls (user interaction or setOptions).
        // Silent mode is used for the initial value so dropdown creation doesn't
        // trigger side effects like restarts mid-initialization.
        if (!silent) {
            onChange(value);
        }
        menu.style.display = 'none';
    };
    renderMenu();
    menu.addEventListener('click', (event) => {
        event.stopPropagation();
    });
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu.style.display !== 'none') {
            menu.style.display = 'none';
            onClose();
        }
        else {
            closeAllDropdowns();
            const rect = trigger.getBoundingClientRect();
            const menuHeight = Math.min(220, menu.scrollHeight || 220);
            if (rect.bottom + menuHeight + 8 > window.innerHeight && rect.top > menuHeight) {
                // Open upward if near bottom and there's room above
                menu.style.top = '';
                menu.style.bottom = (window.innerHeight - rect.top) + 'px';
            }
            else {
                menu.style.top = (rect.bottom + 2) + 'px';
                menu.style.bottom = '';
            }
            menu.style.left = rect.left + 'px';
            menu.style.width = rect.width + 'px';
            menu.style.display = 'block';
            onOpen();
        }
    });
    document.addEventListener('click', () => {
        if (menu.style.display !== 'none') {
            menu.style.display = 'none';
            onClose();
        }
    });
    wrapper.appendChild(trigger);
    // Append to body so it escapes parent clipping (backdrop-filter creates containing block)
    document.body.appendChild(menu);
    selectEl.style.display = 'none';
    selectEl.parentNode.insertBefore(wrapper, selectEl);
    setSelected(selectedValue, true);
    return { setOptions, setSelected, trigger, menu };
}
async function populateLanguages(languageInput, selectedLanguage, onChange, onOpen, onClose) {
    const flagPath = (code) => `/flags/${code}.png`;
    const fmt = (n) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
    let languages;
    try {
        const response = await fetch('/languages');
        const fetched = await response.json();
        languages = Array.isArray(fetched) ? fetched : [{ code: 'english', count: 0 }, { code: 'french', count: 0 }];
    }
    catch {
        console.error('Error fetching languages');
        languages = [{ code: 'english', count: 0 }, { code: 'french', count: 0 }];
    }
    const options = languages.map(({ code, count }) => ({
        text: code,
        value: code,
        markup: `<img src="${flagPath(code)}" width="18" height="14" style="vertical-align:middle;margin-right:6px"> ${code} <span style="color:#888;font-size:0.8em;margin-left:4px">(${fmt(count)})</span>`,
    }));
    const match = languages.some(l => l.code === selectedLanguage) ? selectedLanguage : DEFAULT_LANGUAGE;
    makeCustomDropdown(languageInput, options, match, onChange, onOpen, onClose);
}
async function populateFrequencyLimits(frequencyInput, dd, language, selectedLimit) {
    try {
        const response = await fetch(`/words/${language}/words.json`);
        const data = (await response.json());
        const limits = data.frequencyOptions && data.frequencyOptions.length > 0
            ? data.frequencyOptions
            : [200, 1000, 2000, 10000, data.words.length].filter((value, index, arr) => value <= data.words.length && arr.indexOf(value) === index);
        const opts = limits.map((limit) => {
            let text = limit >= 1000 ? `Top ${Math.round(limit / 1000)}k` : `Top ${limit}`;
            if (limit === data.words.length)
                text = `All ${limit.toLocaleString()}`;
            return { text, value: String(limit) };
        });
        const selected = limits.includes(selectedLimit) ? String(selectedLimit) : String(limits.find(v => v >= selectedLimit) || limits[limits.length - 1]);
        dd.setOptions(opts, selected);
    }
    catch {
        console.error('Frequency options error');
    }
}
const gameStage = document.getElementById('game');
const wpmInput = document.getElementById('wpm');
const modeInput = document.getElementById('mode');
const languageInput = document.getElementById('language');
const frequencyInput = document.getElementById('frequency-limit');
const themeInput = document.getElementById('theme');
const playerNameInput = document.getElementById('player-name');
Game.create(gameStage, undefined, 30, DEFAULT_LANGUAGE).then(async (game) => {
    const settingsMenu = document.getElementById('settings-menu');
    const safeResume = () => {
        if (settingsMenu.style.display === 'none')
            game.resumeGame();
    };
    // Frequency dropdown first (empty), so we have the controller for populateFrequencyLimits
    const freqDD = makeCustomDropdown(frequencyInput, [], '', (v) => {
        game.setFrequencyLimit(Number(v));
    }, () => game.pauseGame(), safeResume);
    await populateLanguages(languageInput, game.getLanguage(), (code) => {
        populateFrequencyLimits(frequencyInput, freqDD, code, game.getFrequencyLimit()).then(() => {
            const selectedLimit = Number(frequencyInput.value);
            if (Number.isFinite(selectedLimit)) {
                game.setFrequencyLimit(selectedLimit);
            }
            game.setLanguage(code);
        });
    }, () => game.pauseGame(), safeResume);
    await populateFrequencyLimits(frequencyInput, freqDD, game.getLanguage(), game.getFrequencyLimit());
    game.initialize();
    // Mode custom dropdown
    makeCustomDropdown(modeInput, [
        { text: 'Rage 🛈', value: 'rage' },
        { text: 'Precision 🛈', value: 'precision' },
        { text: 'Fast 🛈', value: 'fast' },
    ], game.getMode(), (v) => {
        game.setMode(v);
    }, () => game.pauseGame(), safeResume);
    // Restore semantic seed from previous session
    const savedSeedId = localStorage.getItem('semanticSeedId');
    const savedSeedWord = localStorage.getItem('semanticSeedWord');
    const savedSeedLang = localStorage.getItem('semanticSeedLang');
    if (savedSeedId && savedSeedWord && savedSeedLang) {
        game.setSemanticSeed(Number(savedSeedId), savedSeedWord, savedSeedLang);
    }
    wpmInput.value = game.getWPM().toString();
    wpmInput.addEventListener('change', () => {
        const newWPM = Number(wpmInput.value);
        game.setWPM(newWPM);
    });
    wpmInput.addEventListener('focus', () => game.pauseGame());
    wpmInput.addEventListener('blur', safeResume);
    // Theme custom dropdown — calls changeTheme directly (no native event dispatch)
    const themeOpts = [
        ...THEME_OPTIONS.map(t => ({ text: t.label, value: t.id })),
        { text: 'Custom YouTube', value: 'custom-youtube' }
    ];
    const themeDD = makeCustomDropdown(themeInput, themeOpts, game.getTheme(), (_v) => {
        game.changeTheme();
    }, () => game.pauseGame(), safeResume);
    // Custom YouTube URL input — extract ID on change, persist to localStorage
    const ytInput = document.getElementById('custom-youtube-url');
    if (ytInput) {
        // Restore saved URL
        const savedYtId = localStorage.getItem('customYoutubeId');
        if (savedYtId) {
            ytInput.value = `https://youtube.com/watch?v=${savedYtId}`;
        }
        ytInput.addEventListener('input', () => {
            const id = extractYouTubeId(ytInput.value);
            if (id) {
                localStorage.setItem('customYoutubeId', id);
                // Auto-switch to YouTube theme when a valid URL is pasted
                if (game.getTheme() !== 'custom-youtube') {
                    themeDD.setSelected('custom-youtube');
                }
                game.changeTheme();
            }
            else if (ytInput.value.trim() === '') {
                localStorage.removeItem('customYoutubeId');
            }
        });
        ytInput.addEventListener('focus', () => game.pauseGame());
        ytInput.addEventListener('blur', safeResume);
        // Show/hide YT container based on current theme
        const ytContainer = document.getElementById('custom-yt-container');
        if (ytContainer) {
            ytContainer.style.display = game.getTheme() === 'custom-youtube' ? '' : 'none';
        }
    }
    playerNameInput.addEventListener('focus', () => game.pauseGame());
    playerNameInput.addEventListener('blur', safeResume);
    let playerName = localStorage.getItem('playerName');
    if (!playerName) {
        playerName = `Player${Math.floor(Math.random() * 1000000)}`;
        localStorage.setItem('playerName', playerName);
        game.setPlayerName(playerName);
    }
    playerNameInput.value = playerName;
    playerNameInput.addEventListener('change', () => {
        game.setPlayerName(playerNameInput.value);
        localStorage.setItem('playerName', playerNameInput.value);
    });
}).catch(error => {
    console.error('Failed to initialize KeyboardRage:', error);
});
