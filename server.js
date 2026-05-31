// server.js

const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const { verifyGoogleToken, signSessionToken, verifySessionToken, GOOGLE_CLIENT_ID } = require('./auth');
const rateLimit = require('express-rate-limit');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  computeLevelProgress,
  summarizeTypingTelemetry,
  compactCompletedWords,
  compactRawTelemetry,
} = require('./typing-stats');
const {
  PUBLICATION_STATES,
  createFinishTokenPair,
  verifyFinishToken,
  rejectOperatorKeys,
  recomputeScoreFromTelemetry,
  decidePublicationStatus,
} = require('./game-session-security');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(bodyParser.json({ limit: '768kb' }));

const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "script-src 'self' 'unsafe-inline' https://accounts.google.com https://cdn.jsdelivr.net",
  "connect-src 'self' https://accounts.google.com https://www.googleapis.com",
  "img-src 'self' data: https://*.googleusercontent.com",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "font-src 'self' https://cdnjs.cloudflare.com data:",
  "frame-src 'self' https://accounts.google.com https://www.youtube.com https://www.youtube-nocookie.com",
  "media-src 'self' https://www.youtube.com https://www.youtube-nocookie.com",
].join('; ');

// Security headers — must run before static files and routes.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP_DIRECTIVES);
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('X-Frame-Options', 'DENY');
  // Google Sign-In popups need same-origin-allow-popups rather than strict same-origin.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  if (IS_PRODUCTION) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

const staticOptions = { dotfiles: 'deny', index: false, fallthrough: true };
const ASSET_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.json', '.bin', '.wasm', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.txt', '.woff', '.woff2', '.ttf']);
const JS_RUNTIME_EXTENSIONS = new Set(['.js', '.mjs', '.wasm', '.map']);
function onlyPublicAssets(req, res, next) {
  const ext = path.extname(req.path).toLowerCase();
  if (!ASSET_EXTENSIONS.has(ext)) return res.status(404).end();
  next();
}
function onlyScriptRuntimeFiles(req, res, next) {
  const ext = path.extname(req.path).toLowerCase();
  if (!JS_RUNTIME_EXTENSIONS.has(ext)) return res.status(404).end();
  next();
}
function serveTopLevelFile(route, fileName) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, fileName)));
}

// Serve only deliberate public assets. Do NOT expose the repository root:
// it contains .git, server.js, auth.js, antiCheat.js, rateLimiter.js and deploy-only files.
app.use(express.static(path.join(__dirname, 'public'), staticOptions));
app.use('/fonts', onlyPublicAssets, express.static(path.join(__dirname, 'fonts'), staticOptions));
app.use('/flags', onlyPublicAssets, express.static(path.join(__dirname, 'flags'), staticOptions));
app.use('/textures', onlyPublicAssets, express.static(path.join(__dirname, 'textures'), staticOptions));
app.use('/themes', onlyPublicAssets, express.static(path.join(__dirname, 'themes'), staticOptions));
app.use('/words', onlyPublicAssets, express.static(path.join(__dirname, 'words'), staticOptions));
app.use('/galaxy', onlyPublicAssets, express.static(path.join(__dirname, 'galaxy'), staticOptions));
app.use('/node_modules/three', onlyScriptRuntimeFiles, express.static(path.join(__dirname, 'node_modules', 'three'), staticOptions));
app.use('/node_modules/chart.js/dist', onlyScriptRuntimeFiles, express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist'), staticOptions));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
serveTopLevelFile('/favicon.ico', 'favicon.ico');
serveTopLevelFile('/logo.png', 'logo.png');

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

// Extensionless redirects for legal pages (Google OAuth reviewers check these)
app.get('/privacy', (req, res) => res.redirect(301, '/privacy.html'));
app.get('/terms', (req, res) => res.redirect(301, '/terms.html'));

async function startMongo() {
  try {
    if (process.env.MONGODB_URI) {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log('MongoDB Connected (external)');
      return;
    }

    if (process.env.NODE_ENV === 'production') {
      throw new Error('MONGODB_URI is required when NODE_ENV=production');
    }

    const dbPath = path.join(__dirname, '.mongo-dev-data');
    if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath, { recursive: true });
    const mongod = await MongoMemoryServer.create({
      instance: {
        dbPath,
        storageEngine: 'wiredTiger',
      },
    });
    const uri = mongod.getUri();
    await mongoose.connect(uri);
    console.log('MongoDB Connected (in-memory)');
  } catch (err) {
    console.error('Failed to connect to MongoDB', err);
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
}

startMongo();


const ScoreSchema = new mongoose.Schema({
  // Stable account identity. New scores must have this.
  // Legacy scores may not; leaderboard routes fall back to name for them.
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    default: null,
  },
  // Legacy/snapshot field. Do not use as identity anymore.
  name: {
    type: String,
    maxlength: 30
  },
  score: {
    type: Number,
    max: 300000
  },
  language: String,
  WPM: Number,
  keystrokes: Number,
  typos: Number,
  mode: String,
  precision: Number,
  timeElapsed: Number,
  gameSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'GameSession', default: null, index: true },
  scoreAttemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'ScoreAttempt', default: null, index: true },
  publicationStatus: {
    type: String,
    enum: Object.values(PUBLICATION_STATES),
    default: PUBLICATION_STATES.PUBLISHED,
    index: true,
  },
  riskScore: { type: Number, default: 0, min: 0, max: 100 },
  reviewNote: { type: String, default: '' },
  reviewedAt: { type: Date, default: null },
  ip: String,
  timestamp: { type: Date, default: Date.now, expires: '3653d' }
});
ScoreSchema.index({ userId: 1, WPM: 1, language: 1, mode: 1, publicationStatus: 1, score: -1 });
ScoreSchema.index({ language: 1, WPM: 1, publicationStatus: 1, score: -1, precision: -1 });

let supportedLanguagesCache = null;
function loadSupportedLanguages() {
  if (supportedLanguagesCache) return supportedLanguagesCache;
  try {
    const languages = JSON.parse(fs.readFileSync(path.join(__dirname, 'words', 'languagelist.json'), 'utf8'));
    const list = Array.isArray(languages) ? Array.from(new Set([...languages, 'english', 'french'])) : ['english', 'french'];
    const result = list.map(code => {
      let count = 0;
      try {
        const wordsPath = path.join(__dirname, 'words', code, 'words.json');
        if (fs.existsSync(wordsPath)) {
          const data = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));
          count = (data.words || []).length;
        }
      } catch (e) { /* use 0 */ }
      return { code, count };
    }).sort((a, b) => b.count - a.count);
    supportedLanguagesCache = result;
    return supportedLanguagesCache;
  } catch (err) {
    console.error('Failed to load languages', err);
    supportedLanguagesCache = [{ code: 'english', count: 352781 }, { code: 'french', count: 302443 }];
    return supportedLanguagesCache;
  }
}

app.get('/languages', (req, res) => {
  res.send(loadSupportedLanguages());
});

// ── User model (Google OAuth) ──────────────────────────────────
const UserSchema = new mongoose.Schema({
  googleId:         { type: String, required: true, unique: true, index: true },
  email:            { type: String, required: true },
  name:             { type: String, required: true },        // from Google
  picture:          { type: String, default: null },
  displayName:      { type: String, default: null, maxlength: 30 }, // in-game pseudo
  displayNameLower: { type: String, unique: true, sparse: true, index: true },
  displayNameChangedAt: { type: Date, default: null },
  createdAt:        { type: Date, default: Date.now },
  lastLogin:        { type: Date, default: Date.now },
});
const User = mongoose.model('User', UserSchema);

const DISPLAY_NAME_CHANGE_COOLDOWN_MS = 60 * 1000; // real changes: max once/minute in dev
const authSetupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many account setup attempts, wait a moment and try again.' },
});
const authGoogleLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, wait a moment and try again.' },
});
const scorePreAuthLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many score requests, wait a moment and try again.' },
});
const gameStartLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many game starts, wait a moment and try again.' },
});
const VALID_SCORE_MODES = new Set([
  'rage',
  'precision',
  'fast',
  'precision+P',
  'precision+N',
  'rage+N',
  'rage+P',
  'fast+N',
  'fast+P',
  'precision+N+P',
  'rage+N+P',
  'fast+N+P',
]);

function readStringQuery(value) {
  return typeof value === 'string' ? value : null;
}

function parseStrictNumberQuery(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return NaN;
  const raw = String(value);
  if (!/^\d+$/.test(raw)) return NaN;
  return Number(raw);
}

function parseBoundedInteger(value, fallback, { min = 1, max = 50 } = {}) {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const raw = String(value);
  if (!/^-?\d+$/.test(raw)) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function isSupportedLanguage(language) {
  return typeof language === 'string' && loadSupportedLanguages().some(item => item.code === language);
}

function normalizeDisplayName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function userPublicPayload(user) {
  return {
    id: user._id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    displayName: user.displayName || null,
  };
}

// ── Auth middleware ─────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }
  const payload = verifySessionToken(header.slice(7));
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = payload;
  next();
}


// ── Auth routes ─────────────────────────────────────────────────
app.post('/auth/google', authGoogleLimiter, async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: 'Missing credential' });
    }

    const profile = await verifyGoogleToken(credential);

    // Upsert user
    let user = await User.findOne({ googleId: profile.googleId });
    if (user) {
      user.lastLogin = new Date();
      user.name = profile.name;
      user.picture = profile.picture;
      await user.save();
    } else {
      user = await User.create(profile);
    }

    const token = signSessionToken(user);
    res.json({
      token,
      user: userPublicPayload(user),
    });
  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(401).json({ error: 'Authentication failed' });
  }
});

app.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.sub).lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(userPublicPayload(user));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/auth/setup', authSetupLimiter, authMiddleware, async (req, res) => {
  try {
    const displayName = normalizeDisplayName(req.body.displayName);
    if (displayName.length < 3 || displayName.length > 30) {
      return res.status(400).json({ error: 'Display name must be 3–30 characters' });
    }
    if (!/^[\p{L}\p{N}_ .-]+$/u.test(displayName)) {
      return res.status(400).json({ error: 'Display name contains unsupported characters' });
    }

    const displayNameLower = displayName.toLowerCase();

    // Case-insensitive uniqueness, independent from score history.
    const existing = await User.findOne({
      displayNameLower,
      _id: { $ne: req.user.sub },
    });
    if (existing) {
      return res.status(409).json({ error: 'Display name already taken' });
    }

    const currentUser = await User.findById(req.user.sub).lean();
    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isRealNameChange = currentUser.displayNameLower !== displayNameLower;
    if (isRealNameChange && currentUser.displayNameChangedAt) {
      const elapsed = Date.now() - new Date(currentUser.displayNameChangedAt).getTime();
      if (elapsed < DISPLAY_NAME_CHANGE_COOLDOWN_MS) {
        const retryAfterSeconds = Math.ceil((DISPLAY_NAME_CHANGE_COOLDOWN_MS - elapsed) / 1000);
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({
          error: `Display name was changed recently. Try again in ${retryAfterSeconds}s.`,
          retryAfterSeconds,
        });
      }
    }

    const update = isRealNameChange
      ? { displayName, displayNameLower, displayNameChangedAt: new Date() }
      : { displayName, displayNameLower };

    const user = await User.findByIdAndUpdate(
      req.user.sub,
      update,
      { new: true },
    ).lean();

    const token = signSessionToken(user);

    res.json({
      token,
      user: userPublicPayload(user),
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ error: 'Display name already taken' });
    }
    console.error('Account setup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/auth/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID });
});

const Score = mongoose.model('Score', ScoreSchema);
const scoreLimiter = require('./rateLimiter');
let validateScore;
let assessScoreAttempt;
try {
  const antiCheatModule = require('./antiCheat');
  validateScore = typeof antiCheatModule === 'function' ? antiCheatModule : antiCheatModule.validateScore;
  assessScoreAttempt = antiCheatModule.assessScoreAttempt || (() => ({ riskScore: 0, reasons: [] }));
  if (typeof validateScore !== 'function') throw new Error('antiCheat validateScore export missing');
} catch (err) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: antiCheat.js missing in production. Refusing to accept scores unvalidated.');
    process.exit(1);
  }
  console.warn('antiCheat.js not found, score validation bypassed (dev only).', err.message);
  validateScore = () => ({ valid: true });
  assessScoreAttempt = () => ({ riskScore: 0, reasons: [] });
}
const GameSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  language: { type: String, required: true, index: true },
  WPM: { type: Number, required: true, index: true },
  mode: { type: String, required: true },
  frequencyLimit: { type: Number, default: null },
  semanticActive: { type: Boolean, default: false },
  tokenHash: { type: String, required: true },
  status: { type: String, enum: ['active', 'finished', 'rejected', 'expired'], default: 'active', index: true },
  startedAt: { type: Date, default: Date.now, index: true },
  finishedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true, index: true },
  ip: String,
  clientMeta: { type: mongoose.Schema.Types.Mixed, default: {} },
});
GameSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });
const GameSession = mongoose.model('GameSession', GameSessionSchema);

const ScoreAttemptSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  gameSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'GameSession', default: null, index: true },
  scoreId: { type: mongoose.Schema.Types.ObjectId, ref: 'Score', default: null, index: true },
  language: { type: String, required: true, index: true },
  WPM: { type: Number, required: true, index: true },
  mode: { type: String, required: true },
  score: { type: Number, required: true },
  precision: { type: Number, required: true },
  keystrokes: { type: Number, required: true },
  typos: { type: Number, required: true },
  timeElapsed: { type: Number, required: true },
  clientScore: { type: Number, default: null },
  publicationStatus: {
    type: String,
    enum: Object.values(PUBLICATION_STATES),
    default: PUBLICATION_STATES.PRIVATE,
    index: true,
  },
  riskScore: { type: Number, default: 0, min: 0, max: 100, index: true },
  riskReasons: { type: [String], default: [] },
  validationReason: { type: String, default: '' },
  telemetrySummary: { type: mongoose.Schema.Types.Mixed, default: {} },
  telemetryCompact: { type: mongoose.Schema.Types.Mixed, default: {} },
  clientMeta: { type: mongoose.Schema.Types.Mixed, default: {} },
  ip: String,
  reviewHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },
  reviewedAt: { type: Date, default: null },
  timestamp: { type: Date, default: Date.now, expires: '3653d', index: true },
});
ScoreAttemptSchema.index({ publicationStatus: 1, timestamp: -1 });
ScoreAttemptSchema.index({ userId: 1, timestamp: -1 });
const ScoreAttempt = mongoose.model('ScoreAttempt', ScoreAttemptSchema);

const TypingSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  scoreId: { type: mongoose.Schema.Types.ObjectId, ref: 'Score', default: null, index: true },
  language: { type: String, required: true, index: true },
  WPM: { type: Number, required: true, index: true },
  mode: { type: String, required: true },
  score: { type: Number, required: true },
  precision: { type: Number, required: true },
  keystrokes: { type: Number, required: true },
  typos: { type: Number, required: true },
  timeElapsed: { type: Number, required: true },
  telemetrySummary: { type: mongoose.Schema.Types.Mixed, default: {} },
  telemetryCompact: { type: mongoose.Schema.Types.Mixed, default: {} },
  clientMeta: { type: mongoose.Schema.Types.Mixed, default: {} },
  ip: String,
  timestamp: { type: Date, default: Date.now, expires: '3653d', index: true },
});
TypingSessionSchema.index({ userId: 1, timestamp: -1 });
TypingSessionSchema.index({ userId: 1, language: 1, WPM: 1, timestamp: -1 });
const TypingSession = mongoose.model('TypingSession', TypingSessionSchema);

const UserWordProgressSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  language: { type: String, required: true, index: true },
  sourceIndex: { type: Number, default: -1 },
  wordHash: { type: String, required: true },
  firstTypedAt: { type: Date, default: Date.now },
  lastTypedAt: { type: Date, default: Date.now },
  timesTyped: { type: Number, default: 1 },
});
UserWordProgressSchema.index({ userId: 1, language: 1, wordHash: 1 }, { unique: true });
const UserWordProgress = mongoose.model('UserWordProgress', UserWordProgressSchema);

const UserTypingStatsSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  totalGames: { type: Number, default: 0 },
  totalPlayTimeMs: { type: Number, default: 0 },
  totalKeystrokes: { type: Number, default: 0 },
  totalTypos: { type: Number, default: 0 },
  totalScore: { type: Number, default: 0 },
  uniqueWordsTyped: { type: Number, default: 0 },
  bestScore: { type: Number, default: 0 },
  bestWPM: { type: Number, default: 0 },
  bestPrecision: { type: Number, default: 0 },
  bestLanguage: { type: String, default: null },
  averageConsistency: { type: Number, default: 0 },
  maxBurstWpm: { type: Number, default: 0 },
  daily: { type: [mongoose.Schema.Types.Mixed], default: [] },
  updatedAt: { type: Date, default: Date.now },
});
const UserTypingStats = mongoose.model('UserTypingStats', UserTypingStatsSchema);

function getTotalCorpusWordCount() {
  return loadSupportedLanguages().reduce((sum, lang) => sum + (Number(lang.count) || 0), 0);
}

function sanitizeClientMeta(meta = {}) {
  return {
    userAgent: String(meta.userAgent || '').slice(0, 240),
    platform: String(meta.platform || '').slice(0, 80),
    language: String(meta.language || '').slice(0, 32),
    screen: String(meta.screen || '').slice(0, 40),
    timezone: String(meta.timezone || '').slice(0, 80),
  };
}

async function persistTypingAnalytics({ accountUser, scoreDoc = null, scoreData, keystrokes, typos, timeElapsed, mode, precision, telemetry, ipAddress }) {
  const telemetrySummary = summarizeTypingTelemetry(telemetry || {});
  const telemetryCompact = compactRawTelemetry(telemetry || {});
  const session = await TypingSession.create({
    userId: accountUser._id,
    scoreId: scoreDoc?._id || null,
    language: scoreData.language,
    WPM: scoreData.WPM,
    mode,
    score: scoreData.score,
    precision,
    keystrokes,
    typos,
    timeElapsed,
    telemetrySummary,
    telemetryCompact,
    clientMeta: sanitizeClientMeta(telemetry?.clientMeta),
    ip: ipAddress,
  });

  const completedWords = compactCompletedWords(scoreData.language, telemetry?.completedWords || [], 1200);
  if (completedWords.length > 0) {
    await UserWordProgress.bulkWrite(completedWords.map(word => ({
      updateOne: {
        filter: { userId: accountUser._id, language: word.language, wordHash: word.wordHash },
        update: {
          $setOnInsert: { sourceIndex: word.sourceIndex, firstTypedAt: new Date(word.completedAt) },
          $set: { lastTypedAt: new Date(word.completedAt) },
          $inc: { timesTyped: 1 },
        },
        upsert: true,
      }
    })), { ordered: false });
  }

  const uniqueWordsTyped = await UserWordProgress.countDocuments({ userId: accountUser._id });
  const day = new Date().toISOString().slice(0, 10);
  let stats = await UserTypingStats.findOne({ userId: accountUser._id });
  if (!stats) {
    stats = new UserTypingStats({ userId: accountUser._id });
  }
  const previousGames = stats.totalGames || 0;
  const previousConsistencyTotal = (stats.averageConsistency || 0) * previousGames;
  stats.totalGames = previousGames + 1;
  stats.totalPlayTimeMs = (stats.totalPlayTimeMs || 0) + timeElapsed;
  stats.totalKeystrokes = (stats.totalKeystrokes || 0) + keystrokes;
  stats.totalTypos = (stats.totalTypos || 0) + typos;
  stats.totalScore = (stats.totalScore || 0) + scoreData.score;
  stats.uniqueWordsTyped = uniqueWordsTyped;
  stats.averageConsistency = Number(((previousConsistencyTotal + (telemetrySummary.consistencyScore || 0)) / stats.totalGames).toFixed(2));
  stats.maxBurstWpm = Math.max(stats.maxBurstWpm || 0, telemetrySummary.burstWpm || 0);
  if (scoreData.score > (stats.bestScore || 0)) {
    stats.bestScore = scoreData.score;
    stats.bestWPM = scoreData.WPM;
    stats.bestPrecision = precision;
    stats.bestLanguage = scoreData.language;
  }
  const daily = Array.isArray(stats.daily) ? stats.daily : [];
  const today = daily.find(entry => entry.day === day);
  if (today) {
    today.games += 1;
    today.playTimeMs += timeElapsed;
    today.score += scoreData.score;
    today.keystrokes += keystrokes;
  } else {
    daily.push({ day, games: 1, playTimeMs: timeElapsed, score: scoreData.score, keystrokes });
  }
  stats.daily = daily.slice(-180);
  stats.updatedAt = new Date();
  await stats.save();

  return { session, telemetrySummary, uniqueWordsTyped };
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.connection.remoteAddress;
}

function publishedScoreFilter(extra = {}) {
  return {
    ...extra,
    $or: [
      { publicationStatus: PUBLICATION_STATES.PUBLISHED },
      { publicationStatus: { $exists: false } },
    ],
  };
}

function parseFrequencyLimit(value) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000_000) return null;
  return parsed;
}

function loadWordsForSession(session, telemetry = {}) {
  if (session.semanticActive) {
    const derived = new Map();
    for (const word of Array.isArray(telemetry.completedWords) ? telemetry.completedWords : []) {
      const sourceIndex = Number(word.sourceIndex);
      if (Number.isInteger(sourceIndex) && sourceIndex >= 0 && !derived.has(sourceIndex)) {
        derived.set(sourceIndex, String(word.word || '').trimEnd());
      }
    }
    return { wordsBySourceIndex: derived, unverifiedSource: true };
  }
  const wordsPath = path.join(__dirname, 'words', session.language, 'words.json');
  const data = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));
  const words = Array.isArray(data.words) ? data.words.map(word => String(word || '').trimEnd()) : [];
  const limit = Math.max(1, Math.min(words.length, session.frequencyLimit || words.length));
  return { wordsBySourceIndex: words.slice(0, limit), unverifiedSource: false };
}

async function getAccountEligibility(accountUser) {
  const stats = await UserTypingStats.findOne({ userId: accountUser._id }).lean();
  return {
    accountAgeMs: Date.now() - new Date(accountUser.createdAt || Date.now()).getTime(),
    validFinishedGames: stats?.totalGames || 0,
    totalPlayTimeMs: stats?.totalPlayTimeMs || 0,
  };
}

async function bestPublishedScoreForUser(accountUser, WPM, language, mode) {
  const best = await Score.findOne(publishedScoreFilter({ userId: accountUser._id, WPM, language, mode }))
    .sort({ score: -1, precision: -1, timestamp: 1 })
    .lean();
  return best?.score || 0;
}

function normalizeRiskAssessment(assessment) {
  const riskScore = Math.max(0, Math.min(100, Math.round(Number(assessment?.riskScore) || 0)));
  const reasons = Array.isArray(assessment?.reasons) ? assessment.reasons.map(reason => String(reason).slice(0, 120)) : [];
  return { riskScore, reasons };
}

let supportedWPMs = [30, 50, 100, 101, 150, 200, 201, 250, 300, 350, 400];

app.post('/game/start', gameStartLimiter, authMiddleware, async (req, res) => {
  const operatorCheck = rejectOperatorKeys(req.body || {});
  if (!operatorCheck.valid) return res.status(400).json({ error: 'Invalid request' });

  const { language, WPM, mode, semanticActive = false, clientMeta = {} } = req.body || {};
  const cleanWpm = Number(WPM);
  const frequencyLimit = parseFrequencyLimit(req.body?.frequencyLimit);
  if (!isSupportedLanguage(language)) return res.status(400).json({ error: 'Unsupported language' });
  if (!supportedWPMs.includes(cleanWpm)) return res.status(400).json({ error: 'Unsupported WPM' });
  if (typeof mode !== 'string' || !VALID_SCORE_MODES.has(mode)) return res.status(400).json({ error: 'Unsupported mode' });

  try {
    const accountUser = await User.findById(req.user.sub).lean();
    if (!accountUser) return res.status(401).json({ error: 'User not found' });
    if (!accountUser.displayName) return res.status(403).json({ error: 'Account setup required' });
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'Game session database unavailable' });

    const { token, tokenHash } = createFinishTokenPair();
    const now = new Date();
    const session = await GameSession.create({
      userId: accountUser._id,
      language,
      WPM: cleanWpm,
      mode,
      frequencyLimit,
      semanticActive: semanticActive === true,
      tokenHash,
      startedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
      ip: getClientIp(req),
      clientMeta: sanitizeClientMeta(clientMeta),
    });
    return res.status(201).json({ sessionId: session._id, finishToken: token, expiresAt: session.expiresAt });
  } catch (err) {
    console.error('Game start error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/game/finish', scorePreAuthLimiter, authMiddleware, scoreLimiter, async (req, res) => {
  const operatorCheck = rejectOperatorKeys(req.body || {});
  if (!operatorCheck.valid) return res.status(400).json({ error: 'Invalid score' });

  const { sessionId, finishToken, telemetry, clientScore } = req.body || {};
  if (!mongoose.Types.ObjectId.isValid(sessionId)) return res.status(400).json({ error: 'Invalid score' });
  if (typeof finishToken !== 'string' || finishToken.length < 32) return res.status(400).json({ error: 'Invalid score' });

  let session;
  let scoreDoc = null;
  let attempt = null;
  const finishedAt = new Date();
  try {
    session = await GameSession.findOneAndUpdate(
      { _id: sessionId, userId: req.user.sub, status: 'active', expiresAt: { $gt: finishedAt } },
      { $set: { status: 'finished', finishedAt } },
      { new: true },
    );
    if (!session) return res.status(409).json({ error: 'Game session expired or already finished' });
    if (!verifyFinishToken(finishToken, session.tokenHash)) {
      session.status = 'rejected';
      await session.save();
      return res.status(400).json({ error: 'Invalid score' });
    }

    const accountUser = await User.findById(req.user.sub).lean();
    if (!accountUser) return res.status(401).json({ error: 'User not found' });
    if (!accountUser.displayName) return res.status(403).json({ error: 'Account setup required' });

    const { wordsBySourceIndex, unverifiedSource } = loadWordsForSession(session, telemetry || {});
    const computed = recomputeScoreFromTelemetry({
      telemetry,
      mode: session.mode,
      wordsBySourceIndex,
      serverStartedAt: session.startedAt,
      serverFinishedAt: finishedAt,
      clientScore,
    });

    if (!computed.valid) {
      await ScoreAttempt.create({
        userId: accountUser._id,
        gameSessionId: session._id,
        language: session.language,
        WPM: session.WPM,
        mode: session.mode,
        score: 0,
        precision: 0,
        keystrokes: 0,
        typos: 0,
        timeElapsed: 0,
        clientScore: Number.isFinite(Number(clientScore)) ? Number(clientScore) : null,
        publicationStatus: PUBLICATION_STATES.REJECTED,
        riskScore: 100,
        riskReasons: ['invalid replay'],
        validationReason: computed.reason || 'invalid replay',
        ip: getClientIp(req),
      });
      session.status = 'rejected';
      session.finishedAt = finishedAt;
      await session.save();
      return res.status(400).json({ error: 'Invalid score' });
    }

    const plausibility = validateScore(computed.score, computed.keystrokes, computed.typos, computed.timeElapsed, session.WPM, computed.precision);
    if (!plausibility.valid) {
      await ScoreAttempt.create({
        userId: accountUser._id,
        gameSessionId: session._id,
        language: session.language,
        WPM: session.WPM,
        mode: session.mode,
        score: computed.score,
        precision: computed.precision,
        keystrokes: computed.keystrokes,
        typos: computed.typos,
        timeElapsed: computed.timeElapsed,
        clientScore: Number.isFinite(Number(clientScore)) ? Number(clientScore) : null,
        publicationStatus: PUBLICATION_STATES.REJECTED,
        riskScore: 100,
        riskReasons: ['plausibility failure'],
        validationReason: plausibility.reason || 'plausibility failure',
        telemetrySummary: computed.telemetrySummary,
        telemetryCompact: compactRawTelemetry(telemetry || {}),
        clientMeta: sanitizeClientMeta(telemetry?.clientMeta),
        ip: getClientIp(req),
      });
      session.status = 'rejected';
      session.finishedAt = finishedAt;
      await session.save();
      console.warn(`Score replay rejected [${req.ip}]: ${plausibility.reason}`);
      return res.status(400).json({ error: 'Invalid score' });
    }

    const eligibility = await getAccountEligibility(accountUser);
    const privateAssessment = normalizeRiskAssessment(assessScoreAttempt({
      computed,
      telemetry,
      session: session.toObject(),
      account: accountUser,
      eligibility,
    }));
    const riskReasons = [...privateAssessment.reasons];
    const modeNeedsVariantReview = /(?:\+N|\+P)/.test(session.mode);
    if (unverifiedSource) riskReasons.push('semantic/manual word stream');
    if (modeNeedsVariantReview) riskReasons.push('client-random word variants');
    const decision = decidePublicationStatus({
      riskScore: privateAssessment.riskScore + (unverifiedSource ? 35 : 0) + (modeNeedsVariantReview ? 20 : 0),
      ...eligibility,
      score: computed.score,
    });
    const publicationStatus = decision.status === PUBLICATION_STATES.PUBLISHED && !unverifiedSource && !modeNeedsVariantReview
      ? PUBLICATION_STATES.PUBLISHED
      : PUBLICATION_STATES.PENDING_REVIEW;
    riskReasons.push(...decision.reasons);

    const ipAddress = getClientIp(req);
    const bestPublished = await bestPublishedScoreForUser(accountUser, session.WPM, session.language, session.mode);
    const leaderboardCandidate = computed.score > bestPublished;
    scoreDoc = null;
    if (leaderboardCandidate) {
      scoreDoc = await Score.create({
        userId: accountUser._id,
        name: accountUser.displayName,
        score: computed.score,
        language: session.language,
        WPM: session.WPM,
        keystrokes: computed.keystrokes,
        timeElapsed: computed.timeElapsed,
        typos: computed.typos,
        mode: session.mode,
        precision: computed.precision,
        gameSessionId: session._id,
        publicationStatus,
        riskScore: privateAssessment.riskScore,
        ip: ipAddress,
      });
    }

    attempt = await ScoreAttempt.create({
      userId: accountUser._id,
      gameSessionId: session._id,
      scoreId: scoreDoc?._id || null,
      language: session.language,
      WPM: session.WPM,
      mode: session.mode,
      score: computed.score,
      precision: computed.precision,
      keystrokes: computed.keystrokes,
      typos: computed.typos,
      timeElapsed: computed.timeElapsed,
      clientScore: Number.isFinite(Number(clientScore)) ? Number(clientScore) : null,
      publicationStatus: leaderboardCandidate ? publicationStatus : PUBLICATION_STATES.PRIVATE,
      riskScore: privateAssessment.riskScore,
      riskReasons: Array.from(new Set(riskReasons)).slice(0, 20),
      telemetrySummary: computed.telemetrySummary,
      telemetryCompact: compactRawTelemetry(telemetry || {}),
      clientMeta: sanitizeClientMeta(telemetry?.clientMeta),
      ip: ipAddress,
    });
    if (scoreDoc) {
      scoreDoc.scoreAttemptId = attempt._id;
      await scoreDoc.save();
    }

    const analytics = await persistTypingAnalytics({
      accountUser,
      scoreDoc,
      scoreData: { score: computed.score, language: session.language, WPM: session.WPM },
      keystrokes: computed.keystrokes,
      typos: computed.typos,
      timeElapsed: computed.timeElapsed,
      mode: session.mode,
      precision: computed.precision,
      telemetry,
      ipAddress,
    });

    return res.status(200).json({
      message: 'Score saved',
      leaderboardUpdated: Boolean(scoreDoc && publicationStatus === PUBLICATION_STATES.PUBLISHED),
      verificationStatus: publicationStatus === PUBLICATION_STATES.PUBLISHED ? 'published' : 'saved',
      level: computeLevelProgress(analytics.uniqueWordsTyped, getTotalCorpusWordCount()),
    });
  } catch (err) {
    console.error('Game finish error:', err);
    if (session) {
      try {
        session.status = 'rejected';
        session.finishedAt = new Date();
        await session.save();
      } catch (_) { /* ignore */ }
    }
    if (scoreDoc) {
      try {
        scoreDoc.publicationStatus = PUBLICATION_STATES.REJECTED;
        scoreDoc.reviewNote = 'Auto-hidden after finish pipeline failure';
        scoreDoc.reviewedAt = new Date();
        await scoreDoc.save();
      } catch (_) { /* ignore */ }
    }
    if (attempt) {
      try {
        attempt.publicationStatus = PUBLICATION_STATES.REJECTED;
        attempt.validationReason = 'finish pipeline failure';
        attempt.reviewedAt = new Date();
        await attempt.save();
      } catch (_) { /* ignore */ }
    }
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post("/score", scorePreAuthLimiter, authMiddleware, scoreLimiter, async (req, res) => {
  return res.status(410).json({ error: 'Game sessions are required for leaderboard scores.' });
});

app.get('/stats/me', authMiddleware, async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: 'Stats database unavailable' });
  }

  try {
    const accountUser = await User.findById(req.user.sub).lean();
    if (!accountUser) return res.status(401).json({ error: 'User not found' });

    const stats = await UserTypingStats.findOne({ userId: accountUser._id }).lean();
    const totalWords = getTotalCorpusWordCount();
    const uniqueWordsTyped = stats?.uniqueWordsTyped || await UserWordProgress.countDocuments({ userId: accountUser._id });
    const level = computeLevelProgress(uniqueWordsTyped, totalWords);

    const [bestScores, recentSessions, byLanguage] = await Promise.all([
      Score.find({ userId: accountUser._id })
        .sort({ score: -1, precision: -1, timestamp: -1 })
        .limit(10)
        .select('score language WPM mode precision keystrokes typos timeElapsed timestamp')
        .lean(),
      TypingSession.find({ userId: accountUser._id })
        .sort({ timestamp: -1 })
        .limit(300)
        .select('score language WPM mode precision keystrokes typos timeElapsed telemetrySummary timestamp')
        .lean(),
      TypingSession.aggregate([
        { $match: { userId: accountUser._id } },
        {
          $group: {
            _id: '$language',
            games: { $sum: 1 },
            playTimeMs: { $sum: '$timeElapsed' },
            bestScore: { $max: '$score' },
            averagePrecision: { $avg: '$precision' },
            averageConsistency: { $avg: '$telemetrySummary.consistencyScore' },
          }
        },
        { $sort: { games: -1, bestScore: -1 } },
        { $limit: 12 },
      ]),
    ]);

    res.json({
      user: userPublicPayload(accountUser),
      totals: {
        totalGames: stats?.totalGames || 0,
        totalPlayTimeMs: stats?.totalPlayTimeMs || 0,
        totalKeystrokes: stats?.totalKeystrokes || 0,
        totalTypos: stats?.totalTypos || 0,
        totalScore: stats?.totalScore || 0,
        bestScore: stats?.bestScore || 0,
        bestWPM: stats?.bestWPM || 0,
        bestPrecision: stats?.bestPrecision || 0,
        bestLanguage: stats?.bestLanguage || null,
        averageConsistency: stats?.averageConsistency || 0,
        maxBurstWpm: stats?.maxBurstWpm || 0,
      },
      level,
      daily: stats?.daily || [],
      bestScores,
      recentSessions,
      byLanguage: byLanguage.map(row => ({
        language: row._id,
        games: row.games,
        playTimeMs: row.playTimeMs,
        bestScore: row.bestScore,
        averagePrecision: Number((row.averagePrecision || 0).toFixed(2)),
        averageConsistency: Number((row.averageConsistency || 0).toFixed(2)),
      })),
    });
  } catch (err) {
    console.error('Stats endpoint error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  const lang = readStringQuery(req.query.lang);
  const rawWpm = req.query.wpm == null ? null : parseStrictNumberQuery(req.query.wpm);
  const mode = readStringQuery(req.query.mode);
  const page = parseBoundedInteger(req.query.page, 1, { min: 1, max: 10000 });
  const limit = parseBoundedInteger(req.query.limit, 20, { min: 5, max: 50 });
  const skip = (page - 1) * limit;

  if (!lang) return res.status(400).json({ error: 'lang parameter is required' });
  if (!isSupportedLanguage(lang)) return res.status(400).json({ error: 'Unsupported language' });
  if (rawWpm !== null && !supportedWPMs.includes(rawWpm)) return res.status(400).json({ error: 'Unsupported WPM' });
  if (mode && !VALID_SCORE_MODES.has(mode)) return res.status(400).json({ error: 'Unsupported mode' });

  if (mongoose.connection.readyState !== 1) {
    return res.status(200).json({ scores: [], total: 0, page, limit });
  }

  try {
    const match = publishedScoreFilter({ language: lang });
    if (rawWpm !== null) match.WPM = rawWpm;
    if (mode) match.mode = mode;

    const [result] = await Score.aggregate([
      { $match: match },
      { $sort: { score: -1, precision: -1, timestamp: 1 } },
      {
        $group: {
          _id: {
            $cond: [
              { $ifNull: ['$userId', false] },
              { $concat: ['user:', { $toString: '$userId' }] },
              { $concat: ['legacy:', '$name'] }
            ]
          },
          doc: { $first: '$$ROOT' }
        }
      },
      { $replaceRoot: { newRoot: '$doc' } },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          name: { $ifNull: ['$user.displayName', '$name'] },
          userPicture: '$user.picture'
        }
      },
      {
        $facet: {
          scores: [
            { $sort: { score: -1, precision: -1, timestamp: 1 } },
            { $skip: skip },
            { $limit: limit },
            { $project: { user: 0, googleId: 0, ip: 0, userId: 0, __v: 0 } }
          ],
          total: [{ $count: 'count' }]
        }
      }
    ]);

    const total = result.total[0]?.count || 0;
    res.json({ scores: result.scores, total, page, limit });
  } catch (err) {
    console.error('API leaderboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
