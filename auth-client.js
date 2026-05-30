// auth-client.js — Google Sign-In + session management (frontend)
// Uses Google Identity Services (GIS) "Sign In With Google".
// Redirects to /account.html on first login if no displayName is set.

const AUTH_STORAGE_KEY = 'kr_session';

let _session = null; // { token, user: { id, email, name, picture, displayName } }
let _initialized = false;

// ── Public API ──────────────────────────────────────────────────

export function getSession() {
  return _session;
}

export function isLoggedIn() {
  return _session !== null && _session.token !== null;
}

export function getDisplayName() {
  return _session?.user?.displayName || _session?.user?.name || null;
}

/** Initialize Google Sign-In and restore saved session. */
export async function initAuth() {
  if (_initialized) return;
  _initialized = true;

  // 1. Restore saved session
  const saved = localStorage.getItem(AUTH_STORAGE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      const resp = await fetch('/auth/me', {
        headers: { Authorization: `Bearer ${parsed.token}` },
      });
      if (resp.ok) {
        const user = await resp.json();
        _session = { token: parsed.token, user };
        _updateUI();
        _onSessionReady();
      } else {
        // Only clear on explicit 401 (expired/invalid), not on network errors
        if (resp.status === 401) localStorage.removeItem(AUTH_STORAGE_KEY);
      }
    } catch {
      // Network error — keep session, retry next page load
    }
  }

  // 2. Fetch Google Client ID
  let clientId;
  try {
    const cfg = await fetch('/auth/config').then(r => r.json());
    clientId = cfg.googleClientId;
  } catch {
    console.warn('Could not fetch Google Client ID');
    return;
  }

  // 3. Load GIS
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

  // 4. Initialize button
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

  // 5. Sign out button
  document.getElementById('auth-signout')?.addEventListener('click', signOut);

  _updateUI();
  if (!_session) _onSessionReady(); // call even if not logged in
}

/** Sign out. */
export function signOut() {
  _session = null;
  localStorage.removeItem(AUTH_STORAGE_KEY);
  if (window.google?.accounts?.id) {
    window.google.accounts.id.disableAutoSelect();
  }
  _updateUI();
}

// ── Internals ───────────────────────────────────────────────────

async function handleGoogleResponse(response) {
  try {
    const res = await fetch('/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Auth failed');
    }

    const data = await res.json();
    _session = { token: data.token, user: data.user };
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(_session));
    _updateUI();

    // Redirect to account setup if no displayName
    if (!data.user.displayName) {
      window.location.href = '/account.html';
    } else {
      _onSessionReady();
    }
  } catch (err) {
    console.error('Google sign-in error:', err);
    alert('Sign-in failed. Try again.');
  }
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
