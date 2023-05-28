interface Word {
    text: string;
    x: number;
    y: number;
    speed: number;
    originalSpeed: number;
    color: string; 
    currentIndex: number;
}

class Game {
    private canvas: HTMLCanvasElement;
    private context: CanvasRenderingContext2D;
    private words: Word[];
    private wordList: string[];
    private score: number;
    private WPM: number;
    private language: string;
    private originalWPM: number;
    private playerName: string;  
	private pause: boolean;
	private isGameOver = false;
	private token: string | null;
	private timeElapsed: number; 
	private keystrokes: number;
	private startTime: number;
    private allWords: string[];
    private readonly batchSize = 10;
    private wordIndex = 0;
	private averageCharLength: number;
	private lastTimestamp: number;

	private constructor(canvas: HTMLCanvasElement, playerName: string, WPM: number = 60, language: string = 'english') {
		this.canvas = canvas;
		this.context = this.canvas.getContext("2d")!;
		this.WPM = localStorage.getItem('WPM') ? parseInt(localStorage.getItem('WPM')!) : WPM;
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
	}
	
	static async create(canvas: HTMLCanvasElement, playerName: string, WPM: number = 60, language: string = 'english') {
		const game = new Game(canvas, playerName, WPM, language);
		await game.fetchToken();
		await game.fetchWords();
		return game;
	}

	async fetchToken() {
	  const response = await fetch('/token');
	  const data = await response.json();
	  this.token = data.token;
	}


async fetchWords() {
    const response = await fetch(`/words/${this.language}.json`);
    const data = await response.json();
    this.allWords = this.shuffleArray(data.words);
    this.averageCharLength = data.charLength;
    this.nextBatch();
}


nextBatch() {
    if (this.wordIndex + this.batchSize > this.allWords.length) {
        this.wordIndex = 0; // Loop back to start
    }
    this.wordList = this.allWords.slice(this.wordIndex, this.wordIndex + this.batchSize);
    this.wordIndex += this.batchSize;
}


setLanguage(newLanguage: string) {
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

	setWPM(newWPM: number) {
		if (newWPM !== this.WPM) { 
			localStorage.setItem('WPM', newWPM.toString());
			this.WPM = newWPM;
			this.originalWPM = newWPM;
			this.restart(this.WPM);
		}
	}


restart(currentWPM: number) {
    this.score = 0;
    this.words = [];
    this.originalWPM = currentWPM;
    this.timeElapsed = 0;
    this.fetchWords().then(() => {
        // Wait for 1 second before generating words and starting the game
        setTimeout(() => {
            this.generateWords();
        }, 500);  // delay of 1 second
    });
}


initialize() {
    this.context.font = "48px 'Courier New', Courier, monospace";
    setTimeout(() => {
        this.generateWords();
        this.animate();
    }, 500);

window.addEventListener('keydown', (event) => {
    this.keystrokes++;
    if (this.words.length === 0) return;

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
    } else { 
        firstWord.speed *= 1.1; 
        firstWord.color = '#FF0000';  
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
        const word: Word = {
            text: wordText,
            x: Math.random() * maxWordX,
            y: offset - index * 80, // Use the offset to position the words of the new batch
            speed: lastWordSpeed, // Use the speed of the last word in the current batch
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
            const speedIncrease = this.timeElapsed / 1000000000; 
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
                } else {
                    this.context.fillStyle = i === word.currentIndex && word.color === '#FF0000' ? '#FF0000' : word.color;  
                    this.context.fillText(char, word.x + offsetX, word.y);
                }
                offsetX += this.context.measureText(char).width; 
            }

            word.y += word.speed * deltaTime;
        });

        const currentScoreElement = document.getElementById('current-score') as HTMLElement;
        currentScoreElement.textContent = `${this.score}`;

        if (this.words.length > 0 && this.words[0].y > this.canvas.height) {
            this.gameOver();
            return;
        }

        // Move this inside the condition
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



    shuffleArray(array: any[]) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }
	
		async gameOver() {
		const endTime = Date.now();
		const timeElapsed = endTime - this.startTime; // in milliseconds
		  if (this.isGameOver) return;  

		  this.isGameOver = true;  
			const response = await fetch('/score', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					token: this.token,
					name: this.playerName,
					score: this.score,
					language: this.language,
					WPM: this.WPM,
					keystrokes: this.keystrokes, // Include keystrokes in sent data
					timeElapsed: timeElapsed
				})
			});


		  if (!response.ok) {
			console.error('Failed to send score to server');
		  }

		  window.location.href = `/game-over.html?score=${this.score}&language=${this.language}&WPM=${this.WPM}`;
		}

	displayLeaderboard(leaderboard: any[]) {

		const leaderboardElement = document.getElementById('leaderboard') as HTMLElement;
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

    setPlayerName(newName: string) {
        if (newName.length >= 3 && newName.length <= 30) {
            localStorage.setItem('playerName', newName); 
            this.playerName = newName;
        } else {
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

const languageInput = document.getElementById('language') as HTMLSelectElement;


languages.forEach((language) => {
    const option = document.createElement('option');
    option.value = language;
    option.text = language;
    languageInput.appendChild(option);
});

const canvas = document.getElementById('game') as HTMLCanvasElement;
const wpmInput = document.getElementById('wpm') as HTMLSelectElement;

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

	const playerNameInput = document.getElementById('player-name') as HTMLInputElement;

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