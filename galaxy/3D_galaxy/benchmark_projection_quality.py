#!/usr/bin/env python3
"""Benchmark 3D reducers for KeyboardRage semantic neighbor preservation.

Goal: choose coordinates that make visual 3D neighborhoods agree better with the
true Granite cosine neighbors.

Metrics are computed on a deterministic sample:
- semantic top-k: exact cosine/IP neighbors in original normalized 384D space
- visual top-k: exact L2 neighbors in candidate 3D coordinates
- recall@k: overlap between semantic and visual neighborhoods
- mean_semantic_top10_visual_rank: where true semantic top-10 land in visual ranks

Outputs under galaxy/projection_experiments/<timestamp>/.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import faiss
import numpy as np
import pyarrow.parquet as pq
import umap

try:
    import pacmap
except Exception:
    pacmap = None

GALAXY_DIR = Path(__file__).resolve().parent
EMB_PATH = GALAXY_DIR / "semantic_embeddings.f32.npy"
PARQUET_PATH = GALAXY_DIR / "atlas_data.parquet"
OUT_ROOT = GALAXY_DIR / "projection_experiments"


def exact_semantic_neighbors(x: np.ndarray, k: int) -> np.ndarray:
    index = faiss.IndexFlatIP(x.shape[1])
    index.add(np.asarray(x, dtype=np.float32))
    _d, ids = index.search(np.asarray(x, dtype=np.float32), k + 1)
    return ids[:, 1:k+1]


def exact_visual_neighbors(coords: np.ndarray, k: int) -> np.ndarray:
    coords = np.asarray(coords, dtype=np.float32)
    index = faiss.IndexFlatL2(3)
    index.add(coords)
    _d, ids = index.search(coords, k + 1)
    return ids[:, 1:k+1]


def evaluate(coords: np.ndarray, semantic_200: np.ndarray) -> dict:
    visual_200 = exact_visual_neighbors(coords, 200)
    n = semantic_200.shape[0]
    out = {}
    for k in [1, 5, 10, 20, 50, 100]:
        overlaps = 0
        for i in range(n):
            overlaps += len(set(semantic_200[i, :k]).intersection(visual_200[i, :k]))
        out[f"recall@{k}"] = overlaps / (n * k)

    ranks = []
    visual_rank_maps = []
    for i in range(n):
        visual_rank_maps.append({int(v): r + 1 for r, v in enumerate(visual_200[i])})
    for i in range(n):
        m = visual_rank_maps[i]
        for sid in semantic_200[i, :10]:
            ranks.append(m.get(int(sid), 201))
    out["mean_semantic_top10_visual_rank_capped200"] = float(np.mean(ranks))
    out["median_semantic_top10_visual_rank_capped200"] = float(np.median(ranks))

    # Pairwise projected distance of true semantic top-10, normalized by cloud std.
    c = coords.astype(np.float64)
    scale = float(np.mean(np.std(c, axis=0))) or 1.0
    dists = []
    for i in range(n):
        dif = c[semantic_200[i, :10]] - c[i]
        dists.extend(np.linalg.norm(dif, axis=1) / scale)
    out["mean_projected_distance_semantic_top10_scaled"] = float(np.mean(dists))
    out["median_projected_distance_semantic_top10_scaled"] = float(np.median(dists))
    return out


def read_current_coords(sample_ids: np.ndarray) -> np.ndarray:
    table = pq.read_table(PARQUET_PATH, columns=["x", "y", "z"])
    x = np.asarray(table["x"], dtype=np.float32)[sample_ids]
    y = np.asarray(table["y"], dtype=np.float32)[sample_ids]
    z = np.asarray(table["z"], dtype=np.float32)[sample_ids]
    return np.stack([x, y, z], axis=1).astype(np.float32)


def run_method(name: str, x: np.ndarray, seed: int) -> np.ndarray:
    t0 = time.time()
    if name == "umap_50_001":
        reducer = umap.UMAP(n_components=3, n_neighbors=50, min_dist=0.01, metric="cosine", random_state=seed, low_memory=True, verbose=True)
        coords = reducer.fit_transform(x)
    elif name == "umap_150_003":
        reducer = umap.UMAP(n_components=3, n_neighbors=150, min_dist=0.03, metric="cosine", random_state=seed, low_memory=True, verbose=True)
        coords = reducer.fit_transform(x)
    elif name == "umap_300_005":
        reducer = umap.UMAP(n_components=3, n_neighbors=300, min_dist=0.05, metric="cosine", random_state=seed, low_memory=True, verbose=True)
        coords = reducer.fit_transform(x)
    elif name == "pacmap_default":
        if pacmap is None:
            raise RuntimeError("pacmap is not installed")
        reducer = pacmap.PaCMAP(n_components=3, distance="angular", random_state=seed, verbose=True)
        coords = reducer.fit_transform(x, init="pca")
    else:
        raise ValueError(name)
    print(f"{name} finished in {(time.time()-t0)/60:.1f} min", flush=True)
    return np.asarray(coords, dtype=np.float32)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=75_000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--methods", nargs="+", default=["current", "umap_50_001", "umap_150_003", "pacmap_default"])
    args = ap.parse_args()

    emb = np.load(EMB_PATH, mmap_mode="r")
    n = emb.shape[0]
    rng = np.random.default_rng(args.seed)
    sample_ids = np.sort(rng.choice(n, size=min(args.sample, n), replace=False)).astype(np.int64)
    x = np.asarray(emb[sample_ids], dtype=np.float32)

    out_dir = OUT_ROOT / time.strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    np.save(out_dir / "sample_ids.npy", sample_ids)

    print(f"Sample: {len(sample_ids):,}/{n:,}; dim={x.shape[1]}; out={out_dir}", flush=True)
    print("Computing exact semantic neighbors within sample...", flush=True)
    semantic_200 = exact_semantic_neighbors(x, 200)
    np.save(out_dir / "semantic_neighbors_200.npy", semantic_200)

    results = {
        "sample": int(len(sample_ids)),
        "seed": args.seed,
        "methods": {},
        "notes": "Higher recall is better; lower projected distance/rank is better. Metrics are within sampled subset, not full 2.25M.",
    }

    for method in args.methods:
        print(f"\n=== {method} ===", flush=True)
        t0 = time.time()
        if method == "current":
            coords = read_current_coords(sample_ids)
        else:
            coords = run_method(method, x, args.seed)
        np.save(out_dir / f"coords_{method}.npy", coords)
        metrics = evaluate(coords, semantic_200)
        metrics["elapsed_sec"] = round(time.time() - t0, 2)
        results["methods"][method] = metrics
        print(json.dumps(metrics, indent=2), flush=True)
        with open(out_dir / "results.json", "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)

    print(f"\nResults: {out_dir / 'results.json'}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
