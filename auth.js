// auth.js — Google OAuth + JWT session management
// Dependencies: google-auth-library, jsonwebtoken
//
// JWT_SECRET is read from env (process.env.JWT_SECRET).  Generate one:
//   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
//
// In dev, falls back to a random secret (sessions invalid on restart —
// acceptable for dev, not for production).

const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '488404200674-3r3mrk5vfb8go9f28o2j12tcu36fviap.apps.googleusercontent.com';

const JWT_SECRET_FILE = require('path').join(__dirname, '.jwt-secret');
function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try {
    if (require('fs').existsSync(JWT_SECRET_FILE)) {
      return require('fs').readFileSync(JWT_SECRET_FILE, 'utf8').trim();
    }
    const secret = crypto.randomBytes(64).toString('hex');
    require('fs').writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
    return secret;
  } catch {
    // Last-resort dev fallback. Production must set JWT_SECRET.
    return crypto.randomBytes(64).toString('hex');
  }
}

const JWT_SECRET = loadJwtSecret();

const JWT_EXPIRY = '30d'; // session duration

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

/**
 * Verify a Google ID token and return the payload.
 * @param {string} credential - Google ID token from Sign In With Google
 * @returns {Promise<object>} { sub, email, name, picture, email_verified }
 */
async function verifyGoogleToken(credential) {
  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.sub) {
    throw new Error('Invalid Google token: missing sub');
  }
  if (!payload.email_verified) {
    throw new Error('Google account email not verified');
  }
  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name || payload.email.split('@')[0],
    picture: payload.picture || null,
  };
}

/**
 * Sign a JWT for the given user.
 * @param {object} user - { _id, googleId, email, name, picture }
 * @returns {string} JWT token
 */
function signSessionToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      googleId: user.googleId,
      email: user.email,
      name: user.name,
      displayName: user.displayName || null,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY },
  );
}

/**
 * Verify a session JWT and return the payload.
 * @param {string} token - JWT from Authorization header
 * @returns {object|null} decoded payload or null if invalid/expired
 */
function verifySessionToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

module.exports = {
  GOOGLE_CLIENT_ID,
  verifyGoogleToken,
  signSessionToken,
  verifySessionToken,
};
