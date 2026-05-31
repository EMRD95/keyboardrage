const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readPublic(file) {
  return fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
}

function readRoot(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

test('server persists auth in a bounded HttpOnly SameSite cookie and still accepts bearer tokens only for legacy migration', () => {
  const server = readRoot('server.js');
  assert.match(server, /SESSION_COOKIE_NAME\s*=\s*'kr_session'/);
  assert.match(server, /HttpOnly/);
  assert.match(server, /SameSite=Lax/);
  assert.match(server, /serializeSessionCookie\(value, req, maxAgeSeconds = SESSION_COOKIE_MAX_AGE_SECONDS\)/);
  assert.match(server, /Max-Age=\$\{maxAgeSeconds\}/);
  assert.match(server, /req\.headers\.cookie/);
  assert.match(server, /req\.authSource\s*=\s*authSource/);
  assert.match(server, /app\.post\('\/auth\/logout'/);
  assert.match(server, /setSessionCookie\(res, req, token\)/);
  assert.match(server, /clearSessionCookie\(res, req\)/);
});

test('auth client stores only a bounded profile cache in localStorage, not the bearer token', () => {
  const authClient = readPublic('auth-client.js');
  assert.match(authClient, /localStorage\.getItem\(AUTH_STORAGE_KEY\)/);
  assert.match(authClient, /localStorage\.setItem\(AUTH_STORAGE_KEY, payload\)/);
  assert.match(authClient, /sessionStorage\.getItem\(AUTH_STORAGE_KEY\)/);
  assert.match(authClient, /legacyToken/);
  assert.match(authClient, /credentials:\s*'same-origin'/);
  assert.match(authClient, /fetch\('\/auth\/me'/);
  assert.match(authClient, /fetch\('\/auth\/logout'/);
  assert.match(authClient, /_isTokenExpired/);
  assert.doesNotMatch(authClient, /JSON\.stringify\(\{\s*token,/s, 'new persistent cache must not write token first');
  assert.doesNotMatch(authClient, /isLoggedIn\(\) \{\s*return _session !== null && _session\.token !== null;/s);
});

test('pages use cookie-backed auth and do not require a JS-readable token', () => {
  const account = readPublic('account.html');
  const stats = readPublic('stats.js');
  const game = readPublic('game.ts');

  assert.doesNotMatch(account, /Authorization/i);
  assert.match(account, /updateSessionFromAuthResponse\(data\)/);
  assert.doesNotMatch(stats, /Authorization/i);
  assert.match(stats, /credentials:\s*'same-origin'/);

  assert.match(game, /hasStoredAuthSession/);
  assert.match(game, /getLegacyAuthToken/);
  assert.match(game, /credentials:\s*'same-origin'/);
  assert.match(game, /sessionStorage\.getItem\('kr_session'\)/);
  assert.match(game, /localStorage\.setItem\('kr_session', sessionStr\)/);
});

test('game-over page reads persisted public profile data instead of tab-scoped sessionStorage', () => {
  const gameOver = readPublic('game-over.js');
  assert.doesNotMatch(gameOver, /sessionStorage\.getItem\('kr_session'\)/);
  assert.match(gameOver, /localStorage\.getItem\('kr_session'\)/);
});

test('privacy page describes the secure persistent browser session truthfully', () => {
  const privacy = readPublic('privacy.html');
  assert.match(privacy, /HttpOnly/);
  assert.match(privacy, /SameSite/);
  assert.match(privacy, /localStorage/);
  assert.match(privacy, /7 days/);
});
