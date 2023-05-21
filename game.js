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
        this.canvas = canvas;
        this.context = this.canvas.getContext("2d");
        this.WPM = localStorage.getItem('WPM') ? parseInt(localStorage.getItem('WPM')) : WPM;
        this.words = [];
        this.wordList = [];
        this.score = 0;
        this.language = localStorage.getItem('language') || language;
        this.originalWPM = this.WPM;
        this.playerName = localStorage.getItem('playerName') || playerName; // Retrieve player name from localStorage
        this.pause = false;
    }
    static create(canvas, playerName, WPM = 60, language = 'english') {
        return __awaiter(this, void 0, void 0, function* () {
            const game = new Game(canvas, playerName, WPM, language);
            yield game.fetchWords();
            return game;
        });
    }
    fetchWords() {
        return __awaiter(this, void 0, void 0, function* () {
            const response = yield fetch(`/words/${this.language}.json`);
            const data = yield response.json();
            this.wordList = data.words;
        });
    }
    setLanguage(newLanguage) {
        if (newLanguage !== this.language) { // Check if the language has actually changed
            localStorage.setItem('language', newLanguage);
            this.language = newLanguage;
            this.words = [];
            this.fetchWords().then(() => {
                this.restart(this.WPM);
            });
        }
    }
    setWPM(newWPM) {
        if (newWPM !== this.WPM) { // Check if the WPM has actually changed
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
        this.fetchWords().then(() => {
            this.generateWords();
        });
    }
    initialize() {
        this.context.font = "48px 'Courier New', Courier, monospace";
        this.generateWords();
        this.animate(); // start the game loop here
        window.addEventListener('keydown', (event) => {
            if (this.words.length === 0)
                return;
            const firstWord = this.words[0];
            if (firstWord.text.startsWith(event.key)) {
                firstWord.text = firstWord.text.slice(1);
                if (firstWord.text.length === 0) {
                    this.words.shift();
                    this.score++;
                    if (this.words.length === 0) {
                        this.generateWords();
                    }
                }
            }
        });
    }
    generateWords() {
        const shuffledList = this.shuffleArray(this.wordList);
        shuffledList.forEach((wordText, index) => {
            const textWidth = this.context.measureText(wordText).width;
            const maxWordX = this.canvas.width - textWidth;
            const charsPerFrame = (this.WPM * 5) / 60 / 60;
            const charLength = 7; // You can adjust this
            const speed = charsPerFrame * charLength;
            const word = {
                text: wordText,
                x: Math.random() * maxWordX,
                y: -index * 80,
                speed: speed,
                originalSpeed: speed
            };
            this.words.push(word);
        });
    }
    animate() {
        if (this.pause) { // If the game is paused, don't update anything
            requestAnimationFrame(() => this.animate());
            return;
        }
        this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.context.fillStyle = '#f8f8f2';
        this.words.forEach(word => {
            let offsetX = 0;
            for (let char of word.text) {
                if (char === ' ') { // or you can check for the ⎵ character directly if your words already have it
                    this.context.fillStyle = '#404040'; // Change this to the desired color for ⎵ character
                    this.context.fillText('⎵', word.x + offsetX, word.y); // Replace space with ⎵ character
                    this.context.fillStyle = '#f8f8f2'; // Reset color back to the normal one
                }
                else {
                    this.context.fillText(char, word.x + offsetX, word.y);
                }
                offsetX += this.context.measureText(char).width; // Increase the X-offset by the width of the current character
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
            // Send the score to the server
            const response = yield fetch('/score', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: this.playerName, score: this.score, language: this.language, WPM: this.WPM })
            });
            if (!response.ok) {
                console.error('Failed to send score to server');
            }
            // Navigate to the game over page
            window.location.href = `/game-over.html?score=${this.score}&language=${this.language}&WPM=${this.WPM}`;
        });
    }
    displayLeaderboard(leaderboard) {
        // Clear out the existing leaderboard
        const leaderboardElement = document.getElementById('leaderboard');
        leaderboardElement.innerHTML = '';
        // Add each score to the leaderboard
        leaderboard.forEach(score => {
            const scoreElement = document.createElement('div');
            scoreElement.textContent = `${score.name}: ${score.score}`;
            leaderboardElement.appendChild(scoreElement);
        });
    }
    // Add a method to update the player name
    setPlayerName(newName) {
        if (newName.length >= 3 && newName.length <= 30) {
            localStorage.setItem('playerName', newName); // Save player name to localStorage
            this.playerName = newName;
        }
        else {
            throw new Error("Player name must be between 3 and 30 characters.");
        }
    }
}
// Here's your list of languages
const languages = [
    "english",
    "french"
];
// Get a reference to your dropdown
const languageInput = document.getElementById('language');
// Fill it with options
languages.forEach((language) => {
    const option = document.createElement('option');
    option.value = language;
    option.text = language;
    languageInput.appendChild(option);
});
// Get a reference to the canvas and the WPM input
const canvas = document.getElementById('game');
const wpmInput = document.getElementById('wpm');
// Create the game instance
Game.create(canvas, "Player", 30, 'english').then(game => {
    game.initialize();
    game.animate();
    wpmInput.value = localStorage.getItem('WPM') || '30'; // Read the WPM from localStorage
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
    languageInput.value = localStorage.getItem('language') || 'english'; // Read the language from localStorage
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
    playerNameInput.value = localStorage.getItem('playerName') || 'Player'; // Retrieve the player name from localStorage
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
