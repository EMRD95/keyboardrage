// auth-client.js — Google Sign-In + bounded cookie-backed session management (frontend)
// Uses Google Identity Services (GIS) "Sign In With Google".
// Redirects to /account.html on first login if no displayName is set.

const AUTH_STORAGE_KEY = 'kr_session';
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes before server re-verification
const TOKEN_EXPIRY_SKEW_MS = 30 * 1000;

let _session = null; // { token: null, user: { id, email, name, picture, displayName } }
let _initialized = false;
let _storageListenerInstalled = false;

// ── Public API ──────────────────────────────────────────────────

export function getSession() {
  return _session;
}

export function isLoggedIn() {
  return _session !== null && _session.user !== null;
}

export function getDisplayName() {
  return _session?.user?.displayName || _session?.user?.name || null;
}

export function updateSession(user, sessionExpiresAt = null) {
  if (!user) return;
  _session = { token: null, user };
  _persistSession(user, Date.now(), sessionExpiresAt);
  _updateUI();
  _onSessionReady();
}

export function updateSessionFromAuthResponse(data) {
  const parsed = _normalizeAuthResponse(data);
  updateSession(parsed.user, parsed.sessionExpiresAt);
  return parsed.user;
}

/** Initialize Google Sign-In and restore saved session. */
export async function initAuth() {
  if (_initialized) return;
  _initialized = true;
  _installStorageListener();

  const parsed = _readSavedSession();
  if (!parsed) {
    // No saved profile cache — just set up the sign-in button
    _initGoogleButton();
    _updateUI();
    _onSessionReady();
    return;
  }

  // Use cached public profile if recent enough. The actual auth secret is in an
  // HttpOnly SameSite cookie; legacy bearer-token caches must be verified once
  // so the server can mint that cookie and the client can discard the token.
  if (!parsed.legacyToken && parsed.user && parsed.cachedAt && (Date.now() - parsed.cachedAt < CACHE_TTL)) {
    _session = { token: null, user: parsed.user };
    _initGoogleButton();
    _updateUI();
    _onSessionReady();
    return;
  }

  // Verify with server (first load, stale cache, or legacy-token migration).
  try {
    const headers = parsed.legacyToken ? { Authorization: `Bearer ${parsed.legacyToken}` } : {};
    const resp = await fetch('/auth/me', {
      headers,
      credentials: 'same-origin',
    });
    if (resp.ok) {
      updateSessionFromAuthResponse(await resp.json());
      _initGoogleButton();
    } else if (resp.status === 401) {
      _clearStoredSession();
      _session = null;
      _initGoogleButton();
      _updateUI();
      _onSessionReady();
    } else {
      _useCachedSession(parsed);
    }
  } catch {
    // Network error — use cached profile if available and not past its known expiry.
    _useCachedSession(parsed);
  }
}

async function _initGoogleButton() {
  let clientId;
  try {
    const cfg = await fetch('/auth/config').then(r => r.json());
    clientId = cfg.googleClientId;
  } catch {
    console.warn('Could not fetch Google Client ID');
    return;
  }

  if (!window.google?.accounts?.id) {
    await new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = resolve;
      document.head.appendChild(script);
    });
  }

  if (window.google?.accounts?.id) {
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: handleGoogleResponse,
      auto_select: false,
      cancel_on_tap_outside: true,
    });

    const btn = document.getElementById('google-signin-btn');
    if (btn) {
      window.google.accounts.id.renderButton(btn, {
        type: 'standard',
        theme: 'filled_black',
        size: 'medium',
        text: 'signin_with',
        shape: 'rectangular',
        width: 180,
      });
    }
  }

  document.getElementById('auth-signout')?.addEventListener('click', signOut);
  _updateUI();
}

/** Sign out. */
export function signOut() {
  _session = null;
  _clearStoredSession();
  fetch('/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
  }).catch(() => {});
  if (window.google?.accounts?.id) {
    window.google.accounts.id.disableAutoSelect();
  }
  _updateUI();
  _onSessionReady();
}

// ── Internals ───────────────────────────────────────────────────

async function handleGoogleResponse(response) {
  try {
    const res = await fetch('/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ credential: response.credential }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Auth failed');
    }

    const user = updateSessionFromAuthResponse(await res.json());

    // Redirect to account setup if no displayName
    if (!user.displayName) {
      window.location.href = '/account.html';
    }
  } catch (err) {
    console.error('Google sign-in error:', err);
    alert('Sign-in failed. Try again.');
  }
}

function _normalizeAuthResponse(data) {
  if (data?.user) {
    return { user: data.user, sessionExpiresAt: data.sessionExpiresAt || null };
  }
  return { user: data, sessionExpiresAt: data?.sessionExpiresAt || null };
}

function _readSavedSession() {
  let saved = null;
  try { saved = localStorage.getItem(AUTH_STORAGE_KEY); } catch { /* storage disabled */ }
  const parsed = _parseStoredSession(saved);
  if (parsed) return parsed;
  if (saved) {
    try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch { /* storage disabled */ }
  }

  // Migrate the old tab-scoped sessionStorage session so current players do not
  // have to log in again immediately after this deploy.
  let legacy = null;
  try { legacy = sessionStorage.getItem(AUTH_STORAGE_KEY); } catch { /* storage disabled */ }
  const legacyParsed = _parseStoredSession(legacy);
  if (legacyParsed) return legacyParsed;
  if (legacy) {
    try { sessionStorage.removeItem(AUTH_STORAGE_KEY); } catch { /* storage disabled */ }
  }
  return null;
}

function _parseStoredSession(raw) {
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || !parsed.user) return null;
  const result = {
    user: parsed.user,
    cachedAt: Number(parsed.cachedAt) || 0,
    sessionExpiresAt: parsed.sessionExpiresAt || null,
    legacyToken: null,
  };
  if (result.sessionExpiresAt && Date.parse(result.sessionExpiresAt) <= Date.now() + TOKEN_EXPIRY_SKEW_MS) {
    return null;
  }
  if (typeof parsed.token === 'string' && parsed.token.length > 0 && !_isTokenExpired(parsed.token)) {
    result.legacyToken = parsed.token;
  }
  return result;
}

function _persistSession(user, cachedAt, sessionExpiresAt) {
  const payload = JSON.stringify({ user, cachedAt, sessionExpiresAt });
  try { localStorage.setItem(AUTH_STORAGE_KEY, payload); } catch { /* storage disabled */ }
  try { sessionStorage.removeItem(AUTH_STORAGE_KEY); } catch { /* legacy cleanup */ }
}

function _clearStoredSession() {
  try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch { /* storage disabled */ }
  try { sessionStorage.removeItem(AUTH_STORAGE_KEY); } catch { /* legacy cleanup */ }
}

function _useCachedSession(parsed) {
  if (parsed?.user && (!parsed.sessionExpiresAt || Date.parse(parsed.sessionExpiresAt) > Date.now() + TOKEN_EXPIRY_SKEW_MS)) {
    _session = { token: null, user: parsed.user };
  } else {
    _session = null;
  }
  _initGoogleButton();
  _updateUI();
  _onSessionReady();
}

function _decodeJwtPayload(token) {
  try {
    const payloadPart = String(token || '').split('.')[1];
    if (!payloadPart) return null;
    const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function _isTokenExpired(token, now = Date.now()) {
  const payload = _decodeJwtPayload(token);
  if (!payload || !Number.isFinite(Number(payload.exp))) return true;
  return Number(payload.exp) * 1000 <= now + TOKEN_EXPIRY_SKEW_MS;
}

function _installStorageListener() {
  if (_storageListenerInstalled) return;
  _storageListenerInstalled = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== AUTH_STORAGE_KEY) return;
    const parsed = _parseStoredSession(event.newValue);
    _session = parsed ? { token: null, user: parsed.user } : null;
    _updateUI();
    _onSessionReady();
  });
}

function _updateUI() {
  const signedOut = document.getElementById('auth-signed-out');
  const signedIn = document.getElementById('auth-signed-in');
  const avatar = document.getElementById('auth-avatar');
  const displayName = document.getElementById('auth-display-name');
  const googleBtn = document.getElementById('google-signin-btn');

  if (!signedOut || !signedIn) return;

  if (_session && _session.user) {
    signedOut.style.display = 'none';
    signedIn.style.display = 'flex';
    if (avatar) avatar.src = _session.user.picture || '';
    if (displayName) {
      displayName.textContent = _session.user.displayName || _session.user.name;
    }
    // Re-render Google button if needed (hide it)
    if (googleBtn) googleBtn.style.display = 'none';
  } else {
    signedOut.style.display = 'flex';
    signedIn.style.display = 'none';
    if (googleBtn) googleBtn.style.display = '';
  }
}

// Hook for page-specific logic after session is ready
function _onSessionReady() {
  window.dispatchEvent(new CustomEvent('kr-auth-ready', {
    detail: { loggedIn: isLoggedIn(), session: _session },
  }));
}
