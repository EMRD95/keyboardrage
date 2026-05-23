#!/usr/bin/env python3
"""
Generate a galaxy-style 3D visualization of all word embeddings.
Outputs:
  - galaxy.html       (Three.js visualization, loads data via fetch)
  - galaxy_data.bin   (compact binary: Float32 xyz + Uint8 rgb per point)
  - galaxy_meta.json  (language labels, word counts, color assignments)

Usage:
  python3 generate_galaxy.py
  python3 -m http.server 8888 --directory /home/ubu/Desktop/keyboardrage
  # Then open http://localhost:8888/galaxy.html
"""

import json
import glob
import os
import struct
import numpy as np
from pathlib import Path

WORDS_EMB_DIR = Path(os.environ.get("KEYBOARDRAGE_WORDS_EMB_DIR", str(Path(__file__).parent.parent.parent / "words_emb")))
OUT_DIR = Path(__file__).parent
BIN_FILE = OUT_DIR / "galaxy_data.bin"
META_FILE = OUT_DIR / "galaxy_meta.json"
HTML_FILE = OUT_DIR / "galaxy.html"

# Multi-word base languages that need explicit grouping
MULTI_WORD_BASES = [
    "chinese_simplified", "chinese_traditional",
    "norwegian_nynorsk",
    "armenian_western",
    "swiss_german",
    "serbian_latin",
    "ukrainian_latynka",
    "belarusian_lacinka",
    "esperanto_h_sistemo", "esperanto_x_sistemo",
    "tatar_crimean_cyrillic", "tatar_crimean",
    "arabic_egypt", "arabic_morocco",
    "japanese_romaji", "japanese_hiragana", "japanese_katakana",
    "portuguese_acentos_e_cedilha",
]


def get_base_lang(filename):
    """Extract base language name from a words_emb filename."""
    name = filename.replace('.json', '')
    # Check longest multi-word base first
    for base in MULTI_WORD_BASES:
        suffix = name[len(base):]
        if name.startswith(base) and (suffix == '' or suffix.startswith('_')):
            return base
    # Default: first word
    return name.split('_')[0]


def load_all_embeddings():
    """Load all words and embeddings from all language files."""
    files = sorted(glob.glob(str(WORDS_EMB_DIR / "*.json")))
    all_points = []  # (x, y, z)
    all_colors = []  # (r, g, b) 0-255
    all_words = []   # word string
    all_groups = []  # group index (replaces all_langs)
    lang_counts = {}  # per-file counts (for backward compat)

    # Build file → group mapping
    group_map = {}  # base_lang → group_index
    group_names = []  # ordered list of base_lang names
    group_file_counts = {}  # group_index → total word count
    file_to_group = {}  # filename → group_index

    for f in files:
        lang = os.path.basename(f).replace('.json', '')
        base = get_base_lang(lang)
        if base not in group_map:
            group_map[base] = len(group_names)
            group_names.append(base)
            group_file_counts[len(group_names) - 1] = 0
        file_to_group[lang] = group_map[base]

    n_groups = len(group_names)
    print(f"Loading {len(files)} files → {n_groups} language groups...")

    # First pass: count words per language group. Colors are assigned by rank so
    # the largest languages get deliberately distinct colors instead of adjacent
    # alphabetical hues that are hard to tell apart.
    for f in files:
        lang = os.path.basename(f).replace('.json', '')
        d = json.load(open(f))
        words = d.get("words", [])
        n = len(words)
        lang_counts[lang] = n
        group_file_counts[file_to_group[lang]] += n

    ranked_group_indices = sorted(range(n_groups), key=lambda i: group_file_counts[i], reverse=True)
    rank_by_group_index = {gi: rank for rank, gi in enumerate(ranked_group_indices)}

    # Top-10 palette: colorblind-friendly, high-contrast on black, intentionally
    # separated in hue/luminance. Remaining languages use a softer golden-angle
    # palette so the top 10 remain visually dominant.
    top10_palette = [
        (230, 25, 75),    # red
        (60, 180, 75),    # green
        (0, 130, 200),    # blue
        (245, 130, 48),   # orange
        (145, 30, 180),   # purple
        (70, 240, 240),   # cyan
        (240, 50, 230),   # magenta
        (210, 245, 60),   # lime
        (250, 190, 190),  # pink
        (255, 225, 25),   # yellow
    ]
    import colorsys
    color_map = {}
    hue_map = {}
    for gi in range(n_groups):
        rank = rank_by_group_index[gi]
        name = group_names[gi]
        if rank < len(top10_palette):
            color_map[name] = top10_palette[rank]
            r, g, b = [c / 255 for c in top10_palette[rank]]
            hue_map[name] = colorsys.rgb_to_hls(r, g, b)[0]
        else:
            hue = ((rank - len(top10_palette)) * 0.61803398875) % 1.0
            r, g, b = colorsys.hls_to_rgb(hue, 0.38, 0.70)
            color_map[name] = (int(r * 255), int(g * 255), int(b * 255))
            hue_map[name] = hue

    for fi, f in enumerate(files):
        lang = os.path.basename(f).replace('.json', '')
        d = json.load(open(f))
        words = d.get("words", [])
        n = len(words)
        gi = file_to_group[lang]
        ri, gi_b, bi = color_map[group_names[gi]]

        for w in words:
            emb = w.get("embedding_3d", [])
            if len(emb) == 3:
                all_points.append(emb)
                all_colors.append((ri, gi_b, bi))
                all_words.append(w.get("word", ""))
                all_groups.append(gi)

        if (fi + 1) % 50 == 0 or fi == len(files) - 1:
            print(f"  [{fi+1}/{len(files)}] {lang} → {group_names[gi]} ({n} words, total: {len(all_points):,})")

    return all_points, all_colors, all_words, all_groups, lang_counts, hue_map, group_names, group_file_counts

def write_binary(points, colors, lang_indices):
    """Write compact binary: float32 xyz + uint8 rgb + uint8 langIdx per point."""
    n = len(points)
    print(f"Writing {n:,} points to {BIN_FILE}...")
    with open(BIN_FILE, 'wb') as f:
        # Header: uint32 point count, uint16 num_languages, uint16 padding (for 4-byte alignment)
        n_langs = max(lang_indices) + 1 if lang_indices else 0
        f.write(struct.pack('<I', n))
        f.write(struct.pack('<HH', n_langs, 0))  # 8 bytes total, aligned
        # XYZ as float32 array (contiguous for GPU upload)
        xyz = np.array(points, dtype=np.float32)
        f.write(xyz.tobytes())
        # RGB as uint8 array (contiguous)
        rgb = np.array(colors, dtype=np.uint8)
        f.write(rgb.tobytes())
        # Pad to even byte boundary for uint16 alignment
        if (n * 3) % 2 != 0:
            f.write(b'\x00')
        # Language index as uint16 array (311 languages > uint8 max 255)
        langs = np.array(lang_indices, dtype=np.uint16)
        f.write(langs.tobytes())
    size_mb = os.path.getsize(BIN_FILE) / (1024 * 1024)
    print(f"  Binary file: {size_mb:.1f} MB")

def write_meta(group_names, group_file_counts, hue_map, n_points):
    """Write metadata JSON with grouped language info."""
    import colorsys
    lang_list = []
    ranked_group_indices = sorted(range(len(group_names)), key=lambda i: group_file_counts[i], reverse=True)
    top10_palette = [
        (230, 25, 75), (60, 180, 75), (0, 130, 200), (245, 130, 48), (145, 30, 180),
        (70, 240, 240), (240, 50, 230), (210, 245, 60), (250, 190, 190), (255, 225, 25),
    ]
    rank_by_group_index = {gi: rank for rank, gi in enumerate(ranked_group_indices)}
    for i in ranked_group_indices:
        name = group_names[i]
        rank = rank_by_group_index[i]
        if rank < len(top10_palette):
            r, g, b = top10_palette[rank]
        else:
            h = hue_map[name]
            rf, gf, bf = colorsys.hls_to_rgb(h, 0.38, 0.70)
            r, g, b = int(rf * 255), int(gf * 255), int(bf * 255)
        lang_list.append({
            "index": i,
            "rank": rank + 1,
            "name": name,
            "count": group_file_counts[i],
            "color": f"rgb({r},{g},{b})"
        })

    meta = {
        "total_points": n_points,
        "languages": lang_list
    }
    with open(META_FILE, 'w') as f:
        json.dump(meta, f)
    print(f"  Meta file: {os.path.getsize(META_FILE)/1024:.0f} KB")

def write_html():
    """Write the Three.js galaxy visualization HTML."""
    html = r'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>KeyboardRage Galaxy — Word Embeddings</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #000; overflow: hidden; font-family: 'Courier New', monospace; color: #0f0; }
#info {
  position: fixed; top: 10px; left: 10px; z-index: 100;
  background: rgba(0,0,0,0.8); padding: 10px 14px; border: 1px solid #0f03;
  border-radius: 4px; font-size: 12px; pointer-events: none;
}
#info .count { color: #0f0; font-size: 14px; }
#info .hint { color: #0f06; margin-top: 4px; }
#loading {
  position: fixed; top: 0; left: 0; width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  background: #000; z-index: 1000; flex-direction: column;
}
#loading .bar { width: 300px; height: 4px; background: #111; margin-top: 16px; border-radius: 2px; }
#loading .bar-fill { height: 100%; background: #0f0; width: 0%; transition: width 0.3s; border-radius: 2px; }
#loading p { color: #0f0; font-size: 14px; }
#tooltip {
  position: fixed; display: none; background: rgba(0,0,0,0.9);
  border: 1px solid #0f06; padding: 6px 10px; border-radius: 3px;
  font-size: 11px; color: #0f0; pointer-events: none; z-index: 200;
  max-width: 300px;
}
#lang-panel {
  position: fixed; top: 10px; right: 10px; z-index: 100;
  background: rgba(0,0,0,0.85); padding: 10px 14px; border: 1px solid #0f03;
  border-radius: 4px; font-size: 11px; max-height: 80vh; overflow-y: auto;
  min-width: 180px;
}
#lang-panel h3 { color: #0f0; margin-bottom: 6px; font-size: 12px; }
#lang-panel .lang-item { padding: 2px 0; display: flex; align-items: center; gap: 6px; }
#lang-panel .lang-item:hover { color: #fff; }
#lang-panel .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
#lang-panel .lang-count { color: #0f06; margin-left: auto; }
#toggle-langs {
  position: fixed; top: 10px; right: 10px; z-index: 101;
  background: rgba(0,0,0,0.85); border: 1px solid #0f03;
  color: #0f0; font-family: 'Courier New', monospace; font-size: 12px;
  padding: 6px 10px; border-radius: 4px; cursor: pointer;
  display: none;
}
#toggle-langs:hover { border-color: #0f06; color: #fff; }

#toggle-neighbors {
  position: fixed; bottom: 10px; right: 10px; z-index: 101;
  background: rgba(0,0,0,0.85); border: 1px solid #0f03;
  color: #0f0; font-family: 'Courier New', monospace; font-size: 12px;
  padding: 6px 10px; border-radius: 4px; cursor: pointer;
}
#toggle-neighbors:hover { border-color: #0f08; color: #fff; }
#neighbor-panel {
  position: fixed; bottom: 10px; left: 10px; right: 10px; max-height: 34vh; z-index: 110;
  background: rgba(0,0,0,0.92); border: 1px solid #0f04; border-radius: 4px;
  color: #bfffbf; font-size: 11px; display: none; overflow: hidden;
  box-shadow: 0 0 18px rgba(0,255,0,0.08);
}
#neighbor-header { display:flex; align-items:center; gap:10px; padding:8px 10px; border-bottom:1px solid #0f03; }
#neighbor-title { color:#fff; font-weight:bold; flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
#neighbor-panel button, #neighbor-panel select, #neighbor-panel input {
  background:#020; border:1px solid #0f04; color:#0f0; font:11px 'Courier New',monospace;
  padding:2px 5px; border-radius:3px;
}
#neighbor-panel input { width:54px; }
#neighbor-panel label { display:flex; align-items:center; gap:4px; color:#0f9; }
#neighbor-status { color:#ffb; padding:0 10px 6px 10px; }
#neighbor-table-wrap { overflow:auto; max-height: calc(34vh - 72px); }
#neighbor-table { width:100%; border-collapse:collapse; table-layout:fixed; }
#neighbor-table th, #neighbor-table td { border-bottom:1px solid #0f02; padding:4px 6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#neighbor-table th { position:sticky; top:0; background:#020; color:#8f8; text-align:left; z-index:1; }
#neighbor-table tr:hover { background:rgba(0,255,0,0.10); cursor:pointer; }
#neighbor-table .num { text-align:right; color:#efe; font-variant-numeric: tabular-nums; }

</style>
</head>
<body>
<div id="loading">
  <p id="load-text">Loading galaxy data...</p>
  <div class="bar"><div class="bar-fill" id="load-bar"></div></div>
</div>
<div id="info">
  <div class="count" id="point-count">—</div>
  <div class="hint">Drag to orbit · Scroll to zoom · Right-drag to pan</div>
</div>
<div id="tooltip"></div>
<button id="toggle-langs">☰ Languages</button>
<div id="lang-panel"><h3 id="lang-header">Languages ▾</h3><div id="lang-list"></div></div>

<button id="toggle-neighbors">Semantic neighbors: off</button>
<div id="neighbor-panel">
  <div id="neighbor-header">
    <div id="neighbor-title">Semantic neighbors</div>
    <label>K <input id="neighbor-k" type="number" min="1" max="200" value="10"></label>
    <label>filter
      <select id="neighbor-language">
        <option value="all">all</option>
        <option value="same">same language</option>
        <option value="cross">cross-language</option>
      </select>
    </label>
    <label><input id="neighbor-lines" type="checkbox" checked> lines</label>
    <label><input id="neighbor-table-toggle" type="checkbox" checked> table</label>
    <button id="neighbor-refresh">refresh</button>
    <button id="neighbor-close">hide</button>
  </div>
  <div id="neighbor-status">Click a point to query original-embedding semantic neighbors. Backend: http://localhost:8703</div>
  <div id="neighbor-table-wrap"><table id="neighbor-table"></table></div>
</div>


<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
  }
}
</script>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const DBLCLICK_MS = 300;
let lastClickTime = 0;

async function main() {
  const loadBar = document.getElementById('load-bar');
  const loadText = document.getElementById('load-text');

  // Fetch binary data
  loadText.textContent = 'Downloading galaxy_data.bin...';
  const resp = await fetch('galaxy_data.bin');
  const totalBytes = parseInt(resp.headers.get('content-length') || '0');
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (totalBytes) {
      loadBar.style.width = (received / totalBytes * 100) + '%';
    }
  }

  // Concatenate chunks
  const allData = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    allData.set(chunk, offset);
    offset += chunk.length;
  }

  loadText.textContent = 'Parsing data...';
  loadBar.style.width = '100%';

  // Parse: header (uint32 count + uint16 nLangs) + float32 xyz + uint8 rgb + uint8 langIdx
  const view = new DataView(allData.buffer);
  const n = view.getUint32(0, true);
  const nLangs = view.getUint16(4, true);
  document.getElementById('point-count').textContent = n.toLocaleString() + ' words';

  const xyzStart = 8;
  const xyzBytes = n * 3 * 4;
  const rgbStart = xyzStart + xyzBytes;
  const langStart = rgbStart + n * 3 + ((n * 3) % 2); // +1 if padding byte added

  const xyz = new Float32Array(allData.buffer, xyzStart, n * 3);
  const rgb = new Uint8Array(allData.buffer, rgbStart, n * 3);
  const langIdx = new Uint16Array(allData.buffer, langStart, n);

  // Center and scale the data
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    cx += xyz[i*3]; cy += xyz[i*3+1]; cz += xyz[i*3+2];
  }
  cx /= n; cy /= n; cz /= n;

  let maxDist = 0;
  for (let i = 0; i < n; i++) {
    const dx = xyz[i*3]-cx, dy = xyz[i*3+1]-cy, dz = xyz[i*3+2]-cz;
    const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (d > maxDist) maxDist = d;
  }
  const scale = 100 / maxDist;

  loadText.textContent = 'Building galaxy...';

  // Three.js setup
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  // Subtle fog for depth
  scene.fog = new THREE.FogExp2(0x000000, 0.003);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 30, 120);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.minDistance = 5;
  controls.maxDistance = 500;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.3;

  // Build geometry
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  // Keep original colors for toggle restore
  const baseColors = new Float32Array(n * 3);

  for (let i = 0; i < n; i++) {
    positions[i*3]   = (xyz[i*3]   - cx) * scale;
    positions[i*3+1] = (xyz[i*3+1] - cy) * scale;
    positions[i*3+2] = (xyz[i*3+2] - cz) * scale;
    const r = rgb[i*3] / 255, g = rgb[i*3+1] / 255, b = rgb[i*3+2] / 255;
    colors[i*3] = r; colors[i*3+1] = g; colors[i*3+2] = b;
    baseColors[i*3] = r; baseColors[i*3+1] = g; baseColors[i*3+2] = b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // Galaxy-style material: small points, normal blending preserves distinct colors
  const material = new THREE.PointsMaterial({
    size: 0.12,
    vertexColors: true,
    transparent: true,
    opacity: 0.75,
    blending: THREE.NormalBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geometry, material);
  scene.add(points);

  // Ambient glow — a few dim point lights for atmosphere
  const ambientLight = new THREE.AmbientLight(0x111111);
  scene.add(ambientLight);

  // Semantic neighbor overlay: tiny dynamic geometries, independent from the 2.8M base cloud.
  const neighborLineGeom = new THREE.BufferGeometry();
  const neighborLineMat = new THREE.LineBasicMaterial({ color: 0xffcc33, transparent: true, opacity: 0.72, depthWrite: false });
  const neighborLinesObj = new THREE.LineSegments(neighborLineGeom, neighborLineMat);
  scene.add(neighborLinesObj);

  const neighborMarkerGeom = new THREE.BufferGeometry();
  const neighborMarkerMat = new THREE.PointsMaterial({ size: 0.9, vertexColors: true, transparent: true, opacity: 1.0, depthWrite: false, sizeAttenuation: true });
  const neighborMarkersObj = new THREE.Points(neighborMarkerGeom, neighborMarkerMat);
  scene.add(neighborMarkersObj);


  // Load language metadata for panel — with per-language toggle checkboxes
  const langVisible = new Uint8Array(512).fill(1); // track visible langs (max 512)
  const colorAttr = geometry.getAttribute('color');

  function applyLangVisibility() {
    for (let i = 0; i < n; i++) {
      const li = langIdx[i];
      if (langVisible[li]) {
        colors[i*3]   = baseColors[i*3];
        colors[i*3+1] = baseColors[i*3+1];
        colors[i*3+2] = baseColors[i*3+2];
      } else {
        colors[i*3] = 0; colors[i*3+1] = 0; colors[i*3+2] = 0;
      }
    }
    colorAttr.needsUpdate = true;
  }

  try {
    const metaResp = await fetch('galaxy_meta.json');
    const meta = await metaResp.json();

    const langList = document.getElementById('lang-list');

    // All / None quick buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;';
    const btnAll = document.createElement('button');
    btnAll.textContent = 'All';
    const btnNone = document.createElement('button');
    btnNone.textContent = 'None';
    [btnAll, btnNone].forEach(b => {
      b.style.cssText = 'background:transparent;border:1px solid #0f04;color:#0f0;font:11px Courier New,monospace;padding:2px 8px;border-radius:3px;cursor:pointer;flex:1;';
      b.onmouseenter = () => b.style.borderColor = '#0f08';
      b.onmouseleave = () => b.style.borderColor = '#0f04';
    });
    btnRow.appendChild(btnAll);
    btnRow.appendChild(btnNone);
    langList.appendChild(btnRow);

    const checkboxes = [];

    meta.languages.forEach(lang => {
      const div = document.createElement('div');
      div.className = 'lang-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.style.cssText = 'accent-color:#0f0;cursor:pointer;margin:0;';
      cb.dataset.langIdx = lang.index;
      checkboxes.push(cb);

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = lang.color;

      const nameSpan = document.createElement('span');
      nameSpan.textContent = lang.name.replace(/_/g, ' ');
      nameSpan.style.flex = '1';

      const countSpan = document.createElement('span');
      countSpan.className = 'lang-count';
      countSpan.textContent = lang.count.toLocaleString();

      cb.addEventListener('change', () => {
        langVisible[lang.index] = cb.checked ? 1 : 0;
        applyLangVisibility();
      });

      div.appendChild(cb);
      div.appendChild(swatch);
      div.appendChild(nameSpan);
      div.appendChild(countSpan);
      langList.appendChild(div);
    });

    btnAll.addEventListener('click', () => {
      checkboxes.forEach(cb => { cb.checked = true; langVisible[cb.dataset.langIdx] = 1; });
      applyLangVisibility();
    });
    btnNone.addEventListener('click', () => {
      checkboxes.forEach(cb => { cb.checked = false; langVisible[cb.dataset.langIdx] = 0; });
      applyLangVisibility();
    });

  } catch(e) {
    console.warn('Could not load meta:', e);
  }

  // Toggle language panel visibility (collapse/expand the sidebar)
  const langPanel = document.getElementById('lang-panel');
  const langHeader = document.getElementById('lang-header');
  const toggleBtn = document.getElementById('toggle-langs');
  let panelOpen = true;

  langHeader.style.cursor = 'pointer';
  langHeader.addEventListener('click', () => {
    panelOpen = false;
    langPanel.style.display = 'none';
    toggleBtn.style.display = 'block';
  });
  toggleBtn.addEventListener('click', () => {
    panelOpen = true;
    langPanel.style.display = '';
    toggleBtn.style.display = 'none';
  });

  // Load word labels for hover (sparse — we store indices)
  // We'll do raycasting on the points for hover detection
  const raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 1.5;
  const mouse = new THREE.Vector2();
  const tooltip = document.getElementById('tooltip');

  // For hover word lookup, we need the word list. Load it as a separate compact file.
  // To avoid loading 2.8M strings eagerly, we do lazy load on first hover.
  let wordStrings = null;
  async function ensureWordData() {
    if (wordStrings) return;
    loadText.textContent = 'Loading word labels...';
    document.getElementById('loading').style.display = 'flex';
    try {
      const r = await fetch('galaxy_words.json');
      wordStrings = await r.json();
    } catch(e) {
      wordStrings = [];
    }
    document.getElementById('loading').style.display = 'none';
  }

  // Semantic neighbors UI/API. API uses original Granite embeddings + exact rerank.
  const NEIGHBOR_API = 'http://localhost:8703';
  const neighborToggle = document.getElementById('toggle-neighbors');
  const neighborPanel = document.getElementById('neighbor-panel');
  const neighborTitle = document.getElementById('neighbor-title');
  const neighborStatus = document.getElementById('neighbor-status');
  const neighborTable = document.getElementById('neighbor-table');
  const neighborTableWrap = document.getElementById('neighbor-table-wrap');
  const neighborKInput = document.getElementById('neighbor-k');
  const neighborLangSelect = document.getElementById('neighbor-language');
  const neighborLinesToggle = document.getElementById('neighbor-lines');
  const neighborTableToggle = document.getElementById('neighbor-table-toggle');
  const neighborRefresh = document.getElementById('neighbor-refresh');
  const neighborClose = document.getElementById('neighbor-close');
  let semanticNeighborsEnabled = false;
  let selectedNeighborIndex = -1;
  let lastNeighborPayload = null;

  function setNeighborPanelVisible(visible) {
    neighborPanel.style.display = visible ? 'block' : 'none';
    neighborToggle.textContent = visible ? 'Semantic neighbors: on' : 'Semantic neighbors: off';
    semanticNeighborsEnabled = visible;
    if (!visible) clearNeighborOverlay();
  }

  neighborToggle.addEventListener('click', () => setNeighborPanelVisible(!semanticNeighborsEnabled));
  neighborClose.addEventListener('click', () => setNeighborPanelVisible(false));
  neighborLinesToggle.addEventListener('change', () => drawNeighborOverlay(lastNeighborPayload));
  neighborTableToggle.addEventListener('change', () => {
    neighborTableWrap.style.display = neighborTableToggle.checked ? '' : 'none';
  });
  neighborRefresh.addEventListener('click', () => {
    if (selectedNeighborIndex >= 0) querySemanticNeighbors(selectedNeighborIndex);
  });

  function clearNeighborOverlay() {
    neighborLineGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    neighborMarkerGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    neighborMarkerGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
    lastNeighborPayload = null;
  }

  function drawNeighborOverlay(payload) {
    if (!payload) {
      clearNeighborOverlay();
      return;
    }
    lastNeighborPayload = payload;
    const qid = payload.query.id;
    const neigh = payload.neighbors || [];

    const markerPositions = new Float32Array((1 + neigh.length) * 3);
    const markerColors = new Float32Array((1 + neigh.length) * 3);
    markerPositions[0] = positions[qid*3];
    markerPositions[1] = positions[qid*3+1];
    markerPositions[2] = positions[qid*3+2];
    markerColors[0] = 1.0; markerColors[1] = 1.0; markerColors[2] = 1.0;

    const linePositions = new Float32Array(neigh.length * 2 * 3);
    neigh.forEach((r, j) => {
      const id = r.id;
      const mi = (j + 1) * 3;
      markerPositions[mi] = positions[id*3];
      markerPositions[mi+1] = positions[id*3+1];
      markerPositions[mi+2] = positions[id*3+2];
      markerColors[mi] = 1.0; markerColors[mi+1] = 0.58; markerColors[mi+2] = 0.05;

      const li = j * 6;
      linePositions[li] = positions[qid*3];
      linePositions[li+1] = positions[qid*3+1];
      linePositions[li+2] = positions[qid*3+2];
      linePositions[li+3] = positions[id*3];
      linePositions[li+4] = positions[id*3+1];
      linePositions[li+5] = positions[id*3+2];
    });

    neighborMarkerGeom.setAttribute('position', new THREE.BufferAttribute(markerPositions, 3));
    neighborMarkerGeom.setAttribute('color', new THREE.BufferAttribute(markerColors, 3));
    neighborLineGeom.setAttribute('position', new THREE.BufferAttribute(neighborLinesToggle.checked ? linePositions : new Float32Array(0), 3));
  }

  function renderNeighborTable(payload) {
    const rows = payload.neighbors || [];
    neighborTitle.textContent = `${payload.query.word} [${payload.query.language}] — semantic neighbors`;
    neighborStatus.textContent = `${rows.length} shown · metric=${payload.metric} · space=${payload.space} · ${payload.rerank || 'exact rerank'} · candidates=${payload.candidates_examined ?? 'n/a'}`;
    const headers = ['rank','word','language','cosine','distance','proj_3d','definition'];
    neighborTable.innerHTML = '<thead><tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>' +
      rows.map(r => `<tr data-id="${r.id}">
        <td class="num">${r.rank}</td>
        <td title="${escapeHtml(r.word)}">${escapeHtml(r.word)}</td>
        <td>${escapeHtml(r.language)}</td>
        <td class="num">${Number(r.cosine_similarity).toFixed(6)}</td>
        <td class="num">${Number(r.cosine_distance).toFixed(6)}</td>
        <td class="num">${Number(r.projected_distance_3d).toFixed(3)}</td>
        <td title="${escapeHtml(r.definition || '')}">${escapeHtml(r.definition || '')}</td>
      </tr>`).join('') + '</tbody>';
    neighborTable.querySelectorAll('tr[data-id]').forEach(tr => {
      tr.addEventListener('click', () => {
        const id = Number(tr.dataset.id);
        focusPoint(id);
        selectedNeighborIndex = id;
        querySemanticNeighbors(id);
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  async function querySemanticNeighbors(idx) {
    setNeighborPanelVisible(true);
    selectedNeighborIndex = idx;
    const k = Math.max(1, Math.min(200, Number(neighborKInput.value || 10)));
    const lang = neighborLangSelect.value || 'all';
    neighborStatus.textContent = `Querying semantic backend for point #${idx.toLocaleString()} ...`;
    try {
      const url = `${NEIGHBOR_API}/neighbors/${idx}?k=${k}&candidates=${Math.max(400, k * 40)}&language=${encodeURIComponent(lang)}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
      const payload = await resp.json();
      renderNeighborTable(payload);
      drawNeighborOverlay(payload);
    } catch (err) {
      clearNeighborOverlay();
      neighborTitle.textContent = 'Semantic neighbors — backend unavailable';
      neighborStatus.textContent = `Could not query ${NEIGHBOR_API}. Start it with: cd galaxy && venv/bin/uvicorn semantic_neighbors_server:app --host 127.0.0.1 --port 8703. Error: ${err.message}`;
      neighborTable.innerHTML = '';
    }
  }

  function pickVisiblePoint() {
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(points);
    for (let j = 0; j < intersects.length; j++) {
      const idx = intersects[j].index;
      if (langVisible[langIdx[idx]]) return idx;
    }
    return -1;
  }

  function focusPoint(idx) {
    if (idx < 0) return;
    const px = positions[idx*3], py = positions[idx*3+1], pz = positions[idx*3+2];
    const target = new THREE.Vector3(px, py, pz);
    const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
    controls.target.copy(target);
    camera.position.copy(target).add(offset);
    controls.update();
  }

  // Mouse tracking
  let mouseX = 0, mouseY = 0;
  renderer.domElement.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  });

  // Click for semantic-neighbor inspection; double-click also focuses the point.
  renderer.domElement.addEventListener('click', (e) => {
    const idx = pickVisiblePoint();
    if (idx === -1) return;
    const now = Date.now();
    if (semanticNeighborsEnabled) querySemanticNeighbors(idx);
    if (now - lastClickTime < DBLCLICK_MS) focusPoint(idx);
    lastClickTime = now;
  });

  // Animation loop
  let hoveredIndex = -1;
  let frameCount = 0;

  function animate() {
    requestAnimationFrame(animate);
    controls.update();

    // Throttle raycasting to every 3rd frame for performance
    frameCount++;
    if (frameCount % 3 === 0) {
      let foundIdx = pickVisiblePoint();
      if (foundIdx !== -1) {
        if (foundIdx !== hoveredIndex) {
          hoveredIndex = foundIdx;
          const word = wordStrings ? wordStrings[foundIdx] : `word #${foundIdx.toLocaleString()}`;
          tooltip.style.display = 'block';
          tooltip.textContent = word;
        }
        tooltip.style.left = (mouseX + 15) + 'px';
        tooltip.style.top = (mouseY - 10) + 'px';
      } else {
        if (hoveredIndex !== -1) {
          hoveredIndex = -1;
          tooltip.style.display = 'none';
        }
      }
    }

    renderer.render(scene, camera);
  }

  animate();

  // Hide loading screen
  document.getElementById('loading').style.display = 'none';

  // Handle resize
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Lazy-load word data after a short delay
  setTimeout(() => ensureWordData(), 2000);
}

main().catch(err => {
  document.getElementById('load-text').textContent = 'Error: ' + err.message;
  console.error(err);
});
</script>
</body>
</html>'''
    with open(HTML_FILE, 'w') as f:
        f.write(html)
    print(f"  HTML file: {os.path.getsize(HTML_FILE)/1024:.0f} KB")

def write_word_list(all_words):
    """Write compact word list JSON for hover labels."""
    words_file = OUT_DIR / "galaxy_words.json"
    print(f"Writing {len(all_words):,} word labels to {words_file}...")
    with open(words_file, 'w') as f:
        json.dump(all_words, f, separators=(',', ':'))
    size_mb = os.path.getsize(words_file) / (1024 * 1024)
    print(f"  Words file: {size_mb:.1f} MB")

if __name__ == "__main__":
    points, colors, words, groups, lang_counts, hue_map, group_names, group_file_counts = load_all_embeddings()
    n_groups = len(group_names)
    print(f"\nTotal: {len(points):,} points from {n_groups} language groups ({len(lang_counts)} files)\n")
    write_binary(points, colors, groups)
    write_meta(group_names, group_file_counts, hue_map, len(points))
    write_word_list(words)
    write_html()
    print(f"\nDone! To view:")
    print(f"  cd {OUT_DIR.parent}")
    print(f"  python3 -m http.server 8888")
    print(f"  Open http://localhost:8888/galaxy/galaxy.html")
