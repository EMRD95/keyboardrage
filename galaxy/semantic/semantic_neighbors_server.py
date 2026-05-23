#!/usr/bin/env python3
"""
Local semantic-neighbor API for KeyboardRage Galaxy.

Neighbors are fully precomputed: top-200 cosine neighbors per point computed
from the original Granite definition embeddings. The server does zero math at
query time — pure array lookups via memory-mapped numpy arrays.

Precompute with: ../venv/bin/python precompute_neighbors.py
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
# Legacy paths kept for health-check backward compat
EMBEDDINGS_PATH = HERE / "semantic_embeddings.f32.npy"
FAISS_INDEX_PATH = HERE / "semantic_faiss_hnsw.index"
INDEX_META_PATH = HERE / "semantic_index_meta.json"

app = FastAPI(title="KeyboardRage Semantic Neighbors", version="2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_neighbor_ids: np.ndarray | None = None
_neighbor_scores: np.ndarray | None = None
_meta_table = None
_meta_rows: int | None = None
_con = duckdb.connect(database=":memory:")


def _load_metadata_table():
    global _meta_table, _meta_rows
    if _meta_table is None:
        if not ATLAS_PARQUET.exists():
            raise RuntimeError(f"Missing {ATLAS_PARQUET}")
        _meta_table = pq.read_table(
            ATLAS_PARQUET,
            columns=["x", "y", "z", "word", "language", "definition"],
        )
        _meta_rows = _meta_table.num_rows
    return _meta_table


def _load_neighbors():
    global _neighbor_ids, _neighbor_scores
    if _neighbor_ids is None:
        if not NEIGHBOR_IDS_PATH.exists():
            raise RuntimeError(
                f"Missing {NEIGHBOR_IDS_PATH.name}. Build with: "
                "cd galaxy/semantic && ../venv/bin/python precompute_neighbors.py"
            )
        _neighbor_ids = np.load(NEIGHBOR_IDS_PATH, mmap_mode="r")
        _neighbor_scores = np.load(NEIGHBOR_SCORES_PATH, mmap_mode="r")
    return _neighbor_ids, _neighbor_scores


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
        "faiss_index": FAISS_INDEX_PATH.exists(),
        "precomputed_neighbors": NEIGHBOR_IDS_PATH.exists(),
    }
    if ATLAS_PARQUET.exists():
        status["rows"] = pq.ParquetFile(ATLAS_PARQUET).metadata.num_rows
    if NEIGHBOR_META_PATH.exists():
        status["neighbor_meta"] = json.loads(NEIGHBOR_META_PATH.read_text())
    if INDEX_META_PATH.exists():
        status["semantic_meta"] = json.loads(INDEX_META_PATH.read_text())
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
    candidates: int = Query(400, ge=10, le=5000),
    language: Literal["all", "same", "cross"] = "all",
    visible_languages: str | None = Query(
        None,
        description="Comma-separated language names currently visible",
    ),
    allow_exact_fallback: bool = Query(
        False,
        description="(deprecated — precomputed neighbors, no fallback needed)",
    ),
):
    ids_arr, scores_arr = _load_neighbors()
    n = ids_arr.shape[0]

    if point_id < 0 or point_id >= n:
        raise HTTPException(status_code=404, detail="point id out of range")

    query = _row(point_id)

    # Parse visible-language filter
    visible_language_set = None
    if visible_languages:
        visible_language_set = {
            part.strip() for part in visible_languages.split(",") if part.strip()
        }
        if not visible_language_set:
            visible_language_set = None

    has_language_filter = language != "all" or visible_language_set is not None

    # Precomputed top-200 neighbors for this point
    all_ids = np.asarray(ids_arr[point_id], dtype=np.int64)
    all_scores = np.asarray(scores_arr[point_id], dtype=np.float32)

    # Filter: drop invalid IDs (0 = sentinel for rows with <200 neighbors)
    valid_mask = all_ids >= 0
    all_ids = all_ids[valid_mask]
    all_scores = all_scores[valid_mask]

    if all_ids.size == 0:
        return {
            "query": query,
            "metric": "cosine",
            "space": "precomputed_original_embedding",
            "k": k,
            "neighbors": [],
        }

    # Fetch metadata and apply language filters
    rows = _rows([int(i) for i in all_ids.tolist()])
    eligible_ids: list[int] = []
    eligible_rows: list[dict] = []
    eligible_scores: list[float] = []

    for idx, (cid, row) in enumerate(zip(all_ids.tolist(), rows)):
        if visible_language_set is not None and row["language"] not in visible_language_set:
            continue
        if language == "same" and row["language"] != query["language"]:
            continue
        if language == "cross" and row["language"] == query["language"]:
            continue
        eligible_ids.append(int(cid))
        eligible_rows.append(row)
        eligible_scores.append(float(all_scores[idx]))

    # Scores are already sorted (from topk), so no re-sorting needed
    # unless language filter reorders — re-sort just in case
    if has_language_filter and eligible_scores:
        order = sorted(
            range(len(eligible_scores)),
            key=lambda i: eligible_scores[i],
            reverse=True,
        )[:k]
    else:
        order = list(range(min(k, len(eligible_scores))))

    out = []
    for rank, pos in enumerate(order, start=1):
        row = eligible_rows[pos]
        sim = eligible_scores[pos]
        out.append(
            {
                **row,
                "rank": rank,
                "cosine_similarity": sim,
                "cosine_distance": float(1.0 - sim),
                "projected_distance_3d": _projected_distance(query, row),
            }
        )

    return {
        "query": query,
        "metric": "cosine",
        "space": "precomputed_original_embedding",
        "k": k,
        "language_filter": language,
        "visible_languages": (
            sorted(visible_language_set) if visible_language_set is not None else None
        ),
        "candidates_examined": int(all_ids.size),
        "neighbors": out,
    }


@app.get("/search")
def search(q: str = Query(..., min_length=1), limit: int = Query(25, ge=1, le=200)):
    if not ATLAS_PARQUET.exists():
        raise HTTPException(status_code=500, detail="atlas_data.parquet missing")
    safe_q = q.replace("'", "''")
    sql = f"""
      WITH t AS (
        SELECT row_number() OVER () - 1 AS id, word, language, x, y, z, definition
        FROM read_parquet('{ATLAS_PARQUET.as_posix()}')
      )
      SELECT id, word, language, x, y, z, definition
      FROM t
      WHERE lower(word) = lower('{safe_q}') OR lower(word) LIKE '%' || lower('{safe_q}') || '%'
      LIMIT {int(limit)}
    """
    rows = _con.execute(sql).fetchall()
    cols = ["id", "word", "language", "x", "y", "z", "definition"]
    return {"results": [dict(zip(cols, r)) for r in rows]}
