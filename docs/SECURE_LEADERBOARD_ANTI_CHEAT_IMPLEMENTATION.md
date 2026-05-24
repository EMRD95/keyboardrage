# Secure Leaderboard, Score Validation, WAF, Anti-Bot, and Account System Implementation Plan

> **For Hermes:** Use `subagent-driven-development` skill to implement this plan task-by-task. Do not implement this as one large patch.

**Goal:** Replace the current client-authoritative score submission flow with a secure, account-gated, backend-authoritative leaderboard pipeline that blocks direct score injection, makes botting materially harder, and flags or hides suspicious scores without giving attackers useful feedback.

**Architecture:** KeyboardRage remains playable anonymously, but public leaderboard publication requires a Google account and a trusted game session. The backend owns game sessions, word-stream commitments, scoring, validation, risk scoring, WAF/rate-limit decisions, account trust, bans, and leaderboard publication status. The frontend becomes an input/event collector and renderer, not a source of truth for score.

**Tech Stack:** Express, Node.js, MongoDB/Mongoose, Google OpenID Connect, Helmet, express-rate-limit, optional Redis for distributed rate limits, express-mongo-sanitize, zod or Joi for schemas, deterministic PRNG, server-side anti-cheat risk engine.

---

## Implementation Order Decision

Google authentication should be the first real implementation milestone.

Reason: auth is the identity foundation that every later security layer attaches to:

- game sessions can be bound to `userId`
- score attempts can be tied to account age, playtime, and reputation
- bans and shadow-bans become enforceable
- future integrations have a stable user identity
- anti-cheat can build per-account baselines before strict enforcement
- leaderboard migration avoids retrofitting identity after score/session models exist

This does **not** mean login should be required to play. Anonymous play should stay available. Google login is required only for public leaderboard publication.

Implementation sequence:

1. Google auth foundation and `User` model
2. WAF and request hardening
3. Game session model and `/game/start`
4. Backend-authoritative score finish/replay
5. Leaderboard eligibility and publication states
6. Anti-bot telemetry and risk scoring
7. Admin review, ban, shadow-ban, and tuning tools

---

## 0. Current Security Problem

Current code path:

- `game.ts` increments score client-side with `this.score++`.
- `game.ts` submits `score: this.score` to `POST /score`.
- `server.js` accepts `scoreData.score` from `req.body`.
- `server.js` tries to load `scoreValidator`, but if missing, falls back to `validateScore = () => true`.
- A user can fetch `/token`, then post a fabricated score up to the hard-coded max.

Current protection level:

- Prevents some malformed inserts.
- Does not prevent direct API score injection.
- Does not prevent client-side score tampering.
- Does not meaningfully prevent typing bots.
- Does not make leaderboard abuse costly because no account reputation exists.

The secure target is:

- The client never submits a trusted score.
- The backend computes score from a server-created game session and submitted input telemetry.
- Every public leaderboard score belongs to an authenticated user account.
- Scores can be accepted privately but hidden publicly when risk is high.
- Cheaters receive little or no useful feedback about anti-cheat thresholds.

---

## 1. Threat Model

### 1.1 Direct API Injection

Attacker bypasses the UI and calls backend endpoints directly:

- creates tokens
- posts arbitrary scores
- replays old score submissions
- changes WPM/language/mode
- submits impossible keystroke/typo/precision combinations
- tries NoSQL injection in JSON bodies

Required defense:

- authenticated game sessions
- one-time finish tokens
- strict schema validation
- server-side score recomputation
- replay protection
- WAF/rate limits
- request body size limits
- NoSQL/operator injection protection
- audit logging

### 1.2 Client Tampering

Attacker modifies local JS or browser memory:

- changes `this.score`
- changes word arrays
- changes mode/WPM/language before submission
- calls internal functions from console
- overwrites timing values

Required defense:

- backend session stores immutable game settings
- backend reconstructs expected word stream
- finish endpoint ignores submitted score/settings except session id/token
- telemetry is replayed and validated against server state

### 1.3 Typing Bot / Browser Automation

Attacker actually plays the game with automation:

- reads words from canvas, JS memory, network, or known word lists
- sends keyboard events through Playwright/Puppeteer/CDP/OS input
- tunes timing to pass basic checks

Required defense:

- make words less trivially extractable
- collect behavioral telemetry
- calculate human-likeness risk
- delay or shadow-hide suspicious leaderboard publication
- account gating and reputation
- bans/shadow-bans
- avoid giving precise rejection reasons

Important limitation:

No browser game can cryptographically prove that input came from a human when the attacker controls the client machine. The realistic goal is to make cheating expensive, slow, detectable, and unrewarding.

---

## 2. High-Level Secure Flow

### 2.1 Anonymous Play

Anonymous users can play normally.

They can:

- play all modes
- see local score screen
- optionally store local scores in browser storage

They cannot:

- publish public leaderboard scores
- claim persistent leaderboard identity
- appear in global rankings

### 2.2 Authenticated Leaderboard Play

Authenticated flow:

1. User signs in with Google.
2. Backend creates or updates local `User` record.
3. Client calls `POST /game/start` with requested settings.
4. Backend validates settings and creates `GameSession`.
5. Backend returns session id, finish token, seed or word chunks, and expiry.
6. Frontend plays the game using the server-bound session settings.
7. Frontend records key telemetry and word-completion telemetry.
8. Client calls `POST /game/finish`.
9. Backend verifies session/token/account.
10. Backend reconstructs/replays the game.
11. Backend computes score, precision, typos, keystrokes, elapsed time.
12. Backend computes bot risk.
13. Backend stores `ScoreAttempt`.
14. Backend decides publication state:
    - `published`
    - `pending_review`
    - `shadow_hidden`
    - `rejected`
15. Public leaderboard reads only `published` scores.

---

## 3. Data Model

Create a `models/` directory if the project does not already have one.

Recommended files:

- `models/User.js`
- `models/GameSession.js`
- `models/ScoreAttempt.js`
- `models/AccountEvent.js`
- `models/IpReputation.js` optional

### 3.1 User Model

File: `models/User.js`

```js
const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  googleSub: {
    type: String,
    required: true,
    unique: true,
    index: true,
    immutable: true
  },

  // Store email only if needed. Prefer normalized hash for abuse correlation.
  email: {
    type: String,
    required: false,
    select: false
  },
  emailHash: {
    type: String,
    required: false,
    index: true
  },

  displayName: {
    type: String,
    required: true,
    maxlength: 40
  },
  avatarUrl: {
    type: String,
    required: false,
    maxlength: 500
  },

  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true,
    index: true
  },
  lastLoginAt: {
    type: Date,
    default: Date.now
  },

  totalPlayTimeMs: {
    type: Number,
    default: 0,
    min: 0
  },
  totalFinishedGames: {
    type: Number,
    default: 0,
    min: 0
  },
  validFinishedGames: {
    type: Number,
    default: 0,
    min: 0
  },

  trustLevel: {
    type: String,
    enum: ['new', 'eligible', 'trusted', 'shadow_banned', 'banned'],
    default: 'new',
    index: true
  },

  leaderboardEligibleAt: {
    type: Date,
    required: false,
    index: true
  },

  riskSummary: {
    sessions: { type: Number, default: 0 },
    highRiskSessions: { type: Number, default: 0 },
    lastRiskScore: { type: Number, default: 0 },
    rollingRiskScore: { type: Number, default: 0 },
    lastHighRiskAt: { type: Date, required: false }
  },

  bannedUntil: {
    type: Date,
    required: false,
    index: true
  },
  banReason: {
    type: String,
    required: false,
    maxlength: 500,
    select: false
  },
  shadowBanned: {
    type: Boolean,
    default: false,
    index: true
  }
}, { timestamps: true });

UserSchema.index({ trustLevel: 1, leaderboardEligibleAt: 1 });

module.exports = mongoose.model('User', UserSchema);
```

Notes:

- Use Google `sub` as the stable unique identifier.
- Do not use email as primary identity.
- Keep email optional. If stored, protect it and avoid returning it publicly.
- `shadowBanned` allows cheaters to keep seeing their own saved scores while everyone else does not.

### 3.2 GameSession Model

File: `models/GameSession.js`

```js
const mongoose = require('mongoose');

const GameSessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    index: true
  },

  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  finishTokenHash: {
    type: String,
    required: true,
    select: false
  },

  status: {
    type: String,
    enum: ['active', 'finished', 'expired', 'rejected'],
    default: 'active',
    index: true
  },

  language: { type: String, required: true, index: true },
  WPM: { type: Number, required: true, index: true },
  mode: { type: String, required: true, index: true },
  frequencyLimit: { type: Number, required: false },
  addNumbers: { type: Boolean, default: false },
  applyGrammar: { type: Boolean, default: false },

  seed: {
    type: String,
    required: true,
    select: false
  },
  wordStreamCommitment: {
    type: String,
    required: true,
    select: false
  },

  startedAt: {
    type: Date,
    default: Date.now,
    immutable: true,
    index: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  finishedAt: {
    type: Date,
    required: false
  },

  ipHash: { type: String, required: false, index: true },
  userAgentHash: { type: String, required: false, index: true },

  startRequestMeta: {
    viewport: { type: String, required: false },
    userAgent: { type: String, required: false },
    acceptLanguage: { type: String, required: false }
  }
}, { timestamps: true });

GameSessionSchema.index({ userId: 1, status: 1, startedAt: -1 });
GameSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model('GameSession', GameSessionSchema);
```

Notes:

- TTL index removes stale sessions eventually.
- `expiresAt` should be short, for example 10-30 minutes depending on longest supported game.
- `wordStreamCommitment` is a server hash of the generated word stream/settings, useful for audit.

### 3.3 ScoreAttempt Model

File: `models/ScoreAttempt.js`

```js
const mongoose = require('mongoose');

const ScoreAttemptSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    index: true
  },
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  name: { type: String, required: true, maxlength: 40, index: true },
  language: { type: String, required: true, index: true },
  WPM: { type: Number, required: true, index: true },
  mode: { type: String, required: true, index: true },

  computedScore: { type: Number, required: true, min: 0, max: 300000 },
  computedKeystrokes: { type: Number, required: true, min: 0 },
  computedTypos: { type: Number, required: true, min: 0 },
  computedPrecision: { type: Number, required: true, min: 0, max: 100 },
  computedTimeElapsedMs: { type: Number, required: true, min: 0 },

  submittedScore: { type: Number, required: false, select: false },

  riskScore: { type: Number, required: true, min: 0, max: 1, index: true },
  riskBand: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    required: true,
    index: true
  },
  riskReasons: [{ type: String, maxlength: 120 }],

  publicationStatus: {
    type: String,
    enum: ['private', 'published', 'pending_review', 'shadow_hidden', 'rejected'],
    required: true,
    index: true
  },

  // Lightweight summarized telemetry retained long term.
  telemetryStats: {
    keyEvents: Number,
    completedWords: Number,
    meanInterKeyMs: Number,
    stdInterKeyMs: Number,
    minInterKeyMs: Number,
    p05InterKeyMs: Number,
    p50InterKeyMs: Number,
    p95InterKeyMs: Number,
    meanReactionMs: Number,
    minReactionMs: Number,
    p05ReactionMs: Number,
    wordLengthTimingCorrelation: Number,
    longWordPenaltyCorrelation: Number,
    typoRate: Number,
    visibilityHiddenCount: Number,
    focusLossCount: Number,
    suspiciousEventCount: Number,
    isTrustedFalseCount: Number
  },

  // Raw telemetry should be retained only for suspicious/top scores and deleted later.
  rawTelemetryRef: {
    type: String,
    required: false,
    select: false
  },

  ipHash: { type: String, required: false, index: true },
  userAgentHash: { type: String, required: false, index: true },

  createdAt: { type: Date, default: Date.now, immutable: true, index: true }
});

ScoreAttemptSchema.index({ language: 1, WPM: 1, publicationStatus: 1, computedScore: -1, computedPrecision: -1 });
ScoreAttemptSchema.index({ userId: 1, createdAt: -1 });
ScoreAttemptSchema.index({ riskBand: 1, createdAt: -1 });

module.exports = mongoose.model('ScoreAttempt', ScoreAttemptSchema);
```

Public leaderboard must query only:

```js
{ publicationStatus: 'published' }
```

Never read directly from raw submitted fields.

### 3.4 AccountEvent Model

File: `models/AccountEvent.js`

```js
const mongoose = require('mongoose');

const AccountEventSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false, index: true },
  type: {
    type: String,
    enum: [
      'login',
      'logout',
      'game_start',
      'game_finish',
      'score_published',
      'score_hidden',
      'score_rejected',
      'ban',
      'shadow_ban',
      'unban',
      'waf_block',
      'rate_limit'
    ],
    required: true,
    index: true
  },
  details: { type: mongoose.Schema.Types.Mixed, required: false },
  ipHash: { type: String, required: false, index: true },
  userAgentHash: { type: String, required: false, index: true },
  createdAt: { type: Date, default: Date.now, immutable: true, index: true }
});

AccountEventSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('AccountEvent', AccountEventSchema);
```

---

## 4. Authentication and Account System

### 4.1 Use Google OpenID Connect

Use only basic scopes:

- `openid`
- `email`
- `profile`

Do not request Gmail, Drive, Calendar, or other sensitive scopes.

Required environment variables:

```bash
GOOGLE_CLIENT_ID="...apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="..."
GOOGLE_REDIRECT_URI="https://your-domain.example/auth/google/callback"
SESSION_COOKIE_SECRET="long-random-secret"
PEPPER_SECRET="long-random-secret-for-hashes"
PUBLIC_BASE_URL="https://your-domain.example"
```

Local development:

```bash
GOOGLE_REDIRECT_URI="http://127.0.0.1:3000/auth/google/callback"
PUBLIC_BASE_URL="http://127.0.0.1:3000"
```

### 4.2 Authentication Routes

Recommended files:

- `auth/google.js`
- `middleware/auth.js`
- `services/userService.js`

Routes:

```text
GET  /auth/google/start
GET  /auth/google/callback
POST /auth/logout
GET  /auth/me
```

#### GET /auth/google/start

Responsibilities:

- create a cryptographic `state`
- create PKCE verifier/challenge if using authorization code + PKCE
- store `state` in secure, httpOnly, SameSite cookie or server session
- redirect to Google authorization URL

Security requirements:

- `state` required and verified
- short state expiry, e.g. 10 minutes
- SameSite=Lax or Strict cookie
- Secure cookie in production
- no open redirect after login

#### GET /auth/google/callback

Responsibilities:

- verify `state`
- exchange code for tokens
- verify ID token signature/audience/issuer/expiry
- extract `sub`, `email`, `email_verified`, `name`, `picture`
- require `email_verified === true`
- upsert local user by `googleSub`
- create local session cookie
- redirect to app

Do not expose Google tokens to frontend.

### 4.3 Session Cookie

Use httpOnly secure cookies, not localStorage, for authentication.

Cookie settings:

```js
{
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 1000 * 60 * 60 * 24 * 30,
  path: '/'
}
```

For production behind a reverse proxy:

```js
app.set('trust proxy', 1);
```

### 4.4 CSRF Protection

For same-site cookie auth, add CSRF protection to state-changing endpoints:

- `POST /game/start`
- `POST /game/finish`
- `POST /auth/logout`
- admin actions

Approach:

- backend sets `csrfToken` non-httpOnly cookie
- frontend sends `X-CSRF-Token`
- backend verifies cookie token equals header token and matches session

Alternatively use SameSite=Strict plus origin checks, but explicit CSRF token is better.

### 4.5 Account Eligibility Rules

Public leaderboard publication requires all baseline conditions:

```js
const ELIGIBILITY = {
  minAccountAgeMs: 24 * 60 * 60 * 1000,
  minTotalPlayTimeMs: 30 * 60 * 1000,
  minValidFinishedGames: 10,
  maxRollingRiskScore: 0.5,
  maxHighRiskSessions: 0
};
```

Top score stricter conditions:

```js
const TOP_SCORE_RULES = {
  topN: 25,
  minAccountAgeMs: 7 * 24 * 60 * 60 * 1000,
  requireRawTelemetryRetention: true,
  maxRiskScore: 0.35
};
```

Publication decision should be centralized in `services/publicationService.js`.

### 4.6 Ban and Shadow-Ban Policy

Hard-ban:

- repeated critical risk sessions
- direct endpoint abuse
- tampering with session tokens
- impossible timing across multiple sessions
- malicious requests blocked by WAF repeatedly

Shadow-ban:

- uncertain automation
- suspicious but not conclusive pattern
- suspected bot calibration

Behavior:

- hard-banned users cannot submit leaderboard scores
- shadow-banned users can submit and see their own scores as saved
- public leaderboard excludes shadow-hidden scores
- API responses must not reveal shadow-ban state

Do not return detailed anti-cheat reasons to the client.

---

## 5. WAF and API Abuse Protection

The WAF layer protects endpoints before business logic runs. It does not replace backend validation.

Recommended files:

- `middleware/securityHeaders.js`
- `middleware/requestValidation.js`
- `middleware/rateLimits.js`
- `middleware/waf.js`
- `services/auditLog.js`

### 5.1 Security Headers

Use Helmet.

```bash
npm install helmet
```

Middleware:

```js
const helmet = require('helmet');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
```

KeyboardRage prefers local assets and no CDN. CSP should reflect that.

### 5.2 Body Size Limits

Current `bodyParser.json()` has no explicit small limit.

Use:

```js
app.use(express.json({ limit: '64kb', strict: true }));
```

For `/game/finish`, if raw telemetry can be bigger, use route-specific limit:

```js
app.post('/game/finish', express.json({ limit: '512kb' }), ...);
```

Set hard caps:

- max key events per game
- max completed words per game
- max visibility/focus events
- max request bytes
- max string lengths

### 5.3 NoSQL Injection Protection

Install:

```bash
npm install express-mongo-sanitize
```

Use:

```js
const mongoSanitize = require('express-mongo-sanitize');
app.use(mongoSanitize({ replaceWith: '_' }));
```

Also manually reject keys containing `$` or `.` in critical payloads, because sanitization can hide attacker intent.

### 5.4 Schema Validation

Use zod or Joi.

```bash
npm install zod
```

Example file: `validation/gameSchemas.js`

```js
const { z } = require('zod');

const supportedModes = [
  'rage', 'precision', 'fast',
  'precision+P', 'precision+N', 'rage+N', 'rage+P', 'fast+N', 'fast+P',
  'precision+N+P', 'rage+N+P', 'fast+N+P'
];

const startGameSchema = z.object({
  name: z.string().trim().min(3).max(40),
  language: z.string().regex(/^[a-z-]{2,40}$/),
  WPM: z.number().int().min(30).max(400),
  mode: z.enum(supportedModes),
  frequencyLimit: z.number().int().min(1).max(1000000).optional(),
  viewport: z.string().max(40).optional()
}).strict();

const keyEventSchema = z.object({
  key: z.string().min(1).max(8),
  code: z.string().max(32).optional(),
  t: z.number().int().min(0).max(60 * 60 * 1000),
  isTrusted: z.boolean().optional(),
  repeat: z.boolean().optional()
}).strict();

const completedWordSchema = z.object({
  wordIndex: z.number().int().min(0).max(300000),
  completedAt: z.number().int().min(0).max(60 * 60 * 1000),
  visibleAt: z.number().int().min(0).max(60 * 60 * 1000).optional()
}).strict();

const finishGameSchema = z.object({
  sessionId: z.string().uuid(),
  finishToken: z.string().min(32).max(200),
  keyEvents: z.array(keyEventSchema).max(50000),
  completedWords: z.array(completedWordSchema).max(300000),
  focusEvents: z.array(z.object({
    type: z.enum(['focus', 'blur']),
    t: z.number().int().min(0).max(60 * 60 * 1000)
  }).strict()).max(200).optional(),
  visibilityEvents: z.array(z.object({
    state: z.enum(['visible', 'hidden']),
    t: z.number().int().min(0).max(60 * 60 * 1000)
  }).strict()).max(200).optional()
}).strict();

module.exports = {
  startGameSchema,
  finishGameSchema,
  supportedModes
};
```

### 5.5 Rate Limits

Install if not already present:

```bash
npm install express-rate-limit
```

Recommended endpoint limits:

```text
GET  /auth/google/start       10 per 10 minutes per IP
GET  /auth/google/callback    20 per 10 minutes per IP
POST /game/start              30 per 10 minutes per user, 60 per IP
POST /game/finish             30 per 10 minutes per user, 60 per IP
GET  /leaderboard             120 per minute per IP
POST /score                   disabled or legacy reject
```

Use account-aware keys when authenticated:

```js
function rateLimitKey(req) {
  return req.user?._id?.toString() || req.ip;
}
```

For production multi-process/multi-host deployments, use Redis store. In-memory rate limits only protect one Node process.

### 5.6 Origin and Fetch Metadata Checks

For state-changing endpoints:

- require `Origin` to match `PUBLIC_BASE_URL`
- reject missing/wrong origin in production
- check `Sec-Fetch-Site` is `same-origin` or `same-site`
- check content type is `application/json`

Example:

```js
function requireSameOriginJson(req, res, next) {
  if (req.method !== 'GET') {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      return res.status(415).send('Unsupported media type');
    }

    const origin = req.headers.origin;
    if (process.env.NODE_ENV === 'production' && origin !== process.env.PUBLIC_BASE_URL) {
      return res.status(403).send('Forbidden');
    }

    const secFetchSite = req.headers['sec-fetch-site'];
    if (secFetchSite && !['same-origin', 'same-site'].includes(secFetchSite)) {
      return res.status(403).send('Forbidden');
    }
  }
  next();
}
```

Do not rely on headers alone. Attackers can call APIs outside browsers. Headers are a WAF signal, not a proof.

### 5.7 Legacy /score Endpoint

Do not keep the current `/score` behavior.

Options:

1. Remove `/score` entirely.
2. Keep `/score` as a compatibility endpoint returning `410 Gone`.
3. Keep `/score` only for local anonymous non-persistent scores, never MongoDB.

Recommended:

```js
app.post('/score', (req, res) => {
  return res.status(410).send({ error: 'Legacy score endpoint disabled. Use /game/start and /game/finish.' });
});
```

Do not leave any fallback validator that returns true.

---

## 6. Backend-Authoritative Score Recalculation

### 6.1 Deterministic Game Sessions

The backend must bind a session to immutable settings:

- user id or anonymous session
- name
- language
- WPM
- mode
- frequency limit
- add numbers / punctuation settings
- start time
- seed
- expected word stream commitment

The frontend may display these settings, but cannot change them at finish.

### 6.2 Word Stream Generation

Implement deterministic PRNG so backend and frontend generate the same sequence.

Recommended files:

- `services/prng.js`
- `services/wordStreamService.js`
- `services/gameRules.js`

Use a stable PRNG such as xoshiro, sfc32, or mulberry32 seeded from backend random bytes. Do not use `Math.random()` for session word streams.

Example:

```js
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { mulberry32 };
```

Backend start should create a random seed:

```js
const crypto = require('crypto');
const seedInt = crypto.randomBytes(4).readUInt32BE(0);
```

The word stream service:

```js
function buildWordStream({ language, frequencyLimit, addNumbers, applyGrammar, seed, count }) {
  const sourceWords = loadWords(language, frequencyLimit);
  const rng = mulberry32(seed);
  const stream = [];

  for (let i = 0; i < count; i++) {
    const index = Math.floor(rng() * sourceWords.length);
    let text = sourceWords[index].text;

    if (addNumbers) text = maybeAddNumber(text, rng);
    if (applyGrammar) text = maybeApplyGrammar(text, rng);

    stream.push({ index: i, sourceIndex: sourceWords[index].sourceIndex ?? index, text });
  }

  return stream;
}
```

Initial implementation can generate a large enough stream, e.g. 10,000 words. Later optimize with chunking.

### 6.3 Start Game Endpoint

Route: `POST /game/start`

Request:

```json
{
  "name": "Player",
  "language": "english",
  "WPM": 100,
  "mode": "rage",
  "frequencyLimit": 5000,
  "viewport": "1920x1080"
}
```

Response:

```json
{
  "sessionId": "uuid",
  "finishToken": "random-secret-token",
  "seed": 123456789,
  "startedAt": 1710000000000,
  "expiresAt": 1710001800000,
  "settings": {
    "language": "english",
    "WPM": 100,
    "mode": "rage",
    "frequencyLimit": 5000
  }
}
```

Security:

- require account if the user wants public leaderboard eligibility
- allow anonymous session but mark as non-publishable
- validate settings server-side
- hash finish token in DB
- bind session to user id if authenticated
- expire session
- rate limit start attempts

### 6.4 Finish Game Endpoint

Route: `POST /game/finish`

Request must not include trusted `score`.

```json
{
  "sessionId": "uuid",
  "finishToken": "secret",
  "keyEvents": [
    { "key": "a", "code": "KeyA", "t": 123, "isTrusted": true, "repeat": false }
  ],
  "completedWords": [
    { "wordIndex": 0, "visibleAt": 0, "completedAt": 950 }
  ],
  "focusEvents": [],
  "visibilityEvents": []
}
```

Server responsibilities:

1. Validate request schema.
2. Load `GameSession` by `sessionId`.
3. Verify session is active.
4. Verify session belongs to current user if authenticated.
5. Verify token hash with constant-time comparison.
6. Verify not expired.
7. Reconstruct expected word stream.
8. Replay or validate telemetry.
9. Compute score.
10. Compute risk score.
11. Create `ScoreAttempt`.
12. Mark session finished atomically.
13. Update user statistics.
14. Return generic accepted response.

### 6.5 Atomic Session Finish

Avoid double-submit race conditions.

Use atomic update:

```js
const updated = await GameSession.findOneAndUpdate(
  { sessionId, status: 'active', expiresAt: { $gt: new Date() } },
  { $set: { status: 'finished', finishedAt: new Date() } },
  { new: true }
).select('+finishTokenHash +seed +wordStreamCommitment');

if (!updated) {
  return res.status(409).send({ error: 'Session already finished or expired' });
}
```

If token verification fails after marking finished, mark rejected or use a transaction. Prefer MongoDB transaction if available.

### 6.6 Score Replay Modes

There are two practical validation levels.

#### Level A: Completed-Word Validation

Client submits completed word indexes and timings.

Backend verifies:

- word indexes are strictly increasing
- completed indexes exist in expected stream
- no duplicate completions
- timings are monotonic
- score = count of valid completed words
- time elapsed = last event or server finish time bounded by session start
- typos/keystrokes from keyEvents if available

Pros:

- simpler
- smaller telemetry
- enough to block score injection

Cons:

- a bot can fabricate plausible completions if it knows word stream

#### Level B: Key Event Replay

Client submits all keydown events.

Backend replays keyboard input against expected words and game mode rules.

Backend computes:

- current active word
- typed prefix
- typos
- completed words
- score
- precision
- time elapsed

Pros:

- stronger consistency check
- better anti-bot telemetry
- better auditability

Cons:

- more complex
- more data
- must match frontend game rules exactly

Recommended path:

- Implement Level A first but collect key events.
- Then implement Level B replay once telemetry format is stable.
- Public leaderboard top scores should require replay success.

### 6.7 Game Rule Engine

Create a shared backend rules module matching `game.ts` behavior.

File: `services/gameRules.js`

Responsibilities:

- normalize key input
- handle accents/dead keys conservatively
- apply rage/precision/fast scoring rules
- compute score and typos
- compute precision
- enforce fast mode precision requirement

Important frontend behavior currently:

- score increments when first active word is fully typed
- in fast mode, typo-made words do not increase score
- precision is `(keystrokes - typos) / keystrokes * 100`
- fast mode requires precision >= 90

Backend must be the canonical implementation after this change.

---

## 7. Anti-Bot Mechanism

Anti-bot should be risk-based, not a single brittle rule.

Recommended files:

- `services/antiCheat/features.js`
- `services/antiCheat/riskScorer.js`
- `services/antiCheat/publicationPolicy.js`
- `services/antiCheat/retentionPolicy.js`

### 7.1 Telemetry Collected by Frontend

Collect only gameplay-scoped telemetry:

```ts
type KeyTelemetry = {
  key: string;
  code?: string;
  t: number;              // milliseconds since game start
  isTrusted?: boolean;
  repeat?: boolean;
};

type CompletedWordTelemetry = {
  wordIndex: number;
  visibleAt?: number;
  completedAt: number;
};

type FocusTelemetry = {
  type: 'focus' | 'blur';
  t: number;
};

type VisibilityTelemetry = {
  state: 'visible' | 'hidden';
  t: number;
};
```

Do not collect text outside the game. Do not run global keylogging outside active gameplay.

### 7.2 Frontend Event Capture

In `game.ts`:

- initialize telemetry arrays at session start
- on keydown during active game, push key event
- when a word appears, record visible timestamp per word index
- when word completed, push completed word record
- on blur/focus, push focus event
- on visibilitychange, push visibility event
- cap telemetry array sizes defensively

Example caps:

```ts
const MAX_KEY_EVENTS = 50000;
const MAX_COMPLETED_WORDS = 300000;
const MAX_FOCUS_EVENTS = 200;
const MAX_VISIBILITY_EVENTS = 200;
```

If caps are exceeded, mark session as locally non-submit eligible and finish normally without public leaderboard submission.

### 7.3 Feature Extraction

Feature extraction input:

- key events
- completed words
- expected word stream
- computed score
- computed elapsed time
- focus/visibility events
- account age/stats

Extract:

#### Inter-key timing

- mean inter-key interval
- standard deviation
- coefficient of variation
- min interval
- p05/p50/p95 intervals
- count of intervals under 20ms
- count of identical intervals
- entropy / bucket diversity

Bot indicators:

- very low variance
- many identical intervals
- too many sub-20ms intervals
- suspiciously regular rhythm

#### Reaction time

For each word:

- word visible time
- first key time for that word
- reaction = first key - visible time

Bot indicators:

- repeated reaction times under human visual response threshold
- no difference between short and long words
- constant reaction timing over many words

Suggested thresholds:

```text
minReactionMs < 80 repeatedly: high suspicion
p05ReactionMs < 120 on high score: medium/high suspicion
reaction stddev extremely low: high suspicion
```

These are not hard rejects alone. They feed risk score.

#### Word difficulty correlation

Humans slow down on:

- longer words
- rare words
- punctuation
- numbers
- unfamiliar language

Compute:

- correlation(word length, completion time)
- correlation(word length, first-key latency)
- timing difference between short and long words

Bot indicators:

- zero or negative correlation at high WPM
- same cadence for 3-letter and 14-letter words

#### Error behavior

Track:

- typo rate
- typo distribution
- typo timing
- typo correlation with speed and word length
- perfect run at high speed

Bot indicators:

- 100% precision at extreme sustained speed
- errors look uniformly random rather than human
- no hesitation after typos

#### Browser/session signals

Track:

- `event.isTrusted === false`
- focus losses
- hidden-tab activity
- impossible events while document hidden
- rapid repeated session starts/finishes
- identical telemetry fingerprint across accounts

### 7.4 Risk Scoring

Use additive weighted scoring with capped contributions.

Example file: `services/antiCheat/riskScorer.js`

```js
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function scoreRisk(features, context) {
  const reasons = [];
  let risk = 0;

  if (features.keyEvents < 5 && context.computedScore > 5) {
    risk += 0.4;
    reasons.push('too_few_key_events_for_score');
  }

  if (features.minReactionMs !== null && features.minReactionMs < 50 && context.computedScore >= 10) {
    risk += 0.35;
    reasons.push('impossible_min_reaction_time');
  }

  if (features.p05ReactionMs !== null && features.p05ReactionMs < 100 && context.computedScore >= 25) {
    risk += 0.25;
    reasons.push('very_low_reaction_time_distribution');
  }

  if (features.stdInterKeyMs !== null && features.stdInterKeyMs < 8 && context.computedKeystrokes >= 100) {
    risk += 0.3;
    reasons.push('inter_key_variance_too_low');
  }

  if (features.identicalIntervalRatio > 0.25 && context.computedKeystrokes >= 100) {
    risk += 0.2;
    reasons.push('too_many_identical_key_intervals');
  }

  if (features.wordLengthTimingCorrelation !== null && features.wordLengthTimingCorrelation < 0.05 && context.computedScore >= 50) {
    risk += 0.15;
    reasons.push('no_word_length_timing_correlation');
  }

  if (context.computedPrecision === 100 && context.computedScore >= 150 && context.WPM >= 150) {
    risk += 0.2;
    reasons.push('perfect_precision_high_speed_high_score');
  }

  if (features.isTrustedFalseCount > 0) {
    risk += 0.5;
    reasons.push('untrusted_keyboard_events');
  }

  if (features.hiddenDuringActiveTyping) {
    risk += 0.3;
    reasons.push('typing_while_document_hidden');
  }

  if (context.accountAgeMs < 24 * 60 * 60 * 1000 && context.isTopScoreCandidate) {
    risk += 0.15;
    reasons.push('new_account_top_score');
  }

  return {
    riskScore: clamp01(risk),
    riskBand: risk >= 0.9 ? 'critical' : risk >= 0.7 ? 'high' : risk >= 0.4 ? 'medium' : 'low',
    riskReasons: reasons
  };
}

module.exports = { scoreRisk };
```

Thresholds must be tuned from real data. Start conservative to avoid false positives.

### 7.5 Publication Policy

Do not directly reject all risky scores. Use publication states.

Recommended policy:

```js
function decidePublication({ user, scoreAttempt, risk, leaderboardRankCandidate }) {
  if (!user) return 'private';

  if (user.trustLevel === 'banned') return 'rejected';
  if (user.shadowBanned || user.trustLevel === 'shadow_banned') return 'shadow_hidden';

  if (!isLeaderboardEligible(user)) return 'private';

  if (risk.riskBand === 'critical') return 'rejected';
  if (risk.riskBand === 'high') return 'shadow_hidden';
  if (risk.riskBand === 'medium') return 'pending_review';

  if (leaderboardRankCandidate <= 25 && !isTopScoreEligible(user, risk)) {
    return 'pending_review';
  }

  return 'published';
}
```

### 7.6 Anti-Calibration Strategy

Cheaters should not get immediate precise feedback.

Rules:

- never return riskScore to client
- never return riskReasons to client
- return generic success for private/shadow-hidden scores
- delay publication for top scores
- show “score saved” even if hidden from public leaderboard
- public leaderboard updates can be delayed or cached

Client response from `/game/finish`:

```json
{
  "ok": true,
  "scoreSaved": true,
  "leaderboardStatus": "saved"
}
```

Avoid:

```json
{
  "riskScore": 0.83,
  "reason": "inter_key_variance_too_low"
}
```

### 7.7 Data Retention

Raw key telemetry can be sensitive. Retain minimally.

Recommended retention:

- Low-risk normal scores: store only summary features.
- Top 100 or high-risk scores: store raw telemetry for 30-90 days.
- Rejected malicious sessions: store enough audit evidence for abuse prevention.
- Delete raw telemetry after retention window.

Document this in privacy notice.

---

## 8. Making Word Extraction Harder

This is obfuscation, not primary security, but it removes many low-effort bots.

### 8.1 Keep Words Out of DOM

KeyboardRage already renders game words on canvas/Three.js. Preserve that.

Do not add DOM text nodes containing active words.

### 8.2 Avoid Global Mutable Game State

Current browser JS can still expose `game.words` if attached globally. Avoid placing the active `Game` object or active word list on `window` in production.

Use module scope and closures where practical.

### 8.3 Chunk Word Streams

Instead of sending all future words, send limited chunks:

```text
GET /game/:sessionId/words?cursor=0
```

Return only next N words, e.g. 200-500. Sign each chunk or bind to session.

However, chunking adds latency and complexity. Initial implementation can use seed-based generation, then add chunking later.

### 8.4 Production Build Hardening

- minify production JS
- disable source maps in production
- do not expose debug endpoints
- no verbose anti-cheat logs in client
- no client-visible risk calculations

Do not rely on minification for security. It only raises the effort floor.

---

## 9. Leaderboard Query Changes

Current leaderboard aggregates `Score` documents directly.

New leaderboard should query `ScoreAttempt` with `publicationStatus: 'published'`.

Route:

```text
GET /leaderboard/:language/:WPM
```

Query:

```js
const scores = await ScoreAttempt.aggregate([
  {
    $match: {
      language: req.params.language,
      WPM: Number(req.params.WPM),
      publicationStatus: 'published'
    }
  },
  {
    $sort: {
      computedScore: -1,
      computedPrecision: -1,
      computedTimeElapsedMs: 1,
      createdAt: 1
    }
  },
  {
    $group: {
      _id: '$userId',
      doc: { $first: '$$ROOT' }
    }
  },
  { $replaceRoot: { newRoot: '$doc' } },
  {
    $sort: {
      computedScore: -1,
      computedPrecision: -1,
      computedTimeElapsedMs: 1
    }
  },
  { $skip: skip },
  { $limit: limit },
  {
    $project: {
      name: 1,
      language: 1,
      WPM: 1,
      mode: 1,
      score: '$computedScore',
      precision: '$computedPrecision',
      timeElapsed: '$computedTimeElapsedMs',
      createdAt: 1
    }
  }
]);
```

Do not return:

- risk score
- risk reasons
- email
- Google sub
- IP hash
- user agent hash
- raw telemetry references

---

## 10. Privacy and Legal Notice

Add a simple privacy page or section in README/docs before production.

Must disclose:

- Google login is used for leaderboard identity.
- Gameplay timing telemetry is collected for anti-cheat.
- IP/user-agent may be processed for abuse prevention.
- Raw key event telemetry is only collected during active gameplay.
- No text outside the game is collected.
- Raw telemetry retention is limited.
- Users can play anonymously without public leaderboard.

Example text:

```text
KeyboardRage collects gameplay statistics and timing telemetry during active games to validate scores and protect leaderboard integrity. If you sign in with Google, we store your Google account identifier, display name, and optional avatar for leaderboard identity. We do not collect passwords or text typed outside the game. Raw gameplay telemetry may be retained temporarily for anti-cheat review and then deleted or summarized.
```

---

## 11. Concrete Implementation Tasks

The first real implementation milestone is Google auth. The goal is to establish stable account identity before building WAF, game sessions, score attempts, bans, shadow-bans, and anti-cheat reputation around it.

### Task 1: Add Google Auth Foundation Dependencies

**Objective:** Install only the dependencies needed to create the identity layer first, plus shared security primitives used by auth cookies and token handling.

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`

**Commands:**

```bash
npm install cookie-parser jsonwebtoken google-auth-library uuid zod
```

**Verification:**

```bash
npm install
npm run build
```

Expected: build passes.

### Task 2: Create User Model and Auth Middleware Skeleton

**Objective:** Add the account identity model and request authentication middleware before touching score/session logic.

**Files:**

- Create: `models/User.js`
- Create: `middleware/auth.js`
- Create: `services/userService.js`
- Modify: `server.js`

**Requirements:**

- `User.googleSub` is unique, indexed, immutable, and is the canonical account id from Google.
- Store `displayName`, optional `avatarUrl`, account timestamps, trust state, ban/shadow-ban fields, and play/risk counters.
- Do not use email as the primary identifier.
- If storing email, keep it private and never return it in leaderboard responses.
- `middleware/auth.js` should attach `req.user` when a valid local session cookie exists and leave it undefined for anonymous users.
- Anonymous play must continue working.

**Verification:**

- Server starts.
- `/languages` still works.
- Anonymous requests still work with `req.user` unset.

### Task 3: Implement Google OpenID Connect Login

**Objective:** Let users sign in with Google so leaderboard identity exists before secure scoring is introduced.

**Files:**

- Create: `auth/google.js`
- Modify: `server.js`
- Modify: `middleware/auth.js`
- Modify: `services/userService.js`

**Routes:**

```text
GET  /auth/google/start
GET  /auth/google/callback
POST /auth/logout
GET  /auth/me
```

**Security requirements:**

- Use scopes only: `openid`, `email`, `profile`.
- Generate and verify OAuth `state`.
- Verify Google ID token issuer, audience, expiry, and signature.
- Require `email_verified === true`.
- Create local httpOnly session cookie.
- Do not expose Google access/refresh/id tokens to frontend JavaScript.
- Do not store auth tokens in localStorage.
- Use secure cookies in production.
- Add CSRF protection for logout and later state-changing authenticated endpoints.

**Environment variables:**

```bash
GOOGLE_CLIENT_ID="...apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="..."
GOOGLE_REDIRECT_URI="http://127.0.0.1:3000/auth/google/callback"
SESSION_COOKIE_SECRET="long-random-secret"
PEPPER_SECRET="long-random-secret-for-hashes"
PUBLIC_BASE_URL="http://127.0.0.1:3000"
```

**Verification:**

- `/auth/google/start` redirects to Google.
- `/auth/google/callback` creates or updates a `User`.
- `/auth/me` returns only safe public account fields.
- `/auth/logout` clears the local session.
- Anonymous users can still play.

### Task 4: Add Login/Logout UI Without Blocking Anonymous Play

**Objective:** Expose account state in the UI while keeping gameplay frictionless.

**Files:**

- Modify: `index.html` or relevant UI file
- Modify: `game.ts`
- Modify: compiled `game.js` only through TypeScript build, not manually

**Requirements:**

- Show “Sign in with Google” when unauthenticated.
- Show account display name/avatar and logout when authenticated.
- Anonymous users can start games normally.
- UI copy should clarify: login is required only for public leaderboard publication.
- Do not put auth tokens in localStorage.

**Verification:**

- Logged-out user can play.
- Logged-in user can play.
- Login state survives refresh through httpOnly cookie.
- Logout returns to anonymous state.

### Task 5: Add WAF and Request Hardening

**Objective:** Harden the API surface before introducing new game/session/finish endpoints.

**Files:**

- Create: `middleware/waf.js`
- Create: `middleware/rateLimits.js`
- Create: `validation/gameSchemas.js`
- Modify: `server.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Commands:**

```bash
npm install helmet express-mongo-sanitize express-rate-limit
```

Optional for distributed production rate limits:

```bash
npm install rate-limit-redis ioredis
```

**Middleware requirements:**

- Helmet security headers.
- JSON body limits.
- NoSQL sanitize.
- Strict schema validation with zod.
- Content-type enforcement for POST endpoints.
- Origin and Fetch Metadata checks for state-changing endpoints in production.
- Dangerous payload key rejection for critical JSON bodies.
- Endpoint-specific rate limits.
- Audit WAF/rate-limit blocks without logging secrets.

**Verification:**

```bash
curl -i http://127.0.0.1:3000/languages
```

Expected:

- HTTP 200
- security headers present

Blocked content-type test:

```bash
curl -i -X POST http://127.0.0.1:3000/game/start -H 'Content-Type: text/plain' --data 'bad'
```

Expected: HTTP 415 or 400 once `/game/start` exists.

### Task 6: Add Leaderboard Eligibility Service

**Objective:** Define account reputation rules before scores start flowing into the new pipeline.

**Files:**

- Create: `services/eligibilityService.js`
- Modify: `models/User.js`

**Rules:**

- account age >= 24h
- total play time >= 30min
- valid finished games >= 10
- rolling risk score below threshold
- no active ban
- no shadow-ban for public publication

**Verification:**

- new account returns ineligible
- sufficiently aged/test-seeded account returns eligible
- banned or shadow-banned account returns ineligible

### Task 7: Add Game Session Foundation

**Objective:** Replace loose `/token` semantics with backend-created game sessions bound to optional `userId`.

**Files:**

- Create: `models/GameSession.js`
- Create: `routes/game.js`
- Create: `services/gameSessionService.js`
- Create: `services/prng.js`
- Create: `services/wordStreamService.js`
- Modify: `server.js`
- Modify: `game.ts`

**New route:**

```text
POST /game/start
```

**Requirements:**

- validate requested settings server-side
- bind session to `req.user._id` when authenticated
- allow anonymous session but mark it non-publishable
- create `sessionId`
- create random finish token and store only hash
- store immutable settings: language, WPM, mode, frequency limit, addNumbers, applyGrammar
- store deterministic seed and word stream commitment
- set short expiry
- rate limit by account and IP

**Verification:**

- anonymous `/game/start` returns a session but no leaderboard eligibility
- authenticated `/game/start` returns a session bound to `userId`
- session token hash is stored, raw token is not
- changing settings at finish will not be trusted

### Task 8: Implement Deterministic Word Stream

**Objective:** Make the backend able to reconstruct expected game words for each session.

**Files:**

- Create/Modify: `services/prng.js`
- Create/Modify: `services/wordStreamService.js`
- Modify: `game.ts` to use server seed or returned word chunks

**Requirements:**

- no `Math.random()` for authoritative session stream
- stream is derived from session seed and immutable settings
- backend and frontend produce matching stream
- commitment hash is stored in `GameSession`
- future hardening can switch from seed to server-delivered chunks without changing score model

**Verification:**

- same seed/settings produce same first 100 words backend/frontend
- different seed produces different stream
- changed language/WPM/mode cannot affect finish validation

### Task 9: Add Telemetry Collection

**Objective:** Collect data needed for backend score replay and anti-bot analysis.

**Files:**

- Modify: `game.ts`

**Collect:**

- keydown events during active game only
- completed word records
- focus events
- visibility events
- word visible timestamps

**Privacy constraints:**

- do not collect outside active game
- do not collect text from other inputs
- cap array sizes
- do not store telemetry in localStorage longer than needed to submit finish

**Verification:**

- telemetry exists in `/game/finish` payload
- no gameplay key telemetry is collected while not playing
- caps prevent giant payloads

### Task 10: Implement Backend Score Finish and Replay

**Objective:** Stop trusting client score and compute final score server-side.

**Files:**

- Create: `models/ScoreAttempt.js`
- Create: `services/scoreReplayService.js`
- Modify: `routes/game.js`
- Modify: `server.js`
- Modify: `game.ts`

**New route:**

```text
POST /game/finish
```

**Requirements:**

- validate finish payload with zod
- atomically mark session finished
- verify finish token hash with constant-time comparison
- reject expired/reused sessions
- reconstruct expected word stream
- replay or validate telemetry
- compute score, precision, keystrokes, typos, and elapsed time
- ignore any submitted score field
- create `ScoreAttempt`
- update user play counters if authenticated

**Legacy route behavior:**

```text
POST /score -> 410 Gone
```

Do not keep any fallback validator that returns true.

**Verification:**

- direct POST `/score` cannot persist anything
- client-submitted score is ignored
- duplicate finish is rejected
- invalid token is rejected
- expired session is rejected

### Task 11: Implement Anti-Cheat Feature Extraction

**Objective:** Convert telemetry into stable behavioral features.

**Files:**

- Create: `services/antiCheat/features.js`

**Features:**

- inter-key stats
- reaction-time stats
- word length timing correlation
- typo rate
- trusted/untrusted event counts
- focus/visibility anomalies
- suspicious repeated intervals

**Verification:**

- human-like sample returns noisy timing features
- synthetic constant-interval bot sample shows low variance
- hidden-tab typing is detected

### Task 12: Implement Risk Scoring

**Objective:** Convert features and account context into risk score and risk band.

**Files:**

- Create: `services/antiCheat/riskScorer.js`

**Output:**

```js
{
  riskScore: 0.0,
  riskBand: 'low',
  riskReasons: []
}
```

**Verification:**

- impossible reaction sample -> high/critical
- low variance sample -> medium/high
- normal noisy timing -> low
- exact thresholds are not exposed to client

### Task 13: Implement Publication Policy and Leaderboard Gating

**Objective:** Decide whether computed scores are public, private, pending, shadow-hidden, or rejected.

**Files:**

- Create: `services/publicationService.js`
- Modify: `routes/game.js`
- Modify: `routes/leaderboard.js` or existing leaderboard route in `server.js`

**Statuses:**

- `private`
- `published`
- `pending_review`
- `shadow_hidden`
- `rejected`

**Requirements:**

- anonymous -> private
- new account -> private
- eligible low risk -> published
- medium risk -> pending_review
- high risk -> shadow_hidden
- critical risk -> rejected
- shadow-banned account -> shadow_hidden
- hard-banned account -> rejected
- public leaderboard reads only `published`

**Verification:**

- shadow/private/rejected scores never appear publicly
- published scores appear
- no sensitive fields are returned

### Task 14: Add Admin Review Tools

**Objective:** Allow manual review and account enforcement without exposing anti-cheat internals publicly.

**Files:**

- Create: `routes/admin.js`
- Create: `middleware/adminAuth.js`

**Minimum admin endpoints:**

```text
GET  /admin/scores/pending
POST /admin/scores/:id/publish
POST /admin/scores/:id/hide
POST /admin/users/:id/shadow-ban
POST /admin/users/:id/ban
POST /admin/users/:id/unban
```

Protect admin with an environment allowlist or separate admin auth.

**Verification:**

- non-admin gets 403
- admin can publish pending score
- admin can shadow-ban user
- public leaderboard reflects admin decisions

### Task 15: Add Privacy Notice

**Objective:** Disclose Google login and gameplay telemetry collection.

**Files:**

- Create: `docs/PRIVACY.md`
- Link from UI footer or README

**Required content:**

- Google account identity
- gameplay telemetry
- IP/user-agent abuse prevention
- raw telemetry retention
- anonymous play option

**Verification:**

- privacy doc exists
- UI links to privacy doc

---

## 12. Test Strategy

### 12.1 Unit Tests

Test modules:

- PRNG determinism
- word stream determinism
- schema validation
- score replay
- anti-cheat feature extraction
- risk scoring
- publication policy
- eligibility service

### 12.2 Integration Tests

Test flows:

1. Anonymous game start/finish saves private score only.
2. Authenticated new account score does not publish.
3. Eligible low-risk account score publishes.
4. Direct `/score` POST returns 410 and does not write DB.
5. Invalid finish token rejected.
6. Reused finish token rejected.
7. Expired session rejected.
8. Tampered language/WPM ignored or rejected.
9. Suspicious telemetry shadow-hidden.
10. Public leaderboard excludes private/pending/shadow/rejected.

### 12.3 Abuse Tests

Manual curl tests:

```bash
# Legacy endpoint blocked
curl -i -X POST http://127.0.0.1:3000/score \
  -H 'Content-Type: application/json' \
  --data '{"score":300000}'
```

Expected: `410 Gone`.

```bash
# NoSQL injection rejected/sanitized
curl -i -X POST http://127.0.0.1:3000/game/start \
  -H 'Content-Type: application/json' \
  --data '{"name":{"$gt":""},"language":"english","WPM":100,"mode":"rage"}'
```

Expected: `400 Bad Request`.

```bash
# Giant payload rejected
python3 - <<'PY'
import requests
payload = {'sessionId':'x','finishToken':'y','keyEvents':[{'key':'a','t':1}] * 1000000,'completedWords':[]}
r = requests.post('http://127.0.0.1:3000/game/finish', json=payload)
print(r.status_code, r.text[:200])
PY
```

Expected: `413 Payload Too Large` or `400 Bad Request`.

---

## 13. Deployment Notes

### 13.1 Reverse Proxy

If using nginx/Caddy/Cloudflare:

- enforce HTTPS
- set HSTS
- limit request body size
- rate limit abusive paths
- pass real IP carefully
- configure Express `trust proxy` only for trusted proxy chain

### 13.2 Environment Variables

Production must define:

```bash
NODE_ENV=production
PUBLIC_BASE_URL=https://keyboardrage.example
MONGODB_URI=mongodb://127.0.0.1:27017/typing_game
SESSION_COOKIE_SECRET=...
PEPPER_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://keyboardrage.example/auth/google/callback
```

### 13.3 Secrets

- never commit secrets
- rotate Google client secret if leaked
- use long random cookie secrets
- hash tokens before storing
- hash IP/user-agent with pepper

### 13.4 Monitoring

Log metrics:

- starts per IP/user
- finishes per IP/user
- WAF blocks
- finish token failures
- expired/reused sessions
- high-risk sessions
- published vs hidden scores
- account bans

Do not log raw tokens or full Google profiles.

---

## 14. Rollout Plan

### Phase 1: Google Auth Foundation

- add auth dependencies
- add `User` model
- add Google OpenID Connect routes
- add httpOnly local session cookie
- add `/auth/me` and logout
- add login/logout UI
- keep anonymous play available
- require Google account only for public leaderboard publication

### Phase 2: WAF and Request Hardening

- add Helmet and CSP
- add strict JSON/body limits
- add schema validation
- add NoSQL sanitization and dangerous-key rejection
- add endpoint-specific rate limits
- add origin/fetch metadata checks for state-changing endpoints
- add audit logging for WAF/rate-limit blocks

### Phase 3: Game Session Foundation

- add `GameSession` model
- add `/game/start`
- bind session to `userId` when authenticated
- allow anonymous non-publishable sessions
- add hashed finish token
- add immutable settings
- add deterministic seed and word-stream commitment

### Phase 4: Backend-Authoritative Scoring

- add telemetry collection
- add `/game/finish`
- reconstruct expected word stream
- compute score, precision, keystrokes, typos, and elapsed time server-side
- create `ScoreAttempt`
- disable legacy `/score` persistence

### Phase 5: Leaderboard Eligibility and Publication

- add account eligibility rules
- add private/published/pending/shadow/rejected publication statuses
- update leaderboard query to use only published computed scores
- block new accounts from instant public leaderboard impact
- add ban/shadow-ban enforcement

### Phase 6: Anti-Bot Risk

- feature extraction
- risk scorer
- delayed publication
- shadow-hide suspicious scores
- avoid exposing detailed anti-cheat feedback to client
- retain raw telemetry only for top/suspicious scores

### Phase 7: Admin Review, Hardening, and Tuning

- admin review endpoints
- account ban/unban tools
- chunked word delivery if needed
- raw telemetry retention job
- production CSP tuning
- threshold tuning from real sessions
- top-score stricter policy

---

## 15. Acceptance Criteria

Implementation is complete when all are true:

- `/score` can no longer persist a public leaderboard score.
- Client-submitted `score` is ignored or not accepted anywhere.
- Backend creates game sessions with immutable settings.
- Backend can reconstruct expected word stream.
- Backend computes score, precision, keystrokes, typos, and elapsed time.
- Public leaderboard only displays `ScoreAttempt` documents with `publicationStatus: 'published'`.
- Google account is required for public leaderboard publication.
- New accounts cannot instantly publish top scores.
- Banned/shadow-banned accounts cannot affect public leaderboard.
- WAF blocks malformed, oversized, cross-origin, and suspicious payloads.
- Anti-cheat risk is calculated server-side and never returned to client.
- Suspicious scores are hidden, pending, or rejected based on policy.
- Privacy notice documents Google login and gameplay telemetry.
- Tests cover direct injection, replay, duplicate finish, expired session, and leaderboard filtering.

---

## 16. Security Principles To Preserve

- Never trust client score.
- Never trust client settings at finish.
- Never expose anti-cheat thresholds to the client.
- Never give cheaters immediate precise feedback.
- Never store Google tokens in browser localStorage.
- Never return private identity/risk fields in leaderboard API.
- Fail closed when validation code is missing.
- Keep anonymous play frictionless, but keep public leaderboard account-gated.
- Treat anti-bot as probabilistic risk scoring, not perfect proof.
- Prefer shadow-hiding uncertain cheaters over giving them calibration feedback.
