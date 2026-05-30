// nav-loader.js — injects the shared nav bar immediately (no network fetch).
// Include with <script src="nav-loader.js" defer></script> on every page.
// Theme toggle and Google sign-in are initialized after injection.

(function () {
  var savedTheme = localStorage.getItem('infoPageTheme') || 'night';
  document.documentElement.dataset.infoTheme = savedTheme;

  var navHTML =
    '<header>' +
    '  <div class="header-container">' +
    '    <a href="/index.html" id="home-icon-link">' +
    '      <i class="fas fa-home"></i>' +
    '    </a>' +
    '    <a href="https://github.com/EMRD95/keyboardrage/" id="github-icon-link" target="_blank">' +
    '      <i class="fab fa-github"></i>' +
    '    </a>' +
    '    <a href="/faq.html" id="faq-link">' +
    '      <i class="fas fa-question-circle"></i>' +
    '      FAQ' +
    '    </a>' +
    '    <a href="/data-visualization.html" id="data-viz-link">' +
    '      <i class="fas fa-project-diagram"></i>' +
    '      Data Viz' +
    '    </a>' +
    '    <a href="/leaderboard.html" id="leaderboard-link">' +
    '      <i class="fas fa-trophy"></i>' +
    '      Leaderboard' +
    '    </a>' +
    '    <button type="button" id="info-theme-toggle" class="info-theme-toggle" aria-label="Switch to day theme" title="Switch theme">' +
    (savedTheme === 'night' ? '☀' : '☾') +
    '    </button>' +
    '    <span class="header-spacer"></span>' +
    '    <span id="auth-signed-out" class="header-auth">' +
    '      <span class="auth-hint">Sign in to save scores</span>' +
    '      <span id="google-signin-btn"></span>' +
    '    </span>' +
    '    <span id="auth-signed-in" class="header-auth" style="display:none">' +
    '      <img id="auth-avatar" class="auth-avatar-sm" src="" alt="" width="24" height="24">' +
    '      <span id="auth-display-name" class="auth-display-name"></span>' +
    '      <a href="/account.html" class="auth-account-link" title="My Account"><i class="fas fa-user-cog"></i></a>' +
    '      <a href="/stats.html" class="auth-account-link" title="My Stats">Stats</a>' +
    '      <button id="auth-signout" class="auth-signout-btn" title="Sign out">✕</button>' +
    '    </span>' +
    '  </div>' +
    '</header>';

  document.body.insertAdjacentHTML('afterbegin', navHTML);

  // Footer — injected after header on every info page
  var footerHTML =
    '<footer class="page-footer">' +
    '  <a href="/privacy.html">Privacy</a>' +
    '  <span class="footer-sep">|</span>' +
    '  <a href="/terms.html">Terms</a>' +
    '</footer>';
  document.body.insertAdjacentHTML('beforeend', footerHTML);

  // Theme toggle
  var toggle = document.getElementById('info-theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var current = document.documentElement.dataset.infoTheme;
      var next = current === 'night' ? 'day' : 'night';
      document.documentElement.dataset.infoTheme = next;
      localStorage.setItem('infoPageTheme', next);
      toggle.textContent = next === 'night' ? '☀' : '☾';
      toggle.setAttribute('aria-label', next === 'night' ? 'Switch to day theme' : 'Switch to night theme');
    });
  }

  // Initialize Google sign-in
  import('./auth-client.js').then(function (mod) {
    mod.initAuth();
  }).catch(function () {});
})();
