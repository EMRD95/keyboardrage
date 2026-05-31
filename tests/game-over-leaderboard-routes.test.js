const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('game-over page legacy leaderboard endpoints remain mounted', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSource, /app\.get\(['"]\/leaderboard\/:language\/:WPM['"]/);
  assert.match(serverSource, /app\.get\(['"]\/latest-scores['"]/);
});
