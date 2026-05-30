const crypto = require('crypto');

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

function computeLevelProgress(uniqueWordsTyped, totalWords, levels = 100) {
  const total = Math.max(1, Math.floor(Number(totalWords) || 1));
  const unique = Math.max(0, Math.min(total, Math.floor(Number(uniqueWordsTyped) || 0)));
  const levelCount = Math.max(2, Math.floor(Number(levels) || 100));
  const curveExponent = 2.2;
  const percentOfCorpus = Number(((unique / total) * 100).toFixed(4));

  if (unique >= total) {
    return {
      level: levelCount,
      uniqueWordsTyped: unique,
      totalWords: total,
      progressToNextLevel: 100,
      wordsForCurrentLevel: total,
      wordsForNextLevel: total,
      wordsRemainingForNextLevel: 0,
      percentOfCorpus,
    };
  }

  const denominator = levelCount - 1;
  const level = Math.max(
    1,
    Math.min(levelCount - 1, Math.floor(Math.pow(unique / total, 1 / curveExponent) * denominator) + 1),
  );
  const threshold = (levelNumber) => Math.ceil(Math.pow((levelNumber - 1) / denominator, curveExponent) * total);
  const wordsForCurrentLevel = level === 1 ? 0 : threshold(level);
  const wordsForNextLevel = threshold(level + 1);
  const span = Math.max(1, wordsForNextLevel - wordsForCurrentLevel);
  const progressToNextLevel = Number((((unique - wordsForCurrentLevel) / span) * 100).toFixed(2));

  return {
    level,
    uniqueWordsTyped: unique,
    totalWords: total,
    progressToNextLevel: clampNumber(progressToNextLevel, 0, 100),
    wordsForCurrentLevel,
    wordsForNextLevel,
    wordsRemainingForNextLevel: Math.max(0, wordsForNextLevel - unique),
    percentOfCorpus,
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarizeNumbers(values) {
  const clean = values.filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (clean.length === 0) {
    return { count: 0, minMs: 0, maxMs: 0, averageMs: 0, medianMs: 0, p95Ms: 0, stdDevMs: 0, coefficientOfVariation: 0 };
  }
  const sum = clean.reduce((acc, v) => acc + v, 0);
  const average = sum / clean.length;
  const variance = clean.reduce((acc, v) => acc + ((v - average) ** 2), 0) / clean.length;
  const stdDev = Math.sqrt(variance);
  return {
    count: clean.length,
    minMs: Math.round(clean[0]),
    maxMs: Math.round(clean[clean.length - 1]),
    averageMs: Math.round(average),
    medianMs: Math.round(percentile(clean, 50)),
    p95Ms: Math.round(percentile(clean, 95)),
    stdDevMs: Math.round(stdDev),
    coefficientOfVariation: Number((average > 0 ? stdDev / average : 0).toFixed(4)),
  };
}

function summarizeTypingTelemetry(telemetry = {}) {
  const keyEvents = Array.isArray(telemetry.keyEvents) ? telemetry.keyEvents : [];
  const completedWords = Array.isArray(telemetry.completedWords) ? telemetry.completedWords : [];
  const focusEvents = Array.isArray(telemetry.focusEvents) ? telemetry.focusEvents : [];
  const startedAt = Number(telemetry.gameStartedAt) || keyEvents[0]?.t || completedWords[0]?.startedAt || 0;
  const endedAt = Number(telemetry.gameEndedAt) || keyEvents[keyEvents.length - 1]?.t || completedWords[completedWords.length - 1]?.completedAt || startedAt;
  const durationMs = Math.max(0, endedAt - startedAt);

  const sortedKeys = keyEvents
    .map(event => ({ ...event, t: Number(event.t) }))
    .filter(event => Number.isFinite(event.t))
    .sort((a, b) => a.t - b.t);
  const keyIntervals = [];
  for (let i = 1; i < sortedKeys.length; i++) {
    const delta = sortedKeys[i].t - sortedKeys[i - 1].t;
    if (delta >= 0 && delta <= 10000) keyIntervals.push(delta);
  }

  const wordDurations = completedWords
    .map(word => Number(word.completedAt) - Number(word.startedAt))
    .filter(duration => Number.isFinite(duration) && duration >= 0 && duration <= 120000);

  const keyStats = summarizeNumbers(keyIntervals);
  const wordStats = summarizeNumbers(wordDurations);
  const correctKeyEvents = sortedKeys.filter(event => event.correct === true).length;
  const incorrectKeyEvents = sortedKeys.filter(event => event.correct === false).length;
  const untrustedKeyEvents = sortedKeys.filter(event => event.isTrusted === false).length;
  const repeatKeyEvents = sortedKeys.filter(event => event.repeat === true).length;
  const focusLosses = focusEvents.filter(event => event && event.type === 'blur').length;

  const correctKeys = sortedKeys.filter(event => event.correct === true);
  const burstWindow = 10;
  let burstWpm = 0;
  for (let i = 0; i + burstWindow - 1 < correctKeys.length; i++) {
    const elapsed = correctKeys[i + burstWindow - 1].t - correctKeys[i].t;
    if (elapsed > 0) {
      burstWpm = Math.max(burstWpm, (burstWindow / 5) / (elapsed / 60000));
    }
  }

  // Consistency: coefficient of variation of per-word raw WPM (Monkeytype-style).
  // Raw WPM per word = (keystrokes / 5) / (durationMs / 60000).
  // Lower CV = steadier speed across words = higher consistency.
  const perWordRawWpm = completedWords
    .map(w => {
      const durationMs = Number(w.completedAt) - Number(w.startedAt);
      if (!Number.isFinite(durationMs) || durationMs <= 0) return NaN;
      return ((Number(w.keystrokes) || 0) / 5) / (durationMs / 60000);
    })
    .filter(v => Number.isFinite(v) && v > 0);

  let consistencyScore = 0;
  if (perWordRawWpm.length >= 3) {
    const mean = perWordRawWpm.reduce((a, b) => a + b, 0) / perWordRawWpm.length;
    const variance = perWordRawWpm.reduce((a, b) => a + (b - mean) ** 2, 0) / perWordRawWpm.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    const MAX_CV = 0.55; // extremely erratic typing maps to ~0%
    consistencyScore = Math.round(clampNumber(100 * (1 - cv / MAX_CV), 0, 100));
  }

  // Robotic uniformity: separate anti-cheat signal based on key-interval regularity (server-side only).
  const intervalCv = keyStats.coefficientOfVariation;
  const roboticUniformityScore = Math.round(clampNumber(100 - (intervalCv * 2500), 0, 100));

  return {
    durationMs,
    totalKeyEvents: sortedKeys.length,
    correctKeyEvents,
    incorrectKeyEvents,
    untrustedKeyEvents,
    repeatKeyEvents,
    focusLosses,
    completedWordCount: completedWords.length,
    keyIntervals: keyStats,
    wordTiming: wordStats,
    burstWpm: Number(burstWpm.toFixed(2)),
    consistencyScore,
    roboticUniformityScore,
  };
}

function wordFingerprint(language, sourceIndex, word) {
  return crypto
    .createHash('sha256')
    .update(`${language}:${String(word || '').trimEnd().toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
}

function compactCompletedWords(language, completedWords = [], maxWords = 1000) {
  const seen = new Set();
  const compact = [];
  for (const word of completedWords) {
    const sourceIndex = Number(word.sourceIndex);
    if (!Number.isInteger(sourceIndex) || sourceIndex < 0) continue;
    const key = `${language}:${sourceIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    compact.push({
      language,
      sourceIndex,
      wordHash: wordFingerprint(language, sourceIndex, word.word),
      completedAt: Number(word.completedAt) || Date.now(),
    });
    if (compact.length >= maxWords) break;
  }
  return compact;
}

function compactRawTelemetry(telemetry = {}, limits = {}) {
  const maxKeys = limits.maxKeys || 2500;
  const maxWords = limits.maxWords || 1000;
  const maxFocus = limits.maxFocus || 100;
  const start = Number(telemetry.gameStartedAt) || 0;
  const delta = value => Math.max(0, Math.round((Number(value) || 0) - start));
  const keyEvents = (Array.isArray(telemetry.keyEvents) ? telemetry.keyEvents : []).slice(-maxKeys).map(event => ({
    t: delta(event.t),
    key: String(event.key || '').slice(0, 12),
    code: String(event.code || '').slice(0, 32),
    correct: event.correct === true,
    trusted: event.isTrusted !== false,
    repeat: event.repeat === true,
    wordIndex: Number.isInteger(event.wordIndex) ? event.wordIndex : undefined,
    charIndex: Number.isInteger(event.charIndex) ? event.charIndex : undefined,
  }));
  const completedWords = (Array.isArray(telemetry.completedWords) ? telemetry.completedWords : []).slice(-maxWords).map(word => ({
    sourceIndex: Number.isInteger(word.sourceIndex) ? word.sourceIndex : undefined,
    length: Number(word.length) || String(word.word || '').trimEnd().length,
    startedAt: delta(word.startedAt),
    completedAt: delta(word.completedAt),
    keystrokes: Number(word.keystrokes) || 0,
    typos: Number(word.typos) || 0,
  }));
  const focusEvents = (Array.isArray(telemetry.focusEvents) ? telemetry.focusEvents : []).slice(-maxFocus).map(event => ({
    t: delta(event.t),
    type: event.type === 'blur' ? 'blur' : 'focus',
  }));

  return { keyEvents, completedWords, focusEvents };
}

module.exports = {
  computeLevelProgress,
  summarizeTypingTelemetry,
  compactCompletedWords,
  compactRawTelemetry,
  wordFingerprint,
};
