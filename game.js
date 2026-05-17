import * as THREE from 'three';
import { FRACTAL_VERTEX_SHADER } from './themes/shader-core.js';
import { THEME_OPTIONS, THREE_BACKGROUND_THEMES, VIDEO_THEMES, isThreeBackgroundTheme } from './themes/registry.js';
import { shouldIgnoreDeadAccentKey, typedKeyPrefixLength } from './typing-input.js';
const LOGICAL_WIDTH = 800;
const LOGICAL_HEIGHT = 600;
const WORD_FONT_SIZE = 48;
const WORD_FONT = `700 ${WORD_FONT_SIZE}px "Courier New", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace`;
const WORD_FILL = '#f8f8f2';
const WORD_MUTED = '#777777';
const WORD_DANGER = '#FF0000';
class Game {
    constructor(container, playerName, WPM = 60, language = 'english') {
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
        this.theme = localStorage.getItem('theme') || 'default';
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
        this.token = null;
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
        this.themeSelector = document.getElementById('theme');
        this.populateThemeSelector();
        this.themeSelector.value = this.theme;
        if (!this.themeSelector.value) {
            this.themeSelector.value = 'default';
            this.theme = 'default';
        }
        this.themeSelector.addEventListener('change', this.changeTheme.bind(this));
        this.createThemeBackgrounds();
        this.resizeRenderer();
        window.addEventListener('resize', this.resizeRenderer.bind(this));
        this.createAmbientParticles();
        this.changeTheme();
        this.updateHud();
    }
    static async create(container, playerName = 'Player', WPM = 60, language = 'english') {
        const game = new Game(container, playerName, WPM, language);
        await game.fetchToken();
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
        this.themeSelector.replaceChildren(...options);
    }
    createThemeBackgrounds() {
        for (const theme of THREE_BACKGROUND_THEMES) {
            const instance = theme.backgroundType === 'custom'
                ? theme.createBackground({
                    scene: this.scene,
                    renderer: this.renderer,
                    logicalWidth: LOGICAL_WIDTH,
                    logicalHeight: LOGICAL_HEIGHT
                })
                : this.createShaderThemeBackground(theme);
            this.threeThemeInstances.set(theme.id, instance);
        }
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
        if (this.ambientParticleMaterial) {
            this.ambientParticleMaterial.color.set(this.currentAccentColor());
        }
        this.updateFractalThemeColors();
    }
    updateHud() {
        const currentScoreElement = document.getElementById('current-score');
        if (currentScoreElement)
            currentScoreElement.textContent = `${this.score}`;
        const hudWpm = document.getElementById('hud-wpm');
        if (hudWpm)
            hudWpm.textContent = this.formatWPM(this.WPM);
        const themeLabel = document.getElementById('theme-label');
        if (themeLabel)
            themeLabel.textContent = this.selectedOptionText(this.themeSelector);
        const modeLabel = document.getElementById('mode-label');
        if (modeLabel)
            modeLabel.textContent = this.formatMode(this.mode);
    }
    selectedOptionText(select) {
        return select.selectedOptions[0]?.textContent?.replace(' (YT)', '').trim() || select.value || 'Default';
    }
    formatWPM(wpm) {
        if (wpm === 30)
            return '30⇢∞';
        if (wpm === 101)
            return '100⇢∞';
        return `${wpm}`;
    }
    formatMode(mode) {
        return mode.charAt(0).toUpperCase() + mode.slice(1);
    }
    closeSettingsMenuIfClickedOutside(event) {
        const path = event.composedPath();
        const inputFields = ['player-name', 'wpm', 'mode', 'language', 'theme', 'grammar', 'addNumbers'];
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
    async fetchToken() {
        try {
            const response = await fetch('/token');
            const data = await response.json();
            this.token = data.token;
        }
        catch (error) {
            console.warn('Token endpoint unavailable; scores will not be ranked in this session.', error);
            this.token = Math.random().toString(36).slice(2);
        }
    }
    changeTheme() {
        this.theme = this.themeSelector.value || 'default';
        localStorage.setItem('theme', this.theme);
        document.body.setAttribute('data-theme', this.theme);
        const iframe = document.getElementById('myVideo');
        const videoTheme = VIDEO_THEMES[this.theme];
        const isFractalTheme = this.isThreeFractalTheme();
        for (const [themeId, instance] of this.threeThemeInstances) {
            instance.setVisible(this.theme === themeId);
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
        const response = await fetch(`/words/${this.language}.json`);
        const data = (await response.json());
        this.allWords = this.shuffleArray(data.words.map((word, sourceIndex) => ({
            text: this.addRandomNumbers(this.applyGrammar(word)),
            sourceIndex
        })));
        this.averageCharLength = data.charLength;
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
    restart(currentWPM) {
        this.score = 0;
        this.clearWords();
        this.originalWPM = currentWPM;
        this.timeElapsed = 0;
        this.keystrokes = 0;
        this.typos = 0;
        this.startTime = Date.now();
        this.isGameOver = false;
        this.wordIndex = 0;
        this.updateHud();
        this.fetchWords().then(() => {
            setTimeout(() => {
                if (!this.isGameOver && this.words.length === 0) {
                    this.generateWords();
                    if (!this.pause && this.animationFrame === null) {
                        this.lastTimestamp = performance.now();
                        this.animate(this.lastTimestamp);
                    }
                }
            }, 500);
        });
    }
    initialize() {
        this.container.focus({ preventScroll: true });
        setTimeout(() => {
            this.generateWords();
            this.lastTimestamp = performance.now();
            this.animate(this.lastTimestamp);
        }, 500);
        window.addEventListener('keydown', (event) => this.handleKeydown(event));
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
        if (["Shift", "Control", "Alt", "AltGraph", "Meta", "Backspace", "CapsLock", "Escape", "Dead"].includes(event.key)
            || (event.key >= 'F1' && event.key <= 'F12')) {
            return;
        }
        event.preventDefault();
        if (this.words.length === 0)
            return;
        const firstWord = this.words[0];
        if (shouldIgnoreDeadAccentKey(event.key, firstWord.text)) {
            return;
        }
        this.keystrokes++;
        const typedLength = typedKeyPrefixLength(firstWord.text, event.key);
        if (typedLength > 0) {
            firstWord.text = firstWord.text.slice(typedLength);
            firstWord.color = WORD_FILL;
            firstWord.currentIndex += typedLength;
            if (firstWord.text.length === 0 && !(this.mode === 'fast' && firstWord.isTypoMade && event.key !== ' ')) {
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
    generateWords() {
        this.nextBatch();
        const shuffledList = this.shuffleArray([...this.wordList]);
        const offset = this.words.length > 0 ? this.words[this.words.length - 1].y - 80 : 0;
        const lastWordSpeed = this.words.length > 0
            ? this.words[this.words.length - 1].speed
            : (this.WPM * 20) / 60 / 60 / this.averageCharLength;
        shuffledList.forEach((entry, index) => {
            const wordText = entry.text;
            const textWidth = this.measureWordWidth(wordText);
            const maxWordX = Math.max(24, LOGICAL_WIDTH - textWidth - 24);
            const word = {
                text: wordText,
                originalText: wordText,
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
        return this.measureContext.measureText(text).width;
    }
    createWordSprite(word) {
        const texture = this.renderWordTexture(word);
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
        word.texture = texture;
        word.material = material;
        word.sprite = sprite;
        sprite.renderOrder = 10;
        this.syncWordSprite(word);
        this.scene.add(sprite);
    }
    renderWordTexture(word) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.measureContext.font = WORD_FONT;
        let width = 24;
        for (const char of word.text) {
            width += this.measureContext.measureText(char === ' ' ? '⎵' : char).width;
        }
        width = Math.max(72, Math.ceil(width + 28));
        const height = 76;
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(width * dpr);
        canvas.height = Math.ceil(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        const context = canvas.getContext('2d');
        context.scale(dpr, dpr);
        context.clearRect(0, 0, width, height);
        context.font = WORD_FONT;
        context.textBaseline = 'alphabetic';
        context.shadowColor = word.color === WORD_DANGER ? 'rgba(255, 0, 64, 0.9)' : 'rgba(125, 249, 255, 0.42)';
        context.shadowBlur = word.color === WORD_DANGER ? 20 : 12;
        let offsetX = 12;
        const baseline = 54;
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
        word.width = width;
        word.height = height;
        return new THREE.CanvasTexture(canvas);
    }
    updateWordTexture(word) {
        if (!word.sprite || !word.material)
            return;
        const oldTexture = word.texture;
        const nextTexture = this.renderWordTexture(word);
        nextTexture.minFilter = THREE.LinearFilter;
        nextTexture.magFilter = THREE.LinearFilter;
        nextTexture.generateMipmaps = false;
        word.texture = nextTexture;
        word.material.map = nextTexture;
        word.material.needsUpdate = true;
        oldTexture?.dispose();
        this.syncWordSprite(word);
    }
    syncWordSprite(word) {
        if (!word.sprite)
            return;
        const width = word.width || 120;
        const height = word.height || 76;
        word.sprite.scale.set(width, height, 1);
        word.sprite.position.set(word.x + width / 2, LOGICAL_HEIGHT - word.y + height / 2 - WORD_FONT_SIZE, 0);
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
            instance.update({ timestamp, deltaTime, activeWord, activeWordSourceIndex, language: this.language });
        }
        if (this.pause || this.isGameOver) {
            this.renderer.render(this.scene, this.camera);
            return;
        }
        this.timeElapsed += deltaTime;
        if (this.WPM === 30 || this.WPM === 101) {
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
        this.animationFrame = requestAnimationFrame(this.animate.bind(this));
    }
    pauseGame() {
        if (this.isGameOver)
            return;
        this.pause = true;
        const paused = document.getElementById('GamePaused');
        if (paused)
            paused.style.display = 'block';
    }
    resumeGame() {
        if (this.isGameOver)
            return;
        this.pause = false;
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
            const response = await fetch('/score', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: this.token,
                    name: this.playerName,
                    score: this.score,
                    language: this.language,
                    WPM: this.WPM,
                    keystrokes: this.keystrokes,
                    timeElapsed,
                    typos: this.typos,
                    mode: this.mode
                        + (this.addNumbersSetting ? '+N' : '')
                        + (this.applyGrammarSetting ? '+P' : '')
                })
            });
            if (!response.ok) {
                console.error('Failed to send score to server');
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
async function populateLanguages(languageInput, selectedLanguage) {
    try {
        const response = await fetch('/languages');
        const languages = await response.json();
        languageInput.innerHTML = '';
        languages.forEach((language) => {
            const option = document.createElement('option');
            option.value = language;
            option.text = language;
            languageInput.appendChild(option);
        });
        languageInput.value = selectedLanguage;
    }
    catch (error) {
        console.error('Error:', error);
    }
}
const gameStage = document.getElementById('game');
const wpmInput = document.getElementById('wpm');
const modeInput = document.getElementById('mode');
const languageInput = document.getElementById('language');
const playerNameInput = document.getElementById('player-name');
Game.create(gameStage, undefined, 30, 'english').then(async (game) => {
    await populateLanguages(languageInput, game.getLanguage());
    game.initialize();
    modeInput.value = game.getMode();
    modeInput.addEventListener('change', () => {
        game.setMode(modeInput.value);
    });
    modeInput.addEventListener('focus', () => game.pauseGame());
    modeInput.addEventListener('blur', () => game.resumeGame());
    wpmInput.value = game.getWPM().toString();
    wpmInput.addEventListener('change', () => {
        const newWPM = Number(wpmInput.value);
        game.setWPM(newWPM);
    });
    wpmInput.addEventListener('focus', () => game.pauseGame());
    wpmInput.addEventListener('blur', () => game.resumeGame());
    languageInput.addEventListener('change', () => {
        game.setLanguage(languageInput.value);
    });
    languageInput.addEventListener('focus', () => game.pauseGame());
    languageInput.addEventListener('blur', () => game.resumeGame());
    playerNameInput.addEventListener('focus', () => game.pauseGame());
    playerNameInput.addEventListener('blur', () => game.resumeGame());
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
