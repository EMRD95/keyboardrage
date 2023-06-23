
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



document.getElementById('play-again').addEventListener('click', () => {
  window.location.href = '/index.html';
});

document.body.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    window.location.href = '/index.html';
  }
});
