window.onload = async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const score = urlParams.get('score');
  const language = urlParams.get('language');
  const WPM = urlParams.get('WPM');

  // Display the final score
  const finalScoreElement = document.getElementById('final-score');
  finalScoreElement.textContent = score;

  // Fetch and display the leaderboard
  const response = await fetch(`/leaderboard/${language}/${WPM}`);
  const leaderboard = await response.json();

  const leaderboardElement = document.getElementById('leaderboard');
  leaderboard.forEach(score => {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    nameCell.textContent = score.name;
    const scoreCell = document.createElement('td');
    scoreCell.textContent = score.score.toString();
    row.appendChild(nameCell);
    row.appendChild(scoreCell);
    leaderboardElement.appendChild(row);
  });

  document.getElementById('play-again').addEventListener('click', () => {
    window.location.href = '/index.html'; // this should point back to your game's page
  });
};
