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

    // Fetch the leaderboard data from the server
    fetch(`/leaderboard/${language}/${WPM}`)
      .then(response => response.json())
      .then(data => {
        const leaderboardElement = document.getElementById('leaderboard');
        leaderboardElement.innerHTML = '';

        // Add each score to the leaderboard
        data.forEach(score => {
          const row = document.createElement('tr');
          const playerNameCell = document.createElement('td');
          playerNameCell.textContent = score.name;
          row.appendChild(playerNameCell);

          const scoreCell = document.createElement('td');
          scoreCell.textContent = score.score;
          row.appendChild(scoreCell);

          leaderboardElement.appendChild(row);
        });
      })
      .catch(error => {
        console.error('Failed to fetch leaderboard:', error);
      });
	  
	    document.getElementById('play-again').addEventListener('click', () => {
    window.location.href = '/index.html'; // this should point back to your game's page
  });