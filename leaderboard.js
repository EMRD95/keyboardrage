const fmt = new Intl.NumberFormat();
const $ = (id) => document.getElementById(id);

let currentPage = 1;
let currentLang = 'english';
let currentWpm = '101';
let currentMode = 'precision';
let totalPages = 1;

// ── Init ────────────────────────────────────────────────────────

async function init() {
  populateWpmDropdown();
  await loadLanguages();
  bindEvents();
  loadLeaderboard();
}

const WPM_LABELS = {
  '30': '30→∞',
  '50': '50 WPM',
  '100': '100 WPM',
  '101': '100→∞',
  '150': '150 WPM',
  '200': '200 WPM',
  '201': '200→∞',
  '250': '250 WPM',
  '300': '300 WPM',
  '350': '350 WPM',
  '400': '400 WPM',
};

const WPM_OPTIONS = ['30', '50', '100', '101', '150', '200', '201', '250', '300', '350', '400'];

function populateWpmDropdown() {
  const sel = $('lb-wpm');
  for (const w of WPM_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = w;
    opt.textContent = WPM_LABELS[w] || `${w} WPM`;
    if (w === currentWpm) opt.selected = true;
    sel.appendChild(opt);
  }
}

async function loadLanguages() {
  try {
    const res = await fetch('/languages');
    const langs = await res.json();
    const sel = $('lb-lang');
    for (const l of langs) {
      const opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.name || l.code;
      if (l.code === 'english') opt.selected = true;
      sel.appendChild(opt);
    }
  } catch (e) {
    console.error('Failed to load languages', e);
  }
}

function bindEvents() {
  $('lb-lang').addEventListener('change', () => {
    currentLang = $('lb-lang').value;
    currentPage = 1;
    loadLeaderboard();
  });
  $('lb-wpm').addEventListener('change', () => {
    currentWpm = $('lb-wpm').value;
    currentPage = 1;
    loadLeaderboard();
  });
  $('lb-mode').addEventListener('change', () => {
    currentMode = $('lb-mode').value;
    currentPage = 1;
    loadLeaderboard();
  });
  $('lb-prev').addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; loadLeaderboard(); }
  });
  $('lb-next').addEventListener('click', () => {
    if (currentPage < totalPages) { currentPage++; loadLeaderboard(); }
  });
}

// ── Fetch & render ───────────────────────────────────────────────

async function loadLeaderboard() {
  $('lb-error').style.display = 'none';
  const params = new URLSearchParams({ lang: currentLang, page: currentPage, limit: 20 });
    params.set('wpm', currentWpm);
  if (currentMode) params.set('mode', currentMode);

  try {
    const res = await fetch(`/api/leaderboard?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');

    totalPages = Math.max(1, Math.ceil(data.total / data.limit));
    renderTable(data.scores, (currentPage - 1) * data.limit);
    updatePagination(data.total);
    $('lb-info').textContent = `${fmt.format(data.total)} scores found`;
  } catch (e) {
    $('lb-error').textContent = e.message;
    $('lb-error').style.display = 'block';
  }
}

function renderTable(scores, startRank) {
  const tbody = $('lb-tbody');
  const empty = $('lb-empty');
  tbody.innerHTML = '';

  if (!scores.length) {
    empty.style.display = 'block';
    $('lb-table-wrap').querySelector('table').style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  $('lb-table-wrap').querySelector('table').style.display = '';

  scores.forEach((s, i) => {
    const rank = startRank + i + 1;
    const rankClass = rank <= 3 ? ` rank-${rank}` : '';
    const date = s.timestamp ? new Date(s.timestamp).toLocaleDateString() : '—';
    const mode = s.mode || '—';
    const wpm = s.WPM ?? '—';
    const precision = s.precision != null ? `${Number(s.precision).toFixed(1)}%` : '—';

    tbody.innerHTML += `
      <tr>
        <td class="rank${rankClass}">${rank}</td>
        <td class="lb-name" title="${escapeAttr(s.name || '?')}">${escapeHtml(s.name || '?')}</td>
        <td class="lb-score">${fmt.format(s.score || 0)}</td>
        <td class="lb-wpm">${wpm}</td>
        <td>${escapeHtml(mode)}</td>
        <td>${precision}</td>
        <td class="lb-date">${date}</td>
      </tr>`;
  });
}

function updatePagination(total) {
  $('lb-current').textContent = total > 0
    ? `Page ${currentPage} / ${totalPages}`
    : 'No results';
  $('lb-prev').disabled = currentPage <= 1;
  $('lb-next').disabled = currentPage >= totalPages;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

init();
