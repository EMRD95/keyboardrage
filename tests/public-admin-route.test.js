const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('public KeyboardRage app does not mount private score review admin routes', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.equal(serverSource.includes("'/internal/score-review'"), false);
  assert.equal(serverSource.includes("'/internal/api/score-attempts'"), false);
  assert.equal(serverSource.includes("require('./scoreReviewUi')"), false);
  assert.equal(serverSource.includes('PRIVATE_ADMIN_DIR'), false);
});
