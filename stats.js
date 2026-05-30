import { initAuth, getSession } from './auth-client.js';

const fmt = new Intl.NumberFormat();
const $ = (id) => document.getElementById(id);
let lastStats = null;
let activeRange = '7';
let unifiedChart = null;

function formatDuration(ms) {
  const seconds = Math.floor((ms || 0) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${seconds % 60}s`;
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function renderTable(id, rows, columns, emptyText) {
  const tbody = $(id);
  tbody.innerHTML = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = columns.length;
    td.textContent = emptyText;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  rows.forEach(row => {
    const tr = document.createElement('tr');
    columns.forEach(fn => {
      const td = document.createElement('td');
      td.textContent = fn(row);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

async function loadStats() {
  const session = getSession();
  if (!session?.token) {
    window.location.href = '/index.html';
    return null;
  }
  const res = await fetch('/stats/me', { headers: { Authorization: `Bearer ${session.token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load stats');
  return data;
}

function filteredSessions(data) {
  const sessions = [...(data.recentSessions || [])]
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  if (activeRange === 'all') return sessions;
  const days = Number(activeRange);
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
  return sessions.filter(session => new Date(session.timestamp).getTime() >= cutoff);
}

function sessionLabel(session) {
  const date = new Date(session.timestamp);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function buildDatasets(sessions) {
  return [
    {
      label: 'Score',
      data: sessions.map(s => s.score || 0),
      borderColor: '#7df9ff',
      backgroundColor: 'rgba(125,249,255,.18)',
      yAxisID: 'score',
      tension: .32,
      pointRadius: 4,
      pointHoverRadius: 7,
    },
    {
      label: 'Burst WPM',
      data: sessions.map(s => s.telemetrySummary?.burstWpm || 0),
      borderColor: '#ff4fd8',
      backgroundColor: 'rgba(255,79,216,.16)',
      yAxisID: 'speed',
      tension: .32,
      pointRadius: 4,
      pointHoverRadius: 7,
    },
    {
      label: 'Consistency %',
      data: sessions.map(s => s.telemetrySummary?.consistencyScore || 0),
      borderColor: '#ffe66d',
      backgroundColor: 'rgba(255,230,109,.14)',
      yAxisID: 'percent',
      tension: .32,
      pointRadius: 4,
      pointHoverRadius: 7,
    },
    {
      label: 'Precision %',
      data: sessions.map(s => Number(s.precision || 0)),
      borderColor: '#8cff85',
      backgroundColor: 'rgba(140,255,133,.14)',
      yAxisID: 'percent',
      tension: .32,
      pointRadius: 3,
      pointHoverRadius: 6,
      hidden: true,
    },
    {
      label: 'Typos',
      data: sessions.map(s => s.typos || 0),
      borderColor: '#b388ff',
      backgroundColor: 'rgba(179,136,255,.12)',
      yAxisID: 'count',
      tension: .25,
      pointRadius: 3,
      pointHoverRadius: 6,
      hidden: true,
    },
  ];
}

function renderUnifiedChart(data) {
  const Chart = window.Chart;
  if (!Chart) throw new Error('Chart.js failed to load');
  const canvas = $('unified-chart');
  const sessions = filteredSessions(data);
  const labels = sessions.map(sessionLabel);
  const datasets = buildDatasets(sessions);

  if (unifiedChart) {
    unifiedChart.data.labels = labels;
    unifiedChart.data.datasets.forEach((dataset, i) => {
      dataset.data = datasets[i].data;
    });
    unifiedChart.update();
    return;
  }

  unifiedChart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { color: 'rgba(255,255,255,.82)', usePointStyle: true, boxWidth: 10, boxHeight: 10 },
        },
        tooltip: {
          enabled: true,
          backgroundColor: 'rgba(5,8,16,.94)',
          borderColor: 'rgba(255,255,255,.16)',
          borderWidth: 1,
          padding: 12,
          callbacks: {
            afterTitle(items) {
              const session = sessions[items[0].dataIndex];
              if (!session) return '';
              return `${session.language} / ${session.WPM} WPM / ${session.mode}`;
            },
            label(context) {
              const label = context.dataset.label || '';
              const value = context.parsed.y;
              if (label.includes('%')) return `${label}: ${Number(value).toFixed(1)}%`;
              if (label.includes('WPM')) return `${label}: ${Number(value).toFixed(1)}`;
              return `${label}: ${fmt.format(value)}`;
            },
            afterBody(items) {
              const session = sessions[items[0].dataIndex];
              if (!session) return '';
              return `Time: ${formatDuration(session.timeElapsed)} | Keys: ${fmt.format(session.keystrokes || 0)}`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: 'rgba(255,255,255,.58)', maxRotation: 0, autoSkip: true }, grid: { color: 'rgba(255,255,255,.06)' } },
        score: { type: 'linear', position: 'left', beginAtZero: true, ticks: { color: '#7df9ff' }, grid: { color: 'rgba(255,255,255,.08)' } },
        speed: { type: 'linear', position: 'right', beginAtZero: true, ticks: { color: '#ff4fd8' }, grid: { drawOnChartArea: false } },
        percent: { type: 'linear', position: 'right', min: 0, max: 100, display: false, grid: { drawOnChartArea: false } },
        count: { type: 'linear', position: 'right', beginAtZero: true, display: false, grid: { drawOnChartArea: false } },
      },
    },
  });
}

function renderStats(data) {
  lastStats = data;
  $('stats-error').style.display = 'none';
  setText('stats-subtitle', `${data.user.displayName || data.user.name} — private stats, visible only to you.`);
  setText('stat-level', `Level ${data.level.level}/100`);
  $('level-fill').style.width = `${data.level.progressToNextLevel}%`;
  setText('level-copy', `${fmt.format(data.level.uniqueWordsTyped)} unique words typed / ${fmt.format(data.level.totalWords)} total corpus words. ${fmt.format(data.level.wordsRemainingForNextLevel)} words until next level.`);
  setText('stat-time', formatDuration(data.totals.totalPlayTimeMs));
  setText('stat-games', fmt.format(data.totals.totalGames));
  setText('stat-best', fmt.format(data.totals.bestScore));
  setText('stat-consistency', `${Math.round(data.totals.averageConsistency || 0)}%`);
  setText('stat-burst', `${Math.round(data.totals.maxBurstWpm || 0)} WPM`);
  setText('stat-keys', fmt.format(data.totals.totalKeystrokes));
  setText('stat-typos', fmt.format(data.totals.totalTypos));

  renderUnifiedChart(data);

  renderTable('best-table', data.bestScores || [], [
    r => fmt.format(r.score),
    r => r.language,
    r => String(r.WPM),
    r => `${Number(r.precision || 0).toFixed(1)}%`,
    r => new Date(r.timestamp).toLocaleDateString(),
  ], 'No ranked score yet.');

  renderTable('language-table', data.byLanguage || [], [
    r => r.language,
    r => fmt.format(r.games),
    r => formatDuration(r.playTimeMs),
    r => fmt.format(r.bestScore),
    r => `${Math.round(r.averageConsistency || 0)}%`,
  ], 'No language stats yet.');
}

async function refresh() {
  try {
    const data = await loadStats();
    if (data) renderStats(data);
  } catch (error) {
    $('stats-error').textContent = error.message;
    $('stats-error').style.display = 'block';
  }
}

for (const button of document.querySelectorAll('.range-pill')) {
  button.addEventListener('click', () => {
    activeRange = button.dataset.range || '7';
    document.querySelectorAll('.range-pill').forEach(btn => btn.classList.toggle('active', btn === button));
    if (lastStats) renderUnifiedChart(lastStats);
  });
}

$('refresh-stats').addEventListener('click', refresh);
window.addEventListener('kr-auth-ready', ({ detail }) => {
  if (!detail.loggedIn) {
    window.location.href = '/index.html';
    return;
  }
  refresh();
});

initAuth();
