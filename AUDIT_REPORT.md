# KeyboardRage — Security Audit

Target: `http://localhost:3000` (Express + MongoDB + Google OAuth)
Repo:   `EMRD95/keyboardrage` (HEAD: `a21c3c7` on `develop`)
Date:   2026-05-30
Method: Static source review + live header probes + dependency audit.
        No OAuth flow completed — third-party sign-in path inspected statically.

---

## 1. Executive summary

Confirmed good:
- Zero third-party analytics, trackers, or hidden beacons
- All `fetch()` calls go to same-origin or `localhost:8703` (semantic API)
- No `document.cookie` writes anywhere
- Server-side input validation is thorough (keystrokes, time, typos, mode, WPM, language, precision)
- `.gitignore` properly excludes secrets (`.env`, `.jwt-secret`, `antiCheat.js`, `.mongo-dev-data/`)
- Leaderboard/API responses strip `ip`, `googleId`, `user` fields from public output
- `game-over.js` uses `textContent` not `innerHTML` for player names (XSS-safe)
- `leaderboard.js` uses `escapeHtml()` on display names (XSS-safe)
- OAuth scope is minimal: `openid profile email` (Google GIS defaults)
- `email_verified` enforced before account creation

Gaps (ordered by severity):

1. **[CRITICAL] No security headers.** Zero CSP, no HSTS, no X-Content-Type-Options, no
   Referrer-Policy, no X-Frame-Options. `X-Powered-By: Express` leaks server info.
2. **[HIGH] npm vulnerability: `ip` package.** GHSA-2p57-rm9w-gvfp (SSRF, CVSS 8.1).
   Package is imported but never called — remove immediately.
3. **[HIGH] antiCheat.js fallback to open bypass.** If `antiCheat.js` is missing at deploy
   time, every score passes validation silently.
4. **[MEDIUM] JWT in localStorage.** The `kr_session` token is stored in `localStorage`,
   making it accessible to any XSS. `sessionStorage` or httpOnly cookie would be safer.
5. **[MEDIUM] Email in JWT payload.** User email is embedded in the session JWT and
   exposed via `GET /auth/me`. Consider reducing JWT claims to `sub` + `displayName`.
6. **[MEDIUM] Dead `/token` endpoint + memory leak.** `GET /token` generates tokens
   into an unbounded `tokens[]` array that is never consumed. `fetchToken()` in
   `game.ts` assigns `this.token` which is never used for auth (that uses `kr_session`).
7. **[LOW] No `express-mongo-sanitize`.** Aggregation pipelines use validated inputs
   but defense-in-depth is missing.
8. **[LOW] Font Awesome CDN loaded without `integrity` attribute.**
9. **[LOW] `X-Powered-By: Express` header leaks server fingerprint.**
10. **[LOW] Hardcoded `GOOGLE_CLIENT_ID` in `auth.js`.** While the client ID is public,
    production apps should source it from environment variables for configuration
    flexibility.

Overall fitness: **NOT READY for production. Address items 1-5 before deploy.**

---

## 2. Scope & methodology

Static review:
- Cloned state of `a21c3c7` on `develop` branch.
- Read all JS/TS/HTML files: `server.js`, `auth.js`, `auth-client.js`, `game.ts`,
  `game-over.js`, `leaderboard.js`, `stats.js`, `rateLimiter.js`, `nav-loader.js`,
  `typing-stats.js`.
- Grepped for: `fetch(`, `XMLHttpRequest`, `sendBeacon`, known analytics vendor
  names, hardcoded external hostnames, `document.cookie`, `localStorage`,
  `sessionStorage`, `indexedDB`.

Dynamic review:
- `curl -sD-` for root response headers.
- `curl -sI /token` confirmed dead endpoint still serves.
- `npm audit --json` for dependency vulnerabilities.
- Did NOT complete OAuth (runtime sniffer skipped) — token handling reviewed
  statically from source.

---

## 3. Network map

Same-origin endpoints (all on `localhost:3000`):

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/` | None | Game page (index.html) |
| GET | `/token` | None | **DEAD** — unused token generator |
| GET | `/languages` | None | Supported languages list |
| GET | `/auth/config` | None | Returns `{ googleClientId }` |
| POST | `/auth/google` | None | Google OAuth token exchange |
| GET | `/auth/me` | Bearer | Current user profile |
| POST | `/auth/setup` | Bearer | Set display name |
| POST | `/score` | Bearer+RL | Submit game score |
| GET | `/leaderboard/:lang/:WPM` | None | Legacy leaderboard |
| GET | `/latest-scores` | None | Latest scores feed |
| GET | `/api/leaderboard` | None | New filterable leaderboard |
| GET | `/stats/me` | Bearer | Private user stats |
| GET | `/word-chain/french/*` | None | French ML chain |

External hosts:

| Host | Purpose | Risk |
|------|---------|------|
| `accounts.google.com` | Google Identity Services SDK | Required for OAuth |
| `cdnjs.cloudflare.com` | Font Awesome 5.15.1 CSS | No integrity attr |
| `localhost:8703` | Semantic neighbor API | Internal service, not exposed |

No analytics, no trackers, no telemetry vendors. **Clean.**

---

## 4. Cookie & storage audit

Cookies: **0** — no `document.cookie` writes in source, no `Set-Cookie` headers.
LocalStorage keys written by the app:

| Key | Sensitivity | Assessment |
|-----|------------|------------|
| `kr_session` | **HIGH** — contains JWT with email, displayName | XSS-vulnerable |
| `kr_pending_score` | LOW — queued score payload | Cleared on submit |
| `theme`, `WPM`, `mode`, `language`, `frequencyLimit` | None — game settings | Expected |
| `playerName` | LOW — local alias | Legacy, not auth |
| `semanticSeedId/Word/Lang` | None — UI state | Expected |
| `customYoutubeId` | None — 11-char video ID | Expected |
| `infoPageTheme` | None — UI preference | Expected |
| `precision`, `timeElapsed` | None — game stats | Expected |
| `applyGrammar`, `addNumbers`, `requireDiacritics` | None — settings | Expected |

sessionStorage: minimal usage (if any), no sensitive data.
IndexedDB: not used by the app.
Service workers: none registered.

---

## 5. Third-party SDKs

| SDK | Script URL | Integrity | Notes |
|-----|-----------|-----------|-------|
| Google Identity Services | `https://accounts.google.com/gsi/client` | No (Google rotates) | Acceptable — GIS doesn't support SRI |
| Font Awesome CSS | `https://cdnjs.cloudflare.com/.../all.min.css` | **MISSING** | Add `integrity=sha384-...` |

No other third-party scripts, pixels, iframes, or trackers.

---

## 6. OAuth scope & token handling

Scope: `openid profile email` (Google GIS defaults; not explicitly set in
`initialize()` call in `auth-client.js:106`).

Token verification (`auth.js:43-61`):
- Uses `google-auth-library` → `verifyIdToken()` with audience check
- Rejects if `email_verified !== true`
- Extracts: `sub` (googleId), `email`, `name`, `picture`

Session JWT (`auth.js:68-80`):
- Claims: `sub`, `googleId`, `email`, `name`, `displayName`
- Expiry: 30 days
- Signed with `JWT_SECRET` (env var or `.jwt-secret` file)

Token storage: `localStorage.kr_session` — **XSS-vulnerable.**
Token sent: `Authorization: Bearer <token>` header on `/score`, `/auth/me`,
`/auth/setup`, `/stats/me`.

Token destinations: all same-origin only. Confirmed via grep — no external
hosts appear in `Authorization` header usage.

**Concern:** `GET /auth/me` returns the full user object including `email`.
Anyone with localStorage access (XSS, malicious extension, physical access)
can exfiltrate both the JWT and the user's email address.

---

## 7. Security headers

Response headers for `GET http://localhost:3000/`:

```
HTTP/1.1 200 OK
X-Powered-By: Express
Accept-Ranges: bytes
Cache-Control: public, max-age=0
Content-Type: text/html; charset=UTF-8
```

Missing (all of them):

| Header | Status | Can fix via |
|--------|--------|-------------|
| Content-Security-Policy | MISSING | meta tag or middleware |
| Strict-Transport-Security | MISSING | reverse proxy |
| X-Content-Type-Options | MISSING | meta tag or middleware |
| Referrer-Policy | MISSING | meta tag or middleware |
| X-Frame-Options | MISSING | reverse proxy |
| Cross-Origin-Opener-Policy | MISSING | reverse proxy |
| Cross-Origin-Embedder-Policy | MISSING | reverse proxy |
| Permissions-Policy | MISSING | meta tag or middleware |

`X-Powered-By: Express` should be disabled via `app.disable('x-powered-by')`.

---

## 8. Findings

Legend:  [+] confirmed good    [!] gap / hardening    [i] informational

[!] CRITICAL — Zero security headers. No CSP, HSTS, X-Content-Type-Options,
    Referrer-Policy, or frame protection. A production game handling auth
    tokens and user data must have at minimum a strict CSP and security
    headers. `server.js:23` — static middleware before any middleware setup.

[!] HIGH — `ip` package (CVSS 8.1 SSRF). Imported at `server.js:8` but
    **never called**. The single call site `ip:` uses Express's `req.ip`
    and `x-forwarded-for` directly. Dead vulnerable dependency.

[!] HIGH — `antiCheat.js` fallback to `() => ({ valid: true })` at
    `server.js:652-655`. If the gitignored module is missing at deploy,
    ALL scores pass validation. Production deploy MUST verify this file
    exists or hard-fail.

[!] MEDIUM — JWT token in `localStorage` (`kr_session`). Any XSS can steal
    the token and impersonate the user. Consider `sessionStorage` (shorter
    lifetime) or httpOnly cookie + CSRF token for production.

[!] MEDIUM — User email exposed in JWT payload and `/auth/me` response.
    `signSessionToken()` at `auth.js:68-80` includes `email` in the JWT.
    `userPublicPayload()` at `server.js:138-146` returns email. Reduce
    JWT claims to minimum: `sub`, `displayName` only.

[!] MEDIUM — Dead `/token` endpoint + unbounded `tokens[]` array.
    `server.js:47-52` — generates tokens that are never validated.
    `game.ts:653-661` — `fetchToken()` result stored in `this.token`
    which is never used for actual auth (that uses `kr_session` JWT).
    Memory leak: `tokens` array grows with every anonymous visit.

[+] GOOD — Score input validation is thorough. `server.js:431-485`:
    keystrokes (integer 1–100k), timeElapsed (1s–24h), typos (≤keystrokes),
    mode (whitelist), score (0–300k), language (validated), WPM (validated),
    precision (computed server-side, not trusted from client).

[+] GOOD — Anti-cheat 5-stage validation (when `antiCheat.js` present):
    type sanity, garbage rejection, logical consistency, keystroke
    consistency, WPM-based ceiling + human absolute cap (10 words/sec).

[+] GOOD — IP addresses stripped from all public API responses.
    `server.js:731,773,840` — `ip: 0` in `$project` for leaderboards.

[+] GOOD — `.gitignore` properly excludes secrets: `.env`, `.env.*`,
    `antiCheat.js`, `.jwt-secret`, `.mongo-dev-data/`.

[+] GOOD — `game-over.js` uses `textContent` for all user-controlled data.
    No XSS via injected names/scores.

[+] GOOD — `leaderboard.js` uses `escapeHtml()` on display names.
    `server.js:333` — `sanitizeClientMeta()` for telemetry metadata.

[+] GOOD — Rate limiting: `1 req / 5s / IP` for scores, `10 req / 60s`
    for auth setup.

[+] GOOD — No cookies set, no tracking pixels, no analytics vendors.

[+] GOOD — OAuth scope is minimal (openid profile email). No Gmail, Drive,
    Calendar, or other sensitive scopes.

[+] GOOD — `email_verified` enforced before account creation.

[i] LOW — `express-mongo-sanitize` not installed. Aggregation pipelines
    use validated inputs but defense-in-depth is missing. Documented as
    a recommendation in the project's own security doc at
    `docs/SECURE_LEADERBOARD_ANTI_CHEAT_IMPLEMENTATION.md:784`.

[i] LOW — Font Awesome CSS loaded from cdnjs.cloudflare.com without
    `integrity` attribute. Mitigation: either add SRI hash or serve
    locally from `node_modules/`.

[i] LOW — `GOOGLE_CLIENT_ID` hardcoded in `auth.js:14`. While client IDs
    are public, environment-variable sourcing enables per-environment
    configuration (dev/staging/prod).

[i] LOW — `JWT_EXPIRY = '30d'` is generous. Consider 7d with refresh
    for production.

---

## 9. Recommended fixes

### Fix 1: Security headers via helmet middleware

```bash
npm install helmet
```

In `server.js`, add BEFORE any route handlers:

```js
const helmet = require('helmet');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://accounts.google.com", "https://apis.google.com"],
      connectSrc: ["'self'", "https://www.googleapis.com", "https://accounts.google.com"],
      frameSrc: ["https://accounts.google.com", "https://www.youtube.com"],
      imgSrc: ["'self'", "data:", "https://*.googleusercontent.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'none'"],
    },
  },
  hsts: false, // set via reverse proxy in prod
  xPoweredBy: false,
}));

// Or at minimum:
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
```

### Fix 2: Remove `ip` package

```bash
npm uninstall ip
```

And delete `const ip = require('ip');` from `server.js:8`. It is never used.

### Fix 3: Remove dead `/token` endpoint and `fetchToken()`

Delete `server.js:47-52`:
```js
// REMOVE:
let tokens = [];
app.get('/token', (req, res) => { ... });
```

Delete `game.ts:653-661` (`fetchToken()` method) and its call site.

Delete `this.token` field declaration and the two unused assignments
at `game.ts:232,657,660`.

### Fix 4: Harden antiCheat.js loading

Replace `server.js:651-656`:
```js
try {
    var validateScore = require('./antiCheat');
} catch (err) {
    console.warn(...);
    validateScore = () => ({ valid: true });
}
```

With:
```js
try {
    var validateScore = require('./antiCheat');
} catch (err) {
    if (process.env.NODE_ENV === 'production') {
        console.error('FATAL: antiCheat.js missing in production. Exiting.');
        process.exit(1);
    }
    console.warn('antiCheat.js not found, score validation bypassed (dev only).');
    validateScore = () => ({ valid: true });
}
```

### Fix 5: Move JWT out of localStorage

Option A (simpler): switch to `sessionStorage` — token cleared on tab close.
In `auth-client.js:132`, change `localStorage.setItem('kr_session', ...)` to
`sessionStorage.setItem('kr_session', ...)`. Update all reads accordingly.

Option B (better for production): httpOnly cookie + CSRF token. Requires
middleware changes in `server.js` and a CSRF library.

At minimum: stop including `email` in the JWT payload. Remove `email: user.email`
from `signSessionToken()` at `auth.js:73`.

### Fix 6: Font Awesome integrity

Serve locally from `node_modules/@fortawesome/...` or add SRI:
```html
<link rel="stylesheet"
  href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.1/css/all.min.css"
  integrity="sha384-vp86vTRFVJgpjF9jiIGPEEqYqlDwgyBgEF109VFjmqGmIY/Y4HV4d3Gp2irVfcrp"
  crossorigin="anonymous" />
```

### Fix 7: npm audit fix

```bash
npm update qs --depth 10  # fixes moderate qs DoS
npm uninstall ip           # removes HIGH SSRF (unused)
```

### Fix 8: Optional — express-mongo-sanitize

```bash
npm install express-mongo-sanitize
```

```js
const mongoSanitize = require('express-mongo-sanitize');
app.use(mongoSanitize());
```

---

## 10. Conclusion

KeyboardRage is a **well-architected game** with thoughtful anti-cheat design
and thorough input validation. The authentication flow is correctly scoped and
token handling follows standard patterns.

However, the app is **not production-ready** due to the complete absence of
security headers and two dependency vulnerabilities. The anti-cheat bypass
fallback, dead `/token` endpoint, and JWT-in-localStorage are medium-severity
issues that should be addressed before accepting real user traffic.

**Priority action list:**

1. Install `helmet` and configure CSP + security headers (30 min)
2. Remove `ip` package — unused, HIGH CVE (5 min)
3. Hard-fail on missing `antiCheat.js` in production (5 min)
4. Move `kr_session` to `sessionStorage` + strip email from JWT (15 min)
5. Delete dead `/token` endpoint and `fetchToken()` (10 min)
6. `npm audit fix` + `npm uninstall ip` (5 min)
7. Add Font Awesome integrity hash (2 min)
8. (Optional) Install `express-mongo-sanitize` (5 min)

Total estimated effort: ~75 minutes. Expected outcome: production-ready
security posture for a typing game handling OAuth-authenticated user data.
