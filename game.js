var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
class Game {
    constructor(canvas, playerName, WPM = 60, language = 'english') {
        this.isGameOver = false;
        this.batchSize = 10;
        this.wordIndex = 0;
        this.mode = localStorage.getItem('mode') || 'rage';
        this.canvas = canvas;
        this.context = this.canvas.getContext("2d");
        this.WPM = localStorage.getItem('WPM') ? parseInt(localStorage.getItem('WPM')) : WPM;
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
        this.lastTimestamp = 0;
        this.settingsButton = document.getElementById('settings-button');
        this.settingsMenu = document.getElementById('settings-menu');
        this.settingsButton.addEventListener('click', this.toggleSettingsMenu.bind(this));
        document.addEventListener('click', this.closeSettingsMenuIfClickedOutside.bind(this));
    }
    closeSettingsMenuIfClickedOutside(event) {
        const path = event.composedPath();
        const inputFields = ["player-name", "wpm", "mode", "language"];
        if (this.settingsMenu.style.display !== "none" && !path.includes(this.settingsMenu) && !path.includes(this.settingsButton)) {
            const clickedOnInputField = path.some((element) => element.id && inputFields.includes(element.id));
            if (!clickedOnInputField) {
                this.settingsMenu.style.display = "none";
                this.resumeGame(); // Resume game when settings are closed
            }
        }
    }
    toggleSettingsMenu() {
        if (this.settingsMenu.style.display === "none") {
            this.settingsMenu.style.display = "block";
            this.pauseGame(); // Pause game when settings are open
        }
        else {
            this.settingsMenu.style.display = "none";
            this.resumeGame(); // Resume game when settings are closed
        }
    }
    static create(canvas, playerName, WPM = 60, language = 'english') {
        return __awaiter(this, void 0, void 0, function* () {
            const game = new Game(canvas, playerName, WPM, language);
            yield game.fetchToken();
            yield game.fetchWords();
            return game;
        });
    }
    fetchToken() {
        return __awaiter(this, void 0, void 0, function* () {
            const response = yield fetch('/token');
            const data = yield response.json();
            this.token = data.token;
        });
    }
    fetchWords() {
        return __awaiter(this, void 0, void 0, function* () {
            const response = yield fetch(`/words/${this.language}.json`);
            const data = yield response.json();
            this.allWords = this.shuffleArray(data.words);
            this.averageCharLength = data.charLength;
            this.nextBatch();
        });
    }
    nextBatch() {
        if (this.wordIndex + this.batchSize > this.allWords.length) {
            this.wordIndex = 0; // Loop back to start
        }
        this.wordList = this.allWords.slice(this.wordIndex, this.wordIndex + this.batchSize);
        this.wordIndex += this.batchSize;
    }
    setMode(newMode) {
        if (newMode !== this.mode) {
            localStorage.setItem('mode', newMode);
            this.mode = newMode;
            this.restart(this.WPM);
        }
    }
    setLanguage(newLanguage) {
        if (newLanguage !== this.language) {
            localStorage.setItem('language', newLanguage);
            this.language = newLanguage;
            this.words = [];
            this.wordIndex = 0; // Reset wordIndex when language changes
            this.fetchWords().then(() => {
                this.restart(this.WPM);
            });
        }
    }
    setWPM(newWPM) {
        if (newWPM !== this.WPM) {
            localStorage.setItem('WPM', newWPM.toString());
            this.WPM = newWPM;
            this.originalWPM = newWPM;
            this.restart(this.WPM);
        }
    }
    restart(currentWPM) {
        this.score = 0;
        this.words = [];
        this.originalWPM = currentWPM;
        this.timeElapsed = 0;
        this.fetchWords().then(() => {
            // Wait for 1 second before generating words and starting the game
            setTimeout(() => {
                this.generateWords();
            }, 500); // delay of 1 second
        });
    }
    initialize() {
        this.context.font = "48px 'Courier New', Courier, monospace";
        setTimeout(() => {
            this.generateWords();
            this.animate();
        }, 500);
        window.addEventListener('keydown', (event) => {
            // Add a check for special keys here
            if (["Shift", "Control", "Alt", "Meta", "Tab", "Backspace", "CapsLock", "Escape", "Dead"].includes(event.key)
                || (event.key >= 'F1' && event.key <= 'F12')) {
                return; // ignore special keys
            }
            this.keystrokes++;
            if (this.words.length === 0)
                return;
            const firstWord = this.words[0];
            if (firstWord.text.startsWith(event.key)) {
                firstWord.text = firstWord.text.slice(1);
                firstWord.color = '#f8f8f2';
                firstWord.currentIndex++;
                if (firstWord.text.length === 0) {
                    this.words.shift();
                    this.score++;
                    if (this.words.length < this.batchSize) {
                        this.generateWords();
                    }
                }
            }
            else {
                if (this.mode === 'rage') {
                    firstWord.speed *= 1.1;
                    firstWord.color = '#FF0000';
                }
                else if (this.mode === 'precision') {
                    firstWord.text = firstWord.originalText;
                    firstWord.color = '#FF0000';
                    firstWord.currentIndex = 0;
                    // After 0.5 seconds, reset the color to original
                    setTimeout(() => {
                        firstWord.color = '#f8f8f2';
                    }, 500);
                }
                firstWord.currentIndex = firstWord.text[0] === ' ' ? 0 : firstWord.currentIndex;
            }
        });
    }
    generateWords() {
        // Fetch a new batch of words
        this.nextBatch();
        const shuffledList = this.shuffleArray(this.wordList);
        const offset = this.words.length > 0 ? this.words[this.words.length - 1].y - 80 : 0; // Calculate the offset based on the last word of the previous batch
        const lastWordSpeed = this.words.length > 0 ? this.words[this.words.length - 1].speed : (this.WPM * 20) / 60 / 60 / this.averageCharLength; // Get the speed of the last word in the current batch
        shuffledList.forEach((wordText, index) => {
            const textWidth = this.context.measureText(wordText).width;
            const maxWordX = this.canvas.width - textWidth;
            const word = {
                text: wordText,
                originalText: wordText,
                x: Math.random() * maxWordX,
                y: offset - index * 80,
                speed: lastWordSpeed,
                originalSpeed: lastWordSpeed,
                color: '#f8f8f2',
                currentIndex: 0
            };
            this.words.push(word);
        });
    }
    animate(timestamp = 0) {
        const deltaTime = timestamp - this.lastTimestamp;
        this.lastTimestamp = timestamp;
        if (!this.pause) {
            this.timeElapsed += deltaTime;
            if (this.WPM === 30) {
                const speedIncrease = 0.00001; // Adjust this value to control the rate of speed increase
                this.words.forEach(word => {
                    word.speed += speedIncrease;
                });
            }
            this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.context.fillStyle = '#f8f8f2';
            this.words.forEach(word => {
                let offsetX = 0;
                this.context.fillStyle = word.color;
                for (let i = 0; i < word.text.length; i++) {
                    const char = word.text[i];
                    if (char === ' ') {
                        this.context.fillStyle = i === word.currentIndex && word.color === '#FF0000' ? '#FF0000' : '#777777';
                        this.context.fillText('⎵', word.x + offsetX, word.y);
                    }
                    else {
                        this.context.fillStyle = i === word.currentIndex && word.color === '#FF0000' ? '#FF0000' : word.color;
                        this.context.fillText(char, word.x + offsetX, word.y);
                    }
                    offsetX += this.context.measureText(char).width;
                }
                word.y += word.speed * deltaTime;
            });
            const currentScoreElement = document.getElementById('current-score');
            currentScoreElement.textContent = `${this.score}`;
            if (this.words.length > 0 && this.words[0].y > this.canvas.height) {
                this.gameOver();
                return;
            }
            requestAnimationFrame(this.animate.bind(this));
        }
    }
    pauseGame() {
        this.pause = true;
    }
    resumeGame() {
        this.pause = false;
        this.lastTimestamp = performance.now();
        this.animate(this.lastTimestamp);
    }
    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }
    gameOver() {
        return __awaiter(this, void 0, void 0, function* () {
            const endTime = Date.now();
            const timeElapsed = endTime - this.startTime; // in milliseconds
            if (this.isGameOver)
                return;
            this.isGameOver = true;
            const response = yield fetch('/score', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: this.token,
                    name: this.playerName,
                    score: this.score,
                    language: this.language,
                    WPM: this.WPM,
                    keystrokes: this.keystrokes,
                    timeElapsed: timeElapsed
                })
            });
            if (!response.ok) {
                console.error('Failed to send score to server');
            }
            window.location.href = `/game-over.html?score=${this.score}&language=${this.language}&WPM=${this.WPM}`;
        });
    }
    displayLeaderboard(leaderboard) {
        const leaderboardElement = document.getElementById('leaderboard');
        leaderboardElement.innerHTML = '';
        leaderboard.forEach(score => {
            const scoreRow = document.createElement('tr');
            const nameCell = document.createElement('td');
            nameCell.textContent = score.name;
            scoreRow.appendChild(nameCell);
            const scoreCell = document.createElement('td');
            scoreCell.textContent = score.score.toString();
            scoreRow.appendChild(scoreCell);
            const dateCell = document.createElement('td');
            const date = new Date(score.timestamp);
            dateCell.textContent = date.toDateString();
            scoreRow.appendChild(dateCell);
            leaderboardElement.appendChild(scoreRow);
        });
    }
    setPlayerName(newName) {
        if (newName.length >= 3 && newName.length <= 30) {
            localStorage.setItem('playerName', newName);
            this.playerName = newName;
        }
        else {
            throw new Error("Player name must be between 3 and 30 characters.");
        }
    }
}
const languages = [
    "english",
    "english_1k",
    "english_5k",
    "english_10k",
    "english_25k",
    "english_450k",
    "french",
    "french_1k",
    "french_2k",
    "french_10k",
    "french_600k",
    "albanian",
    "bulgarian",
    "catalan",
    "croatian",
    "czech",
    "danish",
    "dutch",
    "esperanto",
    "estonian",
    "finnish",
    "german",
    "hungarian",
    "irish",
    "italian",
    "latin",
    "latvian",
    "lithuanian",
    "macedonian",
    "polish",
    "portuguese",
    "romanian",
    "russian",
    "slovenian",
    "spanish",
    "swedish",
    "swiss_german",
    "welsh"
];
const languageInput = document.getElementById('language');
languages.forEach((language) => {
    const option = document.createElement('option');
    option.value = language;
    option.text = language;
    languageInput.appendChild(option);
});
const canvas = document.getElementById('game');
const wpmInput = document.getElementById('wpm');
const modeInput = document.getElementById('mode');
Game.create(canvas, "Player", 30, 'english').then(game => {
    game.initialize();
    game.animate();
    modeInput.value = localStorage.getItem('mode') || 'rage';
    modeInput.addEventListener('change', () => {
        game.setMode(modeInput.value);
    });
    modeInput.addEventListener('focus', () => {
        game.pauseGame();
    });
    modeInput.addEventListener('blur', () => {
        game.resumeGame();
        game.setMode(modeInput.value);
    });
    wpmInput.value = localStorage.getItem('WPM') || '30';
    wpmInput.addEventListener('change', () => {
        const newWPM = Number(wpmInput.value);
        game.setWPM(newWPM);
    });
    wpmInput.addEventListener('focus', () => {
        game.pauseGame();
    });
    wpmInput.addEventListener('blur', () => {
        game.resumeGame();
        const newWPM = Number(wpmInput.value);
        game.setWPM(newWPM);
    });
    languageInput.value = localStorage.getItem('language') || 'english';
    languageInput.addEventListener('change', () => {
        game.setLanguage(languageInput.value);
    });
    languageInput.addEventListener('focus', () => {
        game.pauseGame();
    });
    languageInput.addEventListener('blur', () => {
        game.resumeGame();
        game.setLanguage(languageInput.value);
    });
    const playerNameInput = document.getElementById('player-name');
    playerNameInput.addEventListener('focus', () => {
        game.pauseGame();
    });
    playerNameInput.addEventListener('blur', () => {
        game.resumeGame();
    });
    playerNameInput.value = localStorage.getItem('playerName') || 'Player';
    playerNameInput.addEventListener('change', () => {
        game.setPlayerName(playerNameInput.value);
    });
    let prevWPM = Number(localStorage.getItem('WPM')) || 30;
    wpmInput.addEventListener('change', () => {
        const newWPM = Number(wpmInput.value);
        if (newWPM !== prevWPM) {
            prevWPM = newWPM;
            game.setWPM(newWPM);
        }
    });
    let prevLanguage = localStorage.getItem('language') || 'english';
    languageInput.addEventListener('change', () => {
        const newLanguage = languageInput.value;
        if (newLanguage !== prevLanguage) {
            prevLanguage = newLanguage;
            game.setLanguage(newLanguage);
        }
    });
});
