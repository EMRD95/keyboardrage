#!/usr/bin/env python3
"""
Local semantic-neighbor API for KeyboardRage Galaxy.

Neighbors are fully precomputed. Global mode uses neighbor_ids.npy (all 2.25M).
Per-language mode uses neighbor_ids_{lang}.npy (within-language top-200).

Precompute with: ../venv/bin/python precompute_neighbors.py --per-language
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Literal

import duckdb
import numpy as np
import pyarrow.parquet as pq
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

HERE = Path(__file__).resolve().parent
ATLAS_PARQUET = HERE.parent / "atlas" / "atlas_data.parquet"
NEIGHBOR_IDS_PATH = HERE / "neighbor_ids.npy"
NEIGHBOR_SCORES_PATH = HERE / "neighbor_scores.npy"
NEIGHBOR_META_PATH = HERE / "neighbor_meta.json"
EMBEDDINGS_PATH = HERE / "semantic_embeddings.f32.npy"
FAISS_INDEX_PATH = HERE / "semantic_faiss_hnsw.index"
INDEX_META_PATH = HERE / "semantic_index_meta.json"

app = FastAPI(title="KeyboardRage Semantic Neighbors", version="3.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

# Cache: {language: (ids_mmap, scores_mmap, lang_index_mmap)}
_per_lang_cache: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray | None]] = {}
_global_ids: np.ndarray | None = None
_global_scores: np.ndarray | None = None
_meta_table = None
_meta_rows: int | None = None
_con = duckdb.connect(database=":memory:")


def _load_metadata_table():
    global _meta_table, _meta_rows
    if _meta_table is None:
        if not ATLAS_PARQUET.exists():
            raise RuntimeError(f"Missing {ATLAS_PARQUET}")
        _meta_table = pq.read_table(
            ATLAS_PARQUET, columns=["x", "y", "z", "word", "language", "definition"],
        )
        _meta_rows = _meta_table.num_rows
    return _meta_table


def _load_global():
    global _global_ids, _global_scores
    if _global_ids is None:
        if not NEIGHBOR_IDS_PATH.exists():
            raise RuntimeError(f"Missing {NEIGHBOR_IDS_PATH.name}")
        _global_ids = np.load(NEIGHBOR_IDS_PATH, mmap_mode="r")
        _global_scores = np.load(NEIGHBOR_SCORES_PATH, mmap_mode="r")
    return _global_ids, _global_scores


def _load_per_language(language: str):
    if language in _per_lang_cache:
        return _per_lang_cache[language]

    ids_path = HERE / f"neighbor_ids_{language}.npy"
    scores_path = HERE / f"neighbor_scores_{language}.npy"
    index_path = HERE / f"lang_index_{language}.npy"

    if not ids_path.exists():
        # Fall back to global
        return _load_global()[0], _load_global()[1], None

    ids = np.load(ids_path, mmap_mode="r")
    scores = np.load(scores_path, mmap_mode="r")
    lang_index = np.load(index_path, mmap_mode="r") if index_path.exists() else None

    _per_lang_cache[language] = (ids, scores, lang_index)
    return ids, scores, lang_index


def _row(i: int) -> dict:
    table = _load_metadata_table()
    if i < 0 or i >= table.num_rows:
        raise IndexError(i)
    batch = table.slice(i, 1).to_pydict()
    return {
        "id": i,
        "word": batch["word"][0],
        "language": batch["language"][0],
        "definition": batch["definition"][0],
        "x": float(batch["x"][0]),
        "y": float(batch["y"][0]),
        "z": float(batch["z"][0]),
    }


def _rows(ids: list[int]) -> list[dict]:
    return [_row(i) for i in ids]


def _projected_distance(a: dict, b: dict) -> float:
    dx = float(a["x"]) - float(b["x"])
    dy = float(a["y"]) - float(b["y"])
    dz = float(a["z"]) - float(b["z"])
    return math.sqrt(dx * dx + dy * dy + dz * dz)


@app.get("/health")
def health():
    status = {
        "atlas_parquet": ATLAS_PARQUET.exists(),
        "embeddings": EMBEDDINGS_PATH.exists(),
        "precomputed_global": NEIGHBOR_IDS_PATH.exists(),
    }
    if ATLAS_PARQUET.exists():
        status["rows"] = pq.ParquetFile(ATLAS_PARQUET).metadata.num_rows
    if NEIGHBOR_META_PATH.exists():
        status["neighbor_meta"] = json.loads(NEIGHBOR_META_PATH.read_text())
    # List available per-language files
    per_lang = sorted(
        p.stem.replace("neighbor_ids_", "")
        for p in HERE.glob("neighbor_ids_*.npy")
    )
    if per_lang:
        status["per_language_available"] = per_lang
    return status


@app.get("/point/{point_id}")
def point(point_id: int):
    try:
        return _row(point_id)
    except Exception:
        raise HTTPException(status_code=404, detail="point id out of range")


@app.get("/neighbors/{point_id}")
def neighbors(
    point_id: int,
    k: int = Query(10, ge=1, le=200),
    language: str | None = Query(
        None,
        description="Restrict to within-language neighbors (e.g. 'french')",
    ),
    language_filter: Literal["all", "same", "cross"] = "all",
    visible_languages: str | None = Query(None),
):
    query = _row(point_id)

    if language:
        # Per-language precomputed: map global_id → local_id
        ids_arr, scores_arr, lang_index = _load_per_language(language)
        if lang_index is not None:
            local_id = int(lang_index[point_id])
            if local_id < 0:
                return {
                    "query": query, "metric": "cosine",
                    "space": "precomputed_per_language", "k": k,
                    "language": language, "neighbors": [],
                }
            all_ids = np.asarray(ids_arr[local_id], dtype=np.int64)
            all_scores = np.asarray(scores_arr[local_id], dtype=np.float32)
        else:
            # No per-language file, fall back to global with same-language filter
            ids_arr, scores_arr = _load_global()
            all_ids = np.asarray(ids_arr[point_id], dtype=np.int64)
            all_scores = np.asarray(scores_arr[point_id], dtype=np.float32)
            language_filter = "same"
    else:
        ids_arr, scores_arr = _load_global()
        all_ids = np.asarray(ids_arr[point_id], dtype=np.int64)
        all_scores = np.asarray(scores_arr[point_id], dtype=np.float32)

    # Drop sentinels (0 = no more neighbors)
    valid = all_ids >= 0
    all_ids = all_ids[valid]
    all_scores = all_scores[valid]

    if all_ids.size == 0:
        return {
            "query": query, "metric": "cosine",
            "space": "precomputed", "k": k, "neighbors": [],
        }

    # Parse visible-language filter
    visible_set = None
    if visible_languages:
        visible_set = {p.strip() for p in visible_languages.split(",") if p.strip()}
        if not visible_set:
            visible_set = None

    has_filter = language_filter != "all" or visible_set is not None
    rows = _rows([int(i) for i in all_ids.tolist()])

    eligible_scores: list[float] = []
    eligible_rows: list[dict] = []

    for idx, (cid, row) in enumerate(zip(all_ids.tolist(), rows)):
        if visible_set is not None and row["language"] not in visible_set:
            continue
        if language_filter == "same" and row["language"] != query["language"]:
            continue
        if language_filter == "cross" and row["language"] == query["language"]:
            continue
        eligible_rows.append(row)
        eligible_scores.append(float(all_scores[idx]))

    if has_filter and eligible_scores:
        order = sorted(range(len(eligible_scores)), key=lambda i: -eligible_scores[i])[:k]
    else:
        order = list(range(min(k, len(eligible_scores))))

    out = []
    for rank, pos in enumerate(order, start=1):
        row = eligible_rows[pos]
        sim = eligible_scores[pos]
        out.append({
            **row, "rank": rank,
            "cosine_similarity": sim,
            "cosine_distance": float(1.0 - sim),
            "projected_distance_3d": _projected_distance(query, row),
        })

    return {
        "query": query, "metric": "cosine",
        "space": "precomputed_per_language" if language else "precomputed_global",
        "k": k, "language_filter": language_filter,
        "visible_languages": sorted(visible_set) if visible_set else None,
        "candidates_examined": int(all_ids.size),
        "neighbors": out,
    }


@app.get("/search")
def search(
    q: str = Query(..., min_length=1),
    limit: int = Query(25, ge=1, le=200),
    language: str | None = Query(None, description="Filter by language"),
):
    if not ATLAS_PARQUET.exists():
        raise HTTPException(status_code=500, detail="atlas_data.parquet missing")
    safe_q = q.replace("'", "''")
    lang_clause = ""
    if language:
        safe_lang = language.replace("'", "''")
        lang_clause = f"AND lower(language) = lower('{safe_lang}')"
    sql = f"""
      WITH t AS (
        SELECT row_number() OVER () - 1 AS id, word, language, x, y, z, definition
        FROM read_parquet('{ATLAS_PARQUET.as_posix()}')
      )
      SELECT id, word, language, x, y, z, definition
      FROM t
      WHERE (lower(word) = lower('{safe_q}') OR lower(word) LIKE '%' || lower('{safe_q}') || '%')
        {lang_clause}
      ORDER BY CASE WHEN lower(word) = lower('{safe_q}') THEN 0 ELSE 1 END, word
      LIMIT {int(limit)}
    """
    rows = _con.execute(sql).fetchall()
    cols = ["id", "word", "language", "x", "y", "z", "definition"]
    return {"results": [dict(zip(cols, r)) for r in rows]}
