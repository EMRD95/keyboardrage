const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createFinishTokenPair,
  verifyFinishToken,
  rejectOperatorKeys,
  recomputeScoreFromTelemetry,
  decidePublicationStatus,
  isLocalAdminRequest,
} = require('../game-session-security');

test('finish tokens are one-time verifiable hashes, not stored in plaintext', () => {
  const pair = createFinishTokenPair(() => Buffer.from('a'.repeat(64), 'hex'));
  assert.equal(pair.token.length, 64);
  assert.notEqual(pair.tokenHash, pair.token);
  assert.equal(verifyFinishToken(pair.token, pair.tokenHash), true);
  assert.equal(verifyFinishToken(pair.token.slice(0, -1) + '0', pair.tokenHash), false);
});

test('rejectOperatorKeys blocks Mongo operator injection keys recursively', () => {
  assert.equal(rejectOperatorKeys({ lang: 'english', nested: { ok: 1 } }).valid, true);
  const result = rejectOperatorKeys({ lang: { $ne: 'english' } });
  assert.equal(result.valid, false);
  assert.match(result.reason, /operator key/);
  assert.equal(rejectOperatorKeys({ 'profile.name': 'x' }).valid, false);
});

test('recomputeScoreFromTelemetry ignores client score and validates completed words against the server corpus', () => {
  const startedAt = 1_000_000;
  const telemetry = {
    gameStartedAt: startedAt,
    gameEndedAt: startedAt + 6_000,
    keyEvents: [0, 100, 220, 400, 700, 980, 1300].map((offset, index) => ({
      t: startedAt + offset,
      key: 'a',
      code: 'KeyA',
      correct: index !== 3,
      isTrusted: true,
      repeat: false,
    })),
    completedWords: [
      { word: 'cat', sourceIndex: 0, startedAt, completedAt: startedAt + 600, keystrokes: 3, typos: 0 },
      { word: 'dog', sourceIndex: 1, startedAt: startedAt + 1000, completedAt: startedAt + 2200, keystrokes: 4, typos: 1 },
    ],
  };

  const result = recomputeScoreFromTelemetry({
    telemetry,
    mode: 'fast',
    wordsBySourceIndex: ['cat', 'dog'],
    serverStartedAt: new Date(startedAt - 100),
    serverFinishedAt: new Date(startedAt + 6100),
    clientScore: 9999,
  });

  assert.equal(result.valid, true);
  assert.equal(result.score, 1, 'fast mode excludes completed words with typos');
  assert.equal(result.keystrokes, 7);
  assert.equal(result.typos, 1);
  assert.equal(result.timeElapsed, 6000);
  assert.ok(result.precision > 85 && result.precision < 86);

  const tampered = recomputeScoreFromTelemetry({
    telemetry: { ...telemetry, completedWords: [{ word: 'hacked', sourceIndex: 0, startedAt, completedAt: startedAt + 500, keystrokes: 6, typos: 0 }] },
    mode: 'rage',
    wordsBySourceIndex: ['cat', 'dog'],
    serverStartedAt: new Date(startedAt),
    serverFinishedAt: new Date(startedAt + 1000),
  });
  assert.equal(tampered.valid, false);
  assert.match(tampered.reason, /word mismatch/);
});

test('publication decision gates risky or inexperienced high scores for manual review', () => {
  assert.equal(decidePublicationStatus({ riskScore: 5, accountAgeMs: 10 * 86400_000, validFinishedGames: 20, score: 12 }).status, 'published');
  assert.equal(decidePublicationStatus({ riskScore: 90, accountAgeMs: 10 * 86400_000, validFinishedGames: 20, score: 12 }).status, 'pending_review');
  assert.equal(decidePublicationStatus({ riskScore: 5, accountAgeMs: 10_000, validFinishedGames: 0, score: 80 }).status, 'pending_review');
});

test('local admin routes require a direct loopback request, not a proxied public request', () => {
  assert.equal(isLocalAdminRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), true);
  assert.equal(isLocalAdminRequest({ socket: { remoteAddress: '::1' }, headers: {} }), true);
  assert.equal(isLocalAdminRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.9' } }), false);
  assert.equal(isLocalAdminRequest({ socket: { remoteAddress: '192.168.10.12' }, headers: {} }), false);
});
