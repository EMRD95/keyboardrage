const assert = require('node:assert/strict');
const test = require('node:test');

const {
  computeLevelProgress,
  summarizeTypingTelemetry,
  compactCompletedWords,
} = require('../typing-stats');

test('computeLevelProgress uses an RPG curve: early levels are quick, level 100 still requires full corpus coverage', () => {
  assert.deepEqual(computeLevelProgress(0, 2_000_000), {
    level: 1,
    uniqueWordsTyped: 0,
    totalWords: 2_000_000,
    progressToNextLevel: 0,
    wordsForCurrentLevel: 0,
    wordsForNextLevel: 82,
    wordsRemainingForNextLevel: 82,
    percentOfCorpus: 0,
  });

  const firstHundred = computeLevelProgress(100, 2_000_000);
  assert.equal(firstHundred.level, 2);
  assert.ok(firstHundred.wordsRemainingForNextLevel < 300);

  const halfway = computeLevelProgress(1_000_000, 2_000_000);
  assert.equal(halfway.level, 73);
  assert.ok(halfway.wordsRemainingForNextLevel > 20_000);

  const maxed = computeLevelProgress(2_000_000, 2_000_000);
  assert.equal(maxed.level, 100);
  assert.equal(maxed.progressToNextLevel, 100);
  assert.equal(maxed.wordsRemainingForNextLevel, 0);
});

test('summarizeTypingTelemetry extracts compact anti-cheat features from key and word timing', () => {
  const start = 1000;
  const correctKeys = [];
  for (let i = 0; i < 12; i++) {
    correctKeys.push({ t: start + i * 130, key: String.fromCharCode(97 + (i % 26)), code: 'Key' + String.fromCharCode(65 + (i % 26)), correct: true, isTrusted: true, repeat: false });
  }
  const summary = summarizeTypingTelemetry({
    gameStartedAt: start,
    gameEndedAt: start + 8000,
    keyEvents: [
      ...correctKeys,
      { t: start + 1600, key: 'x', code: 'KeyX', correct: false, isTrusted: false, repeat: true },
    ],
    completedWords: [
      { word: 'cat', sourceIndex: 42, startedAt: start, completedAt: start + 500, keystrokes: 4, typos: 0 },
      { word: 'dog', sourceIndex: 43, startedAt: start + 1900, completedAt: start + 2500, keystrokes: 4, typos: 1 },
      { word: 'sky', sourceIndex: 44, startedAt: start + 2600, completedAt: start + 3100, keystrokes: 3, typos: 0 },
    ],
    focusEvents: [{ t: start + 1700, type: 'blur' }, { t: start + 1800, type: 'focus' }],
  });

  assert.equal(summary.durationMs, 8000);
  assert.equal(summary.totalKeyEvents, 13);
  assert.equal(summary.untrustedKeyEvents, 1);
  assert.equal(summary.repeatKeyEvents, 1);
  assert.equal(summary.focusLosses, 1);
  assert.equal(summary.correctKeyEvents, 12);
  assert.equal(summary.incorrectKeyEvents, 1);
  assert.equal(summary.completedWordCount, 3);
  assert.equal(summary.wordTiming.averageMs, 533);
  assert.equal(summary.keyIntervals.count, 12);
  assert.equal(summary.keyIntervals.averageMs, 133);
  assert.ok(summary.consistencyScore >= 0 && summary.consistencyScore <= 100);
  assert.ok(summary.consistencyScore > 0, 'consistency should be computable with 3+ words');
  assert.ok(summary.roboticUniformityScore >= 0 && summary.roboticUniformityScore <= 100);
  assert.ok(summary.burstWpm > 0);
});

test('summarizeTypingTelemetry separates consistency (WPM steadiness) from robotic uniformity (key-interval regularity)', () => {
  const now = 1000;
  // Human: 3 words at moderately varying speeds, natural key interval variation
  const human = summarizeTypingTelemetry({
    gameStartedAt: now,
    gameEndedAt: now + 10000,
    keyEvents: [0, 110, 235, 380, 545, 690, 860, 1030].map((offset, i) => ({
      t: now + offset,
      key: 'a', code: 'KeyA', correct: true, isTrusted: true, repeat: false,
      wordIndex: Math.floor(i / 3),
    })),
    completedWords: [
      { word: 'abc', sourceIndex: 1, startedAt: now, completedAt: now + 1500, keystrokes: 3, typos: 0 },
      { word: 'def', sourceIndex: 2, startedAt: now + 3000, completedAt: now + 4000, keystrokes: 3, typos: 0 },
      { word: 'ghi', sourceIndex: 3, startedAt: now + 6000, completedAt: now + 6800, keystrokes: 3, typos: 0 },
    ],
  });
  // Robot: 3 words at exactly identical speed, perfectly regular key intervals
  const robot = summarizeTypingTelemetry({
    gameStartedAt: now,
    gameEndedAt: now + 10000,
    keyEvents: [0, 100, 200, 300, 400, 500, 600, 700, 800].map((offset, i) => ({
      t: now + offset,
      key: 'a', code: 'KeyA', correct: true, isTrusted: true, repeat: false,
      wordIndex: Math.floor(i / 3),
    })),
    completedWords: [
      { word: 'abc', sourceIndex: 1, startedAt: now, completedAt: now + 500, keystrokes: 3, typos: 0 },
      { word: 'def', sourceIndex: 2, startedAt: now + 3000, completedAt: now + 3500, keystrokes: 3, typos: 0 },
      { word: 'ghi', sourceIndex: 3, startedAt: now + 6000, completedAt: now + 6500, keystrokes: 3, typos: 0 },
    ],
  });

  // Consistency: robot has perfectly steady per-word raw WPM → CV=0 → score=100.
  // Human has natural speed variation → lower consistency.
  assert.ok(human.consistencyScore >= 0 && human.consistencyScore <= 100);
  assert.ok(robot.consistencyScore >= 0 && robot.consistencyScore <= 100);
  assert.ok(robot.consistencyScore >= human.consistencyScore,
    'steady robot speed should score at least as high as naturally-varying human');

  // Robotic uniformity: robot has perfectly fixed key intervals → high anti-cheat score.
  // Human has natural interval variation → low anti-cheat score.
  assert.ok(robot.roboticUniformityScore >= 0 && robot.roboticUniformityScore <= 100);
  assert.ok(human.roboticUniformityScore >= 0 && human.roboticUniformityScore <= 100);
  assert.ok(robot.roboticUniformityScore > human.roboticUniformityScore,
    'perfectly regular key intervals should trigger higher robotic uniformity');
});

test('compactCompletedWords deduplicates by language/sourceIndex and strips raw typed text for word progress storage', () => {
  const words = compactCompletedWords('english', [
    { word: 'cat ', sourceIndex: 7, completedAt: 1000 },
    { word: 'cat ', sourceIndex: 7, completedAt: 2000 },
    { word: 'dog ', sourceIndex: 8, completedAt: 3000 },
  ]);

  assert.deepEqual(words, [
    { language: 'english', sourceIndex: 7, wordHash: 'e0c7e8078213858b', completedAt: 1000 },
    { language: 'english', sourceIndex: 8, wordHash: '2d61c440bbdf6e62', completedAt: 3000 },
  ]);
});
