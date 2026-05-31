const crypto = require('crypto');
const { summarizeTypingTelemetry } = require('./typing-stats');

const PUBLICATION_STATES = Object.freeze({
  PRIVATE: 'private',
  PUBLISHED: 'published',
  PENDING_REVIEW: 'pending_review',
  SHADOW_HIDDEN: 'shadow_hidden',
  REJECTED: 'rejected',
});

const VALID_PUBLICATION_STATES = new Set(Object.values(PUBLICATION_STATES));

function createFinishTokenPair(randomBytes = crypto.randomBytes) {
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: hashFinishToken(token) };
}

function hashFinishToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function verifyFinishToken(token, expectedHash) {
  const hash = hashFinishToken(token);
  const left = Buffer.from(hash, 'hex');
  const right = Buffer.from(String(expectedHash || ''), 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function rejectOperatorKeys(value, path = 'body') {
  if (value == null || typeof value !== 'object') return { valid: true };
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const result = rejectOperatorKeys(value[i], `${path}[${i}]`);
      if (!result.valid) return result;
    }
    return { valid: true };
  }
  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || key.includes('.')) {
      return { valid: false, reason: `operator key rejected at ${path}.${key}` };
    }
    const result = rejectOperatorKeys(value[key], `${path}.${key}`);
    if (!result.valid) return result;
  }
  return { valid: true };
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeWord(value) {
  return String(value || '').trimEnd().toLowerCase();
}

function expectedWordAt(wordsBySourceIndex, sourceIndex) {
  if (Array.isArray(wordsBySourceIndex)) return wordsBySourceIndex[sourceIndex];
  if (wordsBySourceIndex instanceof Map) return wordsBySourceIndex.get(sourceIndex);
  if (wordsBySourceIndex && typeof wordsBySourceIndex === 'object') return wordsBySourceIndex[sourceIndex];
  return undefined;
}

function baseMode(mode) {
  return String(mode || '').split('+')[0];
}

function recomputeScoreFromTelemetry({
  telemetry = {},
  mode = 'rage',
  wordsBySourceIndex = [],
  serverStartedAt = null,
  serverFinishedAt = null,
  clientScore = null,
} = {}) {
  const operatorCheck = rejectOperatorKeys(telemetry, 'telemetry');
  if (!operatorCheck.valid) return { valid: false, reason: operatorCheck.reason };

  const completedWords = Array.isArray(telemetry.completedWords) ? telemetry.completedWords : [];
  const keyEvents = Array.isArray(telemetry.keyEvents) ? telemetry.keyEvents : [];
  if (completedWords.length === 0) return { valid: false, reason: 'no completed words' };
  if (completedWords.length > 1200 || keyEvents.length > 2500) return { valid: false, reason: 'telemetry limit exceeded' };

  for (const word of completedWords) {
    const sourceIndex = Number(word.sourceIndex);
    if (!Number.isInteger(sourceIndex) || sourceIndex < 0) {
      return { valid: false, reason: 'invalid source index' };
    }
    const expected = expectedWordAt(wordsBySourceIndex, sourceIndex);
    if (typeof expected !== 'string') {
      return { valid: false, reason: `unknown source index ${sourceIndex}` };
    }
    if (normalizeWord(expected) !== normalizeWord(word.word)) {
      return { valid: false, reason: `word mismatch at source index ${sourceIndex}` };
    }
    const startedAt = finiteNumber(word.startedAt, NaN);
    const completedAt = finiteNumber(word.completedAt, NaN);
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
      return { valid: false, reason: 'invalid word timing' };
    }
  }

  const sortedKeys = keyEvents
    .map(event => ({ ...event, t: finiteNumber(event.t, NaN) }))
    .filter(event => Number.isFinite(event.t))
    .sort((a, b) => a.t - b.t);
  if (sortedKeys.length === 0) return { valid: false, reason: 'no key events' };

  const started = finiteNumber(telemetry.gameStartedAt, sortedKeys[0].t);
  const ended = finiteNumber(telemetry.gameEndedAt, sortedKeys[sortedKeys.length - 1].t);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended <= started) {
    return { valid: false, reason: 'invalid game timing' };
  }

  const modeBase = baseMode(mode);
  const score = completedWords.reduce((count, word) => {
    if (modeBase === 'fast' && finiteNumber(word.typos, 0) > 0) return count;
    return count + 1;
  }, 0);
  const keystrokes = sortedKeys.length;
  const typos = sortedKeys.filter(event => event.correct === false).length;
  const precision = keystrokes > 0 ? ((keystrokes - typos) / keystrokes) * 100 : 0;
  const timeElapsed = Math.max(0, Math.round(ended - started));
  const telemetrySummary = summarizeTypingTelemetry(telemetry);

  const serverElapsed = serverStartedAt && serverFinishedAt
    ? Math.max(0, new Date(serverFinishedAt).getTime() - new Date(serverStartedAt).getTime())
    : 0;
  const elapsedSkewMs = serverElapsed > 0 ? Math.abs(serverElapsed - timeElapsed) : 0;
  const clientScoreDelta = Number.isFinite(Number(clientScore)) ? Math.abs(Number(clientScore) - score) : 0;

  const duplicateSources = completedWords.length - new Set(completedWords.map(word => Number(word.sourceIndex))).size;
  const riskSignals = {
    untrustedKeyEvents: telemetrySummary.untrustedKeyEvents || 0,
    repeatKeyEvents: telemetrySummary.repeatKeyEvents || 0,
    focusLosses: telemetrySummary.focusLosses || 0,
    roboticUniformityScore: telemetrySummary.roboticUniformityScore || 0,
    burstWpm: telemetrySummary.burstWpm || 0,
    elapsedSkewMs,
    clientScoreDelta,
    duplicateSources,
  };

  return {
    valid: true,
    score,
    keystrokes,
    typos,
    precision: Number(precision.toFixed(6)),
    timeElapsed,
    telemetrySummary,
    riskSignals,
  };
}

function clampRisk(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function decidePublicationStatus({ riskScore = 0, accountAgeMs = 0, validFinishedGames = 0, totalPlayTimeMs = 0, score = 0 } = {}) {
  const risk = clampRisk(riskScore);
  const reasons = [];
  if (risk >= 75) reasons.push('high-risk telemetry');
  if (risk >= 45) reasons.push('moderate-risk telemetry');
  const newAccount = accountAgeMs < 24 * 60 * 60 * 1000 || validFinishedGames < 3 || totalPlayTimeMs < 5 * 60 * 1000;
  if (newAccount && Number(score) >= 50) reasons.push('new-account high score');
  const status = reasons.length > 0 ? PUBLICATION_STATES.PENDING_REVIEW : PUBLICATION_STATES.PUBLISHED;
  return { status, reasons: Array.from(new Set(reasons)), riskScore: risk };
}

function isLoopbackAddress(address) {
  const value = String(address || '').replace(/^::ffff:/, '');
  return value === '127.0.0.1' || value === '::1' || value === '::' || value === 'localhost';
}

function isLocalAdminRequest(req) {
  const headers = req?.headers || {};
  const forwarded = headers['x-forwarded-for'] || headers['x-real-ip'] || headers['cf-connecting-ip'] || headers.forwarded;
  if (forwarded) return false;
  return isLoopbackAddress(req?.socket?.remoteAddress || req?.connection?.remoteAddress || '');
}

module.exports = {
  PUBLICATION_STATES,
  VALID_PUBLICATION_STATES,
  createFinishTokenPair,
  hashFinishToken,
  verifyFinishToken,
  rejectOperatorKeys,
  recomputeScoreFromTelemetry,
  decidePublicationStatus,
  isLocalAdminRequest,
};
