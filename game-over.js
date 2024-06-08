
const urlParams = new URLSearchParams(window.location.search);
const score = urlParams.get('score');
const language = urlParams.get('language');
const WPM = urlParams.get('WPM');

const scoreElement = document.getElementById('score');
scoreElement.textContent = `Score: ${score}`;

const languageElement = document.getElementById('language');
languageElement.textContent = `Language: ${language}`;

const WPMElement = document.getElementById('WPM');
WPMElement.textContent = `WPM: ${WPM}`;

const mode = localStorage.getItem('mode');
const precision = localStorage.getItem('precision');

const precisionFormatted = parseFloat(precision).toFixed(2);

const modeElement = document.getElementById('mode');
modeElement.textContent = `Mode: ${mode}`;

if ((mode === 'fast' && parseFloat(precision) < 90) && ['30', '50', '100', '101', '150', '200', '250', '300', '350', '400'].includes(WPM)) {
  const precisionWarning = document.createElement('div');
  precisionWarning.classList.add('warning');
  precisionWarning.textContent = 'Scores in fast mode are only valid if precision is above 90%';
  document.body.insertBefore(precisionWarning, document.getElementById('leaderboard'));
}


// get options from local storage
const addNumbersSetting = localStorage.getItem('addNumbers') === 'true';
const applyGrammarSetting = localStorage.getItem('applyGrammar') === 'true';

let optionsText = 'Options: ';
if (addNumbersSetting && applyGrammarSetting) {
    optionsText += "Number + Punctuation";
} else if (addNumbersSetting) {
    optionsText += "Number";
} else if (applyGrammarSetting) {
    optionsText += "Punctuation";
} else {
    optionsText += "None";
}

const optionsElement = document.getElementById('options');
optionsElement.textContent = optionsText;


const precisionElement = document.getElementById('precision');
precisionElement.textContent = `Precision: ${precisionFormatted}%`;

const playerName = localStorage.getItem('playerName');

const playerNameElement = document.getElementById('playerName');
playerNameElement.textContent = `Name: ${playerName}`;

const timeElapsed = localStorage.getItem('timeElapsed');

let timeElapsedInSeconds = Math.round(Number(timeElapsed) / 1000);

let timeElapsedDisplay;
if (timeElapsedInSeconds < 60) {
  timeElapsedDisplay = `${timeElapsedInSeconds} seconds`;
} else {
  let timeElapsedInMinutes = Math.floor(timeElapsedInSeconds / 60);
  let remainingSeconds = timeElapsedInSeconds % 60;
  let minuteWord = timeElapsedInMinutes === 1 ? "minute" : "minutes";
  timeElapsedDisplay = `${timeElapsedInMinutes} ${minuteWord} ${remainingSeconds} seconds`;
}

const timeElapsedElement = document.getElementById('timeElapsed');
timeElapsedElement.textContent = `Time Elapsed: ${timeElapsedDisplay}`;


function updateScoreSubtitle() {
  const scoreSubtitle = document.getElementById('ScoreSubtitle');
  scoreSubtitle.textContent = `For ${WPM} WPM ${language}`;
}

// Call this function every time you update the WPM or language
updateScoreSubtitle();


let currentPage = 1;

document.getElementById('next-page').addEventListener('click', () => {
  currentPage++;
  fetchLeaderboard();
});

document.getElementById('previous-page').addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage--;
    fetchLeaderboard();
  }
});

function fetchLeaderboard() {
  fetch(`/leaderboard/${language}/${WPM}?page=${currentPage}`)
    .then(response => response.json())
    .then(data => {
      if (data.length === 0) {
        currentPage--;
        return;
      }

      // Check if it is a motivational message
      if (data.message) {
        const motivationalMessageElement = document.getElementById('motivationalMessage');
        motivationalMessageElement.textContent = `Pro tip: ${data.message}`;

        // Hide the elements
        document.getElementById('leaderboard').style.display = 'none';
        document.getElementById('pagination').style.display = 'none';
        document.getElementById('ScoreTitle').style.display = 'none';

        return;
      }

      // If not a motivational message
      document.getElementById('leaderboard').style.display = 'table';
      document.getElementById('pagination').style.display = 'block';
      document.getElementById('ScoreTitle').style.display = 'block';
	  document.getElementById('MotivationMessage').style.display = 'none';

      const leaderboardElement = document.getElementById('leaderboard');
      leaderboardElement.innerHTML = '';

      const headerRow = document.createElement('tr');
      const rankHeader = document.createElement('th');
      rankHeader.textContent = 'Rank';
      headerRow.appendChild(rankHeader);
      const nameHeader = document.createElement('th');
      nameHeader.textContent = 'Name';
      headerRow.appendChild(nameHeader);
      const scoreHeader = document.createElement('th');
      scoreHeader.textContent = 'Score';
      headerRow.appendChild(scoreHeader);
      const modeHeader = document.createElement('th');
      modeHeader.textContent = 'Mode';
      headerRow.appendChild(modeHeader);
      const precisionHeader = document.createElement('th');
      precisionHeader.textContent = 'Precision';
      headerRow.appendChild(precisionHeader);
      const dateHeader = document.createElement('th');
      dateHeader.textContent = 'Date';
      headerRow.appendChild(dateHeader);
      leaderboardElement.appendChild(headerRow);

      // Add each score to the leaderboard
      data.forEach((score, index) => {
        const row = document.createElement('tr');

        const rankCell = document.createElement('td');
        rankCell.textContent = ((currentPage - 1) * 10) + index + 1;
        row.appendChild(rankCell);

        const playerNameCell = document.createElement('td');
        playerNameCell.textContent = score.name;
        row.appendChild(playerNameCell);

        const scoreCell = document.createElement('td');
        scoreCell.textContent = score.score;
        row.appendChild(scoreCell);

        const modeCell = document.createElement('td'); 
        modeCell.textContent = score.mode; 
        row.appendChild(modeCell); 

        const precisionCell = document.createElement('td'); 
        precisionCell.textContent = parseFloat(score.precision).toFixed(2);
        row.appendChild(precisionCell); 

        const dateCell = document.createElement('td');
        const date = new Date(score.timestamp);
        dateCell.textContent = date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
        row.appendChild(dateCell);

        leaderboardElement.appendChild(row);
      });
    })
    .catch(error => {
      console.error('Failed to fetch leaderboard:', error);
    });
}

fetchLeaderboard();

let currentPageLatestScores = 1;

function fetchLatestScores() {
  fetch(`/latest-scores?page=${currentPageLatestScores}`)
    .then(response => response.json())
    .then(data => {
      if (data.length === 0 && currentPageLatestScores > 1) {
        currentPageLatestScores--;
        return;
      }

      const latestScoresElement = document.getElementById('latest-scores');
      latestScoresElement.innerHTML = '';

      // Create header row
      const headerRow = document.createElement('tr');
      ['Name', 'Score', 'Mode', 'Precision', 'Date', 'WPM', 'Language'].forEach(text => {
        const th = document.createElement('th');
        th.textContent = text;
        headerRow.appendChild(th);
      });
      latestScoresElement.appendChild(headerRow);

      // Add each score to the latest scores
      data.forEach((score, index) => {
        const row = document.createElement('tr');

        const playerNameCell = document.createElement('td');
        playerNameCell.textContent = score.name;
        row.appendChild(playerNameCell);

        const scoreCell = document.createElement('td');
        scoreCell.textContent = score.score;
        row.appendChild(scoreCell);

        const modeCell = document.createElement('td');
        modeCell.textContent = score.mode;
        row.appendChild(modeCell);

        const precisionCell = document.createElement('td');
        precisionCell.textContent = parseFloat(score.precision).toFixed(2);
        row.appendChild(precisionCell);

        const dateCell = document.createElement('td');
        const date = new Date(score.timestamp);
        dateCell.textContent = date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
        row.appendChild(dateCell);

        const wpmCell = document.createElement('td');
        wpmCell.textContent = score.WPM;
        row.appendChild(wpmCell);

        const languageCell = document.createElement('td');
        languageCell.textContent = score.language;
        row.appendChild(languageCell);

        latestScoresElement.appendChild(row);
      });
    })
    .catch(error => {
      console.error('Failed to fetch latest scores:', error);
    });
}

fetchLatestScores();

// Add event listeners to pagination buttons
document.getElementById('previous-page-latest-scores').addEventListener('click', () => {
  if (currentPageLatestScores > 1) {
    currentPageLatestScores--;
    fetchLatestScores();
  }
});

document.getElementById('next-page-latest-scores').addEventListener('click', () => {
  currentPageLatestScores++;
  fetchLatestScores();
});

document.getElementById('play-again').addEventListener('click', () => {
  window.location.href = '/index.html';
});

document.body.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    window.location.href = '/index.html';
  }
});
