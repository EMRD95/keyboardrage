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
        this.batchSize = 100;
        this.wordIndex = 0;
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
            this.generateWords();
        });
    }
    initialize() {
        this.context.font = "48px 'Courier New', Courier, monospace";
        this.generateWords();
        this.animate();
        window.addEventListener('keydown', (event) => {
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
                    if (this.words.length === 0) {
                        this.generateWords();
                    }
                }
            }
            else {
                firstWord.speed *= 1.1;
                firstWord.color = '#FF0000';
                firstWord.currentIndex = firstWord.text[0] === ' ' ? 0 : firstWord.currentIndex;
            }
        });
    }
    generateWords() {
        // Fetch more words if the wordList is empty
        if (this.wordList.length === 0) {
            this.nextBatch();
        }
        const shuffledList = this.shuffleArray(this.wordList);
        shuffledList.forEach((wordText, index) => {
            const textWidth = this.context.measureText(wordText).width;
            const maxWordX = this.canvas.width - textWidth;
            const charsPerFrame = (this.WPM * 180) / 60 / 60; // 5 is the average character length of English words
            const speed = charsPerFrame / this.averageCharLength;
            const word = {
                text: wordText,
                x: Math.random() * maxWordX,
                y: -index * 80,
                speed: speed,
                originalSpeed: speed,
                color: '#f8f8f2',
                currentIndex: 0
            };
            this.words.push(word);
        });
    }
    animate() {
        if (this.pause) {
            requestAnimationFrame(() => this.animate());
            return;
        }
        this.timeElapsed++;
        if (this.WPM === 30) {
            this.words.forEach(word => {
                word.speed += this.timeElapsed / 10000000;
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
            word.y += word.speed;
        });
        const currentScoreElement = document.getElementById('current-score');
        currentScoreElement.textContent = `${this.score}`;
        if (this.words.length > 0 && this.words[0].y > this.canvas.height) {
            this.gameOver();
            return;
        }
        requestAnimationFrame(() => this.animate());
    }
    pauseGame() {
        this.pause = true;
    }
    resumeGame() {
        this.pause = false;
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
Game.create(canvas, "Player", 30, 'english').then(game => {
    game.initialize();
    game.animate();
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
