// server.js

const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const ip = require('ip');
const { verifyGoogleToken, signSessionToken, verifySessionToken, GOOGLE_CLIENT_ID } = require('./auth');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
app.use(bodyParser.json());

app.listen(3000, () => console.log('Server listening on port 3000'));

app.use(express.static(__dirname));

mongoose.connect('mongodb://127.0.0.1:27017/typing_game', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => {
  console.log('MongoDB Connected')
})
.catch(err => {
  console.error('Failed to connect to MongoDB', err)
});

let tokens = [];
app.get('/token', (req, res) => {
  const token = Math.random().toString(36).substring(2);
  tokens.push(token);
  res.send({ token });
});


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
  ip: String,
  timestamp: { type: Date, default: Date.now, expires: '3653d' }
});
ScoreSchema.index({ userId: 1, WPM: 1, language: 1, score: -1 });
ScoreSchema.index({ language: 1, WPM: 1, score: -1, precision: -1 });

function loadSupportedLanguages() {
  try {
    const languages = JSON.parse(fs.readFileSync(path.join(__dirname, 'words', 'languagelist.json'), 'utf8'));
    const list = Array.isArray(languages) ? Array.from(new Set([...languages, 'english', 'french'])) : ['english', 'french'];
    return list.map(code => {
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
  } catch (err) {
    console.error('Failed to load languages', err);
    return [{ code: 'english', count: 352781 }, { code: 'french', count: 302443 }];
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
  displayNameLower: { type: String, default: null, unique: true, sparse: true, index: true },
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
app.post('/auth/google', async (req, res) => {
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

let supportedWPMs = [30, 50, 100, 101, 150, 200, 250, 300, 350, 400];
app.post("/score", scoreLimiter, authMiddleware, async (req, res) => {
  const { keystrokes, timeElapsed, typos, mode, ...scoreData } = req.body;

  // Score submission is tied to the stable User._id, not the mutable display name.
  const accountUser = await User.findById(req.user.sub).lean();
  if (!accountUser) {
    return res.status(401).send('User not found');
  }
  if (!accountUser.displayName) {
    return res.status(403).send('Account setup required — set your display name first');
  }

  // Typos validation
  if (typeof typos !== 'number' || !Number.isInteger(typos) || typos < 0 || typos > keystrokes) {
    return res.status(400).send('Invalid typos');
  }

// Mode validation
if (
    typeof mode !== 'string' ||
    ![
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
        'fast+N+P'
    ].includes(mode)
) {
    return res.status(400).send('Invalid mode');
}

// Calculate precision
const precision = ((keystrokes - typos) / keystrokes) * 100;

// Validate precision
if (typeof precision !== 'number' || precision < 0 || precision > 100) {
    return res.status(400).send('Invalid precision');
}

// Validate precision for 'fast' mode
if (['fast', 'fast+N', 'fast+P', 'fast+N+P'].includes(mode) && precision < 90) {
    return res.status(400).send('Invalid precision for fast mode. Precision must be above 90');
}

if (typeof scoreData.score !== 'number' || !Number.isInteger(scoreData.score) || scoreData.score < 0 || scoreData.score > 300000) {
    return res.status(400).send('Invalid score');
}

if (!loadSupportedLanguages().some(l => l.code === scoreData.language)) {
    return res.status(400).send('Invalid language');
}

if (!supportedWPMs.includes(scoreData.WPM)) {
    return res.status(400).send('Invalid WPM');
}

  // Score plausibility validation (antiCheat.js)
  const plausibility = validateScore(scoreData.score, keystrokes, typos, timeElapsed, scoreData.WPM, precision);
  if (!plausibility.valid) {
    console.warn(`Score rejected [${req.ip}]: ${plausibility.reason}`);
    return res.status(400).send('Invalid score');
  }

  // New scores use userId as the stable identity. `name` remains a display snapshot/fallback only.
  const newScoreData = {
    userId: accountUser._id,
    name: accountUser.displayName,
    score: scoreData.score,
    language: scoreData.language,
    WPM: scoreData.WPM,
    keystrokes,
    timeElapsed,
    typos,
    mode,
    precision,
    ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.connection.remoteAddress
  };

  if (mongoose.connection.readyState !== 1) {
    return res.status(202).send({ message: 'Score accepted locally, but MongoDB is unavailable so it was not persisted.' });
  }

  try {
    // Highest score check is per stable userId, not mutable display name.
    const highestScoreEntry = await Score.findOne({
      userId: accountUser._id, WPM: scoreData.WPM, language: scoreData.language,
    }).sort({ score: -1 });

    if (highestScoreEntry) {
      const highestScore = highestScoreEntry.score;

      if (scoreData.score <= highestScore) {
        return res.status(400).send('Score should be higher than the previous best score');
      }

      await Score.deleteMany({
        userId: accountUser._id,
        WPM: scoreData.WPM,
        language: scoreData.language,
        score: { $lte: highestScore }
      });
    }

    const newScore = new Score(newScoreData);
    const score = await newScore.save();
    return res.status(200).send(score);
  } catch (err) {
    return res.status(500).send(err);
  }
});


try {
    var validateScore = require('./antiCheat');
} catch (err) {
    console.warn('antiCheat.js not found, score validation will be bypassed.', err.message);
    validateScore = () => ({ valid: true });
}

// import motivation.json
let motivationalMessages = [
  'Keep typing — the leaderboard is only available for supported WPM values.'
];
try {
  const loadedMessages = JSON.parse(fs.readFileSync('./words/motivation.json', 'utf8'));
  if (Array.isArray(loadedMessages) && loadedMessages.length > 0) {
    motivationalMessages = loadedMessages;
  }
} catch (err) {
  console.warn('Failed to load motivation.json, using fallback motivation message.', err);
}

// Leaderboard endpoint: one best score per stable account identity.
app.get('/leaderboard/:language/:WPM', async (req, res) => {
  const WPM = Number(req.params.WPM);
  if (!supportedWPMs.includes(WPM)) {
    const randomIndex = Math.floor(Math.random() * motivationalMessages.length);
    return res.status(200).send({ message: motivationalMessages[randomIndex] });
  }
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  if (mongoose.connection.readyState !== 1) {
    return res.status(200).send([]);
  }

  try {
    const scores = await Score.aggregate([
      {
        $match: {
          language: req.params.language,
          WPM,
        }
      },
      // Sort before grouping so $first is truly the best document.
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
      { $sort: { score: -1, precision: -1, timestamp: 1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          user: 0,
          googleId: 0,
          ip: 0,
        }
      }
    ]);

    return res.status(200).send(scores);
  } catch (err) {
    console.error('Leaderboard error:', err);
    return res.status(500).send(err);
  }
});

// Endpoint for the latest scores
app.get('/latest-scores', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  if (mongoose.connection.readyState !== 1) {
    return res.status(200).send([]);
  }

  try {
    const scores = await Score.aggregate([
      { $sort: { timestamp: -1 } },
      { $skip: skip },
      { $limit: limit },
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
      { $project: { user: 0, googleId: 0, ip: 0 } }
    ]);

    return res.status(200).send(scores);
  } catch (err) {
    console.error('Latest scores error:', err);
    return res.status(500).send(err);
  }
});
