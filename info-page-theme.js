(() => {
  const STORAGE_KEY = 'infoPageTheme';
  const VALID_THEMES = new Set(['night', 'day']);

  function currentTheme() {
    const saved = localStorage.getItem(STORAGE_KEY);
    return VALID_THEMES.has(saved) ? saved : 'night';
  }

  function applyTheme(theme) {
    const normalized = VALID_THEMES.has(theme) ? theme : 'night';
    document.documentElement.dataset.infoTheme = normalized;
    localStorage.setItem(STORAGE_KEY, normalized);

    const toggle = document.getElementById('info-theme-toggle');
    if (toggle) {
      const isNight = normalized === 'night';
      toggle.textContent = isNight ? '☀' : '☾';
      toggle.setAttribute('aria-label', isNight ? 'Switch to day theme' : 'Switch to night theme');
      toggle.setAttribute('title', isNight ? 'Switch to day theme' : 'Switch to night theme');
      toggle.setAttribute('aria-pressed', String(!isNight));
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(currentTheme());
    const toggle = document.getElementById('info-theme-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', () => {
      applyTheme(currentTheme() === 'night' ? 'day' : 'night');
    });
  });
})();
