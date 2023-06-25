interface Word {
    text: string;
    originalText: string;
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
	private mode: 'rage' | 'precision' = (localStorage.getItem('mode') as 'rage' | 'precision') || 'rage';
    private settingsButton: HTMLElement;
    private settingsMenu: HTMLElement;
	private typos: number;
	private applyGrammarSetting: boolean = localStorage.getItem('applyGrammar') === 'true';
	private grammarCheckbox: HTMLInputElement;
	private addNumbersSetting: boolean = localStorage.getItem('addNumbers') === 'true';
	private addNumbersCheckbox: HTMLInputElement;
	private theme: string = localStorage.getItem('theme') || 'default';
	private themeSelector: HTMLSelectElement;


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
		this.settingsButton = document.getElementById('settings-button')!;
		this.settingsMenu = document.getElementById('settings-menu')!;
		this.settingsButton.addEventListener('click', this.toggleSettingsMenu.bind(this));
		document.addEventListener('click', this.closeSettingsMenuIfClickedOutside.bind(this));
		this.typos = 0;
		this.grammarCheckbox = document.getElementById('grammar') as HTMLInputElement;
		this.grammarCheckbox.checked = this.applyGrammarSetting;
		this.grammarCheckbox.addEventListener('change', this.toggleApplyGrammar.bind(this));
		this.addNumbersCheckbox = document.getElementById('addNumbers') as HTMLInputElement;
		this.addNumbersCheckbox.checked = this.addNumbersSetting;
		this.addNumbersCheckbox.addEventListener('change', this.toggleAddNumbers.bind(this));
		this.themeSelector = document.getElementById('theme') as HTMLSelectElement;
		this.themeSelector.value = this.theme;
		this.themeSelector.addEventListener('change', this.changeTheme.bind(this));
		this.changeTheme();
	}

	closeSettingsMenuIfClickedOutside(event: MouseEvent) {
		const path = event.composedPath();
		const inputFields = ["player-name", "wpm", "mode", "language"];
		if (this.settingsMenu.style.display !== "none" && !path.includes(this.settingsMenu) && !path.includes(this.settingsButton)) {
			const clickedOnInputField = path.some((element: any) => 
				element.id && inputFields.includes(element.id)
			);
			if(!clickedOnInputField) {
				this.settingsMenu.style.display = "none";
				this.resumeGame(); 
			}
		}
	}
    toggleSettingsMenu() {
        if (this.settingsMenu.style.display === "none") {
            this.settingsMenu.style.display = "block";
            this.pauseGame(); // Pause game when settings are open
        } else {
            this.settingsMenu.style.display = "none";
            this.resumeGame(); // Resume game when settings are closed
        }
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

changeTheme() {
    this.theme = this.themeSelector.value;
    localStorage.setItem('theme', this.theme);
    document.body.setAttribute('data-theme', this.theme); // Apply the new theme
}

	toggleAddNumbers() {
		this.addNumbersSetting = this.addNumbersCheckbox.checked;
		localStorage.setItem('addNumbers', this.addNumbersSetting.toString());
		this.restart(this.WPM); // Restart the game to apply changes
	}


	toggleApplyGrammar() {
		this.applyGrammarSetting = this.grammarCheckbox.checked;
		localStorage.setItem('applyGrammar', this.applyGrammarSetting.toString());
		this.restart(this.WPM); // Restart the game to apply changes
	}

addRandomNumbers(word: string): string {
    if (this.addNumbersSetting) {
        const shouldAddNumber = Math.random() < 0.2; // Adjust this value to control the likelihood of adding a number
        if (shouldAddNumber) {
            const numbersToAdd = Math.floor(Math.random() * 4) + 1; // Decide how many numbers to add
            let numberString = "";
            for(let i=0; i<numbersToAdd; i++) {
                const randomNumber = Math.floor(Math.random() * 10); // Generate a random number between 0 and 9
                numberString += randomNumber.toString(); // Add the number to the word
            }
            
            // Currency symbol addition
            const shouldAddCurrencySymbol = Math.random() < 0.1;
            if (shouldAddCurrencySymbol) {
                if (this.language.startsWith('french')) {
                    numberString += "€"; // add Euro symbol at the end if the language is French
                } else {
                    numberString = "$" + numberString; // add Dollar symbol at the beginning for other languages
                }
            }

            word += numberString + " "; // Add the number to the word and then a space
        }
    }
    // Adding a space at the end of every word
    return word;
}



applyGrammar(word: string): string {
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
                    case 'é': word = 'E' + word.slice(1); break;
                    case 'è': word = 'E' + word.slice(1); break;
                    case 'ê': word = 'E' + word.slice(1); break;
                    case 'ë': word = 'E' + word.slice(1); break;
                    case 'à': word = 'A' + word.slice(1); break;
                    case 'â': word = 'A' + word.slice(1); break;
                    case 'ä': word = 'A' + word.slice(1); break;
                    case 'î': word = 'I' + word.slice(1); break;
                    case 'ï': word = 'I' + word.slice(1); break;
                    case 'ô': word = 'O' + word.slice(1); break;
                    case 'ö': word = 'O' + word.slice(1); break;
                    case 'ù': word = 'U' + word.slice(1); break;
                    case 'û': word = 'U' + word.slice(1); break;
                    case 'ü': word = 'U' + word.slice(1); break;
                    case 'ç': word = 'C' + word.slice(1); break;
                    case 'œ': word = 'OE' + word.slice(1); break;
                    case 'æ': word = 'AE' + word.slice(1); break;
                    default:  word = word.charAt(0).toUpperCase() + word.slice(1);
                }
            } else {
                word = word.charAt(0).toUpperCase() + word.slice(1);
            }
        } else if (shouldAddPunctuation) {
            let punctuation = ['.', '?', '!', ',', ';'];
            if (this.language.startsWith('french')) {
                punctuation = ['.', ' ?', ' !', ';', ' :'];
            } else if (this.language.startsWith('code_bash')) {
                punctuation = [';', ' &&', ' ||', ' >', ' <', ' |', ' >>', ' <<', '*', '$', './', '='];
			} else if (this.language.startsWith('code')) {
				punctuation = ['.', '?', '!', ',', ';', '(', ')', '[', ']', '"', '-', '...', ':', '=', '+', '-', '*', '/', '//', '%', '**', '+=', '-=', '*=', '/=', '//=', '%=', '**='];
			}
            word += punctuation[Math.floor(Math.random() * punctuation.length)];
        } else if (shouldAddEllipsis && !this.language.startsWith('code')) {
            word += '...';
        } else if (shouldAddParentheses) {
            word = '(' + word + ')';
        } else if (shouldAddSquareBrackets) {
            word = '[' + word + ']';
        } else if (shouldAddQuotes) {
            word = '"' + word + '"';
        } else if (shouldAddHyphen) {
            word = '-' + word;
        }
    }

    // Adding a space at the end of every word
    word += " ";
    return word;
}







async fetchWords() {
    const response = await fetch(`/words/${this.language}.json`);
    const data = await response.json();
    this.allWords = this.shuffleArray(data.words)
        .map(this.applyGrammar.bind(this))
        .map(this.addRandomNumbers.bind(this));

    // Start with the original average character length
    this.averageCharLength = data.charLength;

    // Add one to the average character length for each setting that is enabled
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
        this.wordIndex = 0; // Loop back to start
    }
    this.wordList = this.allWords.slice(this.wordIndex, this.wordIndex + this.batchSize);
    this.wordIndex += this.batchSize;
}

setMode(newMode: 'rage' | 'precision') {
	if (newMode !== this.mode) { 
		localStorage.setItem('mode', newMode);
		this.mode = newMode;
		this.restart(this.WPM);
	}
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
        }, 500);  // delay of 0.5 second
    });
}


	initialize() {
		this.context.font = "48px 'Courier New', Courier, monospace";
		setTimeout(() => {
			this.generateWords();
			this.animate();
		}, 500);

		window.addEventListener('keydown', (event) => {
    // Ignore keydown events from the hidden input field
    if (event.target === document.getElementById('hidden-input')) {
        return;
    }

		// If TAB is pressed, toggle pause status
		if (event.key === 'Tab') {
			event.preventDefault();
			if (this.pause) {
				this.resumeGame();
			} else {
				this.pauseGame();
			}
		}
				
		// If the game is paused, ignore the keystroke
		if (this.pause) {
			return;
		}

		if (event.getModifierState("CapsLock")) {
			document.getElementById('capsLockIndicator').style.display = 'block';
		} else {
			document.getElementById('capsLockIndicator').style.display = 'none';
		}

		// Add a check for special keys
		if (["Shift", "Control", "Alt", "AltGraph", "Meta", "Tab", "Backspace", "CapsLock", "Escape", "Dead"].includes(event.key) 
			|| (event.key >= 'F1' && event.key <= 'F12')) {
			return; // ignore special keys
		}


			// Prevent default action for the single quote key
			if (event.key === "'") {
				event.preventDefault();
			}
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
			this.typos++;
			if (this.mode === 'rage') {
				firstWord.speed *= 1.1; 
				firstWord.color = '#FF0000'; 
			} else if (this.mode === 'precision') {
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
const word: Word = {
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
        requestAnimationFrame(this.animate.bind(this));
    }
}




pauseGame() {
    this.pause = true;
	document.getElementById('GamePaused').style.display = 'block';
}

resumeGame() {
    this.pause = false;
    this.lastTimestamp = performance.now();
    this.animate(this.lastTimestamp);
	document.getElementById('GamePaused').style.display = 'none';
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

  // Calculate precision and store it in localStorage
  const precision = ((this.keystrokes - this.typos) / this.keystrokes) * 100;
  localStorage.setItem('precision', precision.toString());

  // Store mode in localStorage
  localStorage.setItem('mode', this.mode);
  
  // Store playerName in localStorage
  localStorage.setItem('playerName', this.playerName);

  // Store timeElapsed in localStorage
  localStorage.setItem('timeElapsed', this.timeElapsed.toString());

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
        keystrokes: this.keystrokes,
        timeElapsed: timeElapsed,
        typos: this.typos,
        mode: this.mode 
            + (this.addNumbersSetting ? "+N" : "") // append "+N" to the mode if addNumbersSetting is true
            + (this.applyGrammarSetting ? "+P" : "") // append "+P" to the mode if applyGrammarSetting is true
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

const languageInput = document.getElementById('language') as HTMLSelectElement;

fetch('/languages')
  .then(response => response.json())
  .then(languages => {
    languages.forEach((language) => {
      const option = document.createElement('option');
      option.value = language;
      option.text = language;
      languageInput.appendChild(option);
    });
  })
  .catch(error => console.error('Error:', error));


const canvas = document.getElementById('game') as HTMLCanvasElement;
const wpmInput = document.getElementById('wpm') as HTMLSelectElement;
const modeInput = document.getElementById('mode') as HTMLSelectElement;

Game.create(canvas, "Player", 30, 'english').then(game => { 
    game.initialize();
    game.animate();

    modeInput.value = localStorage.getItem('mode') || 'rage'; 
    modeInput.addEventListener('change', () => {
        game.setMode(modeInput.value as 'rage' | 'precision');
    });
    
    modeInput.addEventListener('focus', () => {
		game.pauseGame();
	});

	modeInput.addEventListener('blur', () => {
		game.resumeGame();
		game.setMode(modeInput.value as 'rage' | 'precision');
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