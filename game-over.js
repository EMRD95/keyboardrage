// Retrieve the score, language, and WPM from the URL
const urlParams = new URLSearchParams(window.location.search);
const score = urlParams.get('score');
const language = urlParams.get('language');
const WPM = urlParams.get('WPM');

// Display the score, language, and WPM on the page
const scoreElement = document.getElementById('score');
scoreElement.textContent = `Score: ${score}`;

const languageElement = document.getElementById('language');
languageElement.textContent = `Language: ${language}`;

const WPMElement = document.getElementById('WPM');
WPMElement.textContent = `WPM: ${WPM}`;

// Retrieve the mode and precision from localStorage
const mode = localStorage.getItem('mode');
const precision = localStorage.getItem('precision');

// Convert precision to a number and format it with two decimals
const precisionFormatted = parseFloat(precision).toFixed(2);

// Display the mode and precision on the page
const modeElement = document.getElementById('mode');
modeElement.textContent = `Mode: ${mode}`;

const precisionElement = document.getElementById('precision');
precisionElement.textContent = `Precision: ${precisionFormatted}%`;

// Retrieve the playerName from localStorage
const playerName = localStorage.getItem('playerName');

// Display the playerName on the page
const playerNameElement = document.getElementById('playerName');
playerNameElement.textContent = `Name: ${playerName}`;

// Retrieve the timeElapsed from localStorage
const timeElapsed = localStorage.getItem('timeElapsed');

// Convert timeElapsed from milliseconds to seconds
let timeElapsedInSeconds = Math.round(Number(timeElapsed) / 1000);

let timeElapsedDisplay;
if (timeElapsedInSeconds < 60) {
  // If less than 60 seconds, display in seconds
  timeElapsedDisplay = `${timeElapsedInSeconds} seconds`;
} else {
  // If 60 seconds or more, convert to minutes and display
  let timeElapsedInMinutes = Math.floor(timeElapsedInSeconds / 60);
  let remainingSeconds = timeElapsedInSeconds % 60;
  let minuteWord = timeElapsedInMinutes === 1 ? "minute" : "minutes"; // Choose the correct word based on the number of minutes
  timeElapsedDisplay = `${timeElapsedInMinutes} ${minuteWord} ${remainingSeconds} seconds`;
}

// Display the timeElapsed on the page
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
      // If there's no more data, go back to the previous page and stop the execution of the function
      if (data.length === 0) {
        currentPage--;
        return;
      }

      const leaderboardElement = document.getElementById('leaderboard');
      leaderboardElement.innerHTML = '';

      // Add header row
      const headerRow = document.createElement('tr');
      const rankHeader = document.createElement('th'); // Add this line
      rankHeader.textContent = 'Rank'; // Add this line
      headerRow.appendChild(rankHeader); // Add this line
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

        const rankCell = document.createElement('td'); // Add this line
        rankCell.textContent = ((currentPage - 1) * 10) + index + 1; // Add this line
        row.appendChild(rankCell); // Add this line

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
        precisionCell.textContent = parseFloat(score.precision).toFixed(2); // Format precision to two decimal places
        row.appendChild(precisionCell); 

        const dateCell = document.createElement('td');
        const date = new Date(score.timestamp);
        dateCell.textContent = date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }); // mo/da/ye
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
  window.location.href = '/index.html'; // this should point back to your game's page
});

document.body.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    window.location.href = '/index.html'; // this should point back to your game's page
  }
});
