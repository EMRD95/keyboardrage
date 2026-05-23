# KeyboardRage Data Visualization Pipeline

Reproducible pipeline from raw MonkeyType word lists to interactive 3D semantic
galaxies, 2D embedding atlases, and in-game Box Cube/Matrix visualizations.

---

## Overview

```
MonkeyType words ──► kaikki.org Wiktionary ──► Granite embeddings ──► UMAP 3D
                         │                         │                     │
                         ▼                         ▼                     ▼
                   words_emb/*.json        384-dim vectors         embedding_3d
                         │                         │                     │
                         └─────────┬───────────────┘                     │
                                   ▼                                     │
                          words_emb_merged/                              │
                           (deduplicated)                                │
                                   │                                     │
                    ┌──────────────┼──────────────┐                      │
                    ▼              ▼              ▼                      │
              generate_        generate_      generate-                  │
              galaxy.py        atlas.py       game-data.py               │
                    │              │              │                      │
                    ▼              ▼              ▼                      │
            galaxy_data.bin  atlas_data.    words/<lang>/                │
            galaxy_words.json  parquet      words.json                   │
            galaxy_meta.json               galaxy-coords.bin             │
                    │              │              │                      │
                    ▼              ▼              ▼                      │
            galaxy_fly_      atlas_         Box Cube /                   │
            three.html       language.html  Box Matrix                   │
            (3D orbit/fly)   (2D atlas)     (in-game dots)               │
```

## Phase 1: Raw Word Lists → words_emb (with Wiktionary enrichment)

**Script:** `old_stuffs/process_monkeytype.py`
**Source:** `/tmp/monkeytype-src/frontend/static/languages/*.json`
**Output:** `words_emb/*.json`

Copies MonkeyType word lists and enriches each word with definitions from
[kaikki.org](https://kaikki.org/dictionary/) (English Wiktionary, JSONL format).

Each word entry in the output:
```json
{
  "word": "chat",
  "definitions": ["A domestic feline...", "An online conversation..."],
  "frequency": 0,
  "source_type": "base",
  "source_files": ["french.json", "french_10k.json"]
}
```

Language mapping: MonkeyType short codes (e.g. `french`) → kaikki.org language
names (e.g. `French`) via `LANG_MAP` dictionary. Code/constructed languages are
skipped.

Kaikki JSONL files are cached in `.kaikki_cache/` (~1 GB, 108 languages).
Lookup indices cached in `.kaikki_lookup/`.

## Phase 2: Embedding Definitions (text → 384-dim vectors)

**Script:** `old_stuffs/embed_definitions.py`
**Source:** `words_emb/*.json`
**Output:** `words_emb/*.json` (updated in-place with `embedding_3d`)

1. Concatenates all definitions per word into one text string
2. Embeds with `ibm-granite/granite-embedding-97m-multilingual-r2` (384-dim)
   via SentenceTransformers
3. Reduces to 3D via UMAP:
   ```
   UMAP(n_components=3, metric='cosine', n_neighbors=15, min_dist=0.1)
   ```
4. Stores as `embedding_3d: [x, y, z]` in each word's JSON entry

GPU recommended (RTX 3090 used in this project). Batch size: 512.

## Phase 3: Merge into words_emb_merged (deduplication)

**Script:** `old_stuffs/merge_words_emb_by_language.py`
**Source:** `words_emb/*.json` (108 files)
**Output:** `words_emb_merged/*.json` (108 files, ~834 MB)

Many languages have multiple word lists (base + frequency tiers like `_1k`,
`_5k`). This merges them per logical language:

- Duplicate key: case-folded/stripped word
- Keeps one entry per word
- Merges unique definitions from all sources
- Keeps `embedding_3d` from highest-priority source
- Preserves provenance metadata

Multi-word language grouping (e.g. `chinese_simplified` + `chinese_traditional`
are separate logical languages; `serbian` + `serbian_latin` are grouped as
`serbian`).

Report written to `words_emb_merged_report.json`.

## Phase 4: Game Data Artifacts (for in-game Box Cube/Matrix)

**Script:** `scripts/generate-game-data.py <language>`
**Source:** `words_emb_merged/<language>.json`
**Output:** `words/<language>/words.json`, `words/<language>/galaxy-coords.bin`,
           `words/<language>/galaxy-meta.json`

Per language:
1. Extracts words with valid `embedding_3d` (all 352k English, 302k French)
2. Median-centers coordinates, robust 98th-percentile scales, clamps to [-0.82, 0.82]
3. Quantizes to int16 in KRG1 binary format (magic header + uint32 count + int16×3 per point)
4. Computes `charLengthByFrequency` per tier for WPM speed calibration
5. Outputs frequency-ordered word JSON + compact coordinate binary

```bash
python3 scripts/generate-game-data.py french
python3 scripts/generate-game-data.py english
```

Frontend (`themes/galaxy-data.ts`) loads these lazily. `GALAXY_LANGUAGES` set
controls which languages get full-dot-cloud Box Cube/Matrix.

## Phase 5: 3D Galaxy Visualization (fly-through + orbit)

**Script:** `galaxy/3D_galaxy/generate_galaxy.py`
**Source:** `words_emb/*.json` (or symlinked from `words_emb_merged/`)
**Output:** `galaxy/3D_galaxy/galaxy_data.bin`, `galaxy/3D_galaxy/galaxy_words.json`,
           `galaxy/3D_galaxy/galaxy_meta.json`

1. Reads all 108 language files, extracts words + `embedding_3d`
2. Assigns distinct high-contrast colors to top languages
3. Packs positions as Float32 xyz + colors as Uint8 rgb into compact binary
4. Outputs metadata: language labels, word counts, color assignments

Viewer: `galaxy/3D_galaxy/galaxy_fly_three.html` (Three.js, fly-through + orbit modes).
Served at `http://localhost:8888/galaxy/3D_galaxy/galaxy_fly_three.html`.

See also `galaxy/3D_galaxy/rebuild_umap50_coordinates.py` for the cosine-aligned UMAP
reprojection that improved semantic neighbor accuracy in 3D space.

## Phase 6: 2D Apple Embedding Atlas

**Script:** `galaxy/atlas/generate_atlas.py`
**Source:** `words_emb/*.json`
**Output:** `galaxy/atlas/atlas_data.parquet`

Converts word embeddings to a Parquet file with columns: `x`, `y`, `word`,
`language`. Loaded by the [Apple Embedding Atlas](https://github.com/apple/ml-embedding-atlas)
DuckDB server.

```bash
cd galaxy/atlas
../venv/bin/embedding-atlas atlas_data.parquet \
  --x x --y y --text word --duckdb server --port 5055
```

Viewer: `galaxy/atlas/atlas_language.html` at `http://localhost:8888/galaxy/atlas/atlas_language.html`.
Atlas server on port 5055.

## Phase 7: Semantic Neighbor Search (precomputed cosine)

Semantic neighbors are fully precomputed: top-200 cosine neighbors per point
computed from Granite definition embeddings. The server does zero math at query
time — pure numpy array slicing via memory-mapped files.

### 7a: Build Granite embeddings + FAISS index

**Script:** `galaxy/semantic/build_semantic_index.py`
**Source:** `words_emb/*.json`
**Output:** `galaxy/semantic/semantic_embeddings.f32.npy`,
           `galaxy/semantic/semantic_faiss_hnsw.index`,
           `galaxy/semantic/semantic_index_meta.json`

1. Re-embeds all concatenated definitions with Granite (384-dim, L2-normalized)
2. Builds FAISS HNSW index for fast candidate retrieval
3. Stores exact float32 embeddings for cosine reranking

### 7b: Precompute all-pairs top-200 neighbors

**Script:** `galaxy/semantic/precompute_neighbors.py`
**Source:** `galaxy/semantic/semantic_embeddings.f32.npy` (2.25M × 384 float32)
**Output:** `galaxy/semantic/neighbor_ids.npy` (1.7 GB, int32),
           `galaxy/semantic/neighbor_scores.npy` (1.7 GB, float32),
           `galaxy/semantic/neighbor_meta.json`

Uses PyTorch GPU (RTX 3090): loads the full embedding matrix onto GPU, then
batched matrix multiply (chunk_size=1024) computes cosine similarity against
all 2.25M points. topk selects 200 neighbors per point, excluding self.

```bash
cd galaxy/semantic
../venv/bin/python precompute_neighbors.py   # ~14 min on RTX 3090
```

Falls back to FAISS CPU IndexFlatIP if CUDA is unavailable (~hours).

### 7c: Server

**Server:** `galaxy/semantic/semantic_neighbors_server.py` (FastAPI v2, port 8703).

Endpoints:
- `GET /health` — status of atlas parquet, embeddings, precomputed arrays
- `GET /neighbors/{id}?k=100&language=all|same|cross` — instant lookup
- `GET /search?q=<word>` — DuckDB word search across atlas parquet
- `GET /point/{id}` — single point metadata

Performance: 4-5ms per query (cold first request ~235ms for mmap + parquet
init). Compare with ~multi-second CPU grind from the old IndexFlatIP brute-force.

The galaxy fly-through viewer queries this API when clicking a dot. The same API
can serve the game later — call `/neighbors/{id}?k=200` to get a full word queue.

**Important:** 3D visual distance ≠ semantic similarity. The 3D UMAP/PCA
projection only preserves ~15-25% of variance. Semantic neighbors use the full
384-dim Granite embedding space — precomputed cosine scores are stored directly.

## Phase 8: Box Embedding Data (Box Cube/Matrix for non-galaxy languages)

**Script:** `scripts/generate-box-embedding-data.py`
**Source:** `words/*.json`
**Output:** `themes/box-embedding-data.ts` (TypeScript module, ~830 KB)

For languages WITHOUT galaxy coordinate data (i.e., most of the 40+ supported
languages), this generates capped 1000-dot point sets:

1. Groups words by language, takes top 200 most common + 800 cluster centroids
2. Clusters with MiniBatchKMeans in Granite embedding space
3. Reduces to 3D via PCA (global, median-centered, 98th-percentile scaled)
4. Outputs as TypeScript arrays: `[word, x, y, z][]` per language

Loaded by `box.ts` and `box-cube.ts` at import time as `GRANITE_BOX_WORD_POINTS`.

## Coordinate Systems Summary

| System | Dimensions | Algorithm | Used by |
|---|---|---|---|
| `embedding_3d` (original) | 3 | UMAP(cosine, n=15) | `words_emb/*.json` |
| `embedding_3d` (merged) | 3 | UMAP(cosine, n=15) | `words_emb_merged/*.json` |
| Galaxy binary | 3 | UMAP(cosine, n=15) | `galaxy_data.bin` |
| Galaxy UMAP50 | 3 | UMAP(cosine, n=50, min_dist=0.01) | `galaxy/3D_galaxy/semantic_umap50_min001_3d.npy` |
| Atlas 2D | 2 | UMAP(cosine, n=15) | `galaxy/atlas/atlas_data.parquet` |
| Game coords (KRG1) | 3 | Same as `embedding_3d`, median-centered, scaled, int16 | `words/<lang>/galaxy-coords.bin` |
| Box Embedding | 3 | PCA global, 1000-dot KMeans clusters | `themes/box-embedding-data.ts` |
| Semantic search (raw) | 384 | Granite raw, L2-normalized | `galaxy/semantic/semantic_embeddings.f32.npy` |
| Semantic neighbors (precomputed) | 200 × N | GPU matmul + topk | `galaxy/semantic/neighbor_ids.npy` + `neighbor_scores.npy` |

## Key Constants

| Constant | Value | Location |
|---|---|---|
| Embedding model | `ibm-granite/granite-embedding-97m-multilingual-r2` | All embed scripts |
| Embedding dim | 384 | All embed scripts |
| Coordinate clamp | ±0.82 | `CUBE_LIMIT` in generate scripts |
| Robust percentile | 98.0 | `ROBUST_PERCENTILE` |
| Int16 quantization | ±32767 | KRG1 format |
| Box Cube point scale | 0.8832 (1.92 × 0.46) | `CUBE_POINT_SCALE` in galaxy-data.ts |
| Box Matrix point scale | 0.2254 (0.46 × 0.49) | `MATRIX_POINT_SCALE` in box.ts |
| Max Box Embedding dots | 1000 | `GRANITE_BOX_MAX_DOTS_PER_LANGUAGE` |
| Galaxy languages | `['english', 'french']` | `GALAXY_LANGUAGES` in galaxy-data.ts |

## Full Rebuild Command

```bash
cd /home/ubu/Desktop/keyboardrage/galaxy

# From merged embeddings to all visualizations:
./full_rebuild_from_merged.sh

# Or step by step from galaxy/:
./venv/bin/python 3D_galaxy/generate_galaxy.py        # 3D galaxy artifacts
./venv/bin/python atlas/generate_atlas.py              # 2D atlas parquet
./venv/bin/python semantic/build_semantic_index.py     # Granite embeddings + FAISS
./venv/bin/python semantic/precompute_neighbors.py     # top-200 neighbors (~14 min GPU)

# Game data (from project root):
cd /home/ubu/Desktop/keyboardrage
python3 scripts/generate-game-data.py english
python3 scripts/generate-game-data.py french
```

## Ports & Servers

| Port | Service | Script |
|---|---|---|
| 3000 | KeyboardRage game | `node server.js` |
| 5055 | Apple Embedding Atlas | `embedding-atlas ... --port 5055` |
| 8703 | Semantic neighbors API | `semantic_neighbors_server.py` |
| 8888 | Static galaxy viewer | `python3 -m http.server 8888` |
