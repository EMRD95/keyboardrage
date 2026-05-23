#!/usr/bin/env python3
"""Rebuild embedding_3d coordinates from existing Granite embeddings.

This does NOT rebuild Granite embeddings or FAISS. It only computes a new 3D
projection from semantic_embeddings.f32.npy and writes coordinates back into
words_emb/*.json in the exact same sorted row order.

Default reducer chosen from 50k-sample benchmark:
UMAP(metric='cosine', n_neighbors=50, min_dist=0.01, n_components=3)
This reduced median projected distance of semantic top-10 from ~0.227 to ~0.037
on the benchmark sample, making semantic-neighbor lines much shorter.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import time
from pathlib import Path

import numpy as np
import umap

ROOT = Path(__file__).resolve().parent.parent.parent
GALAXY_DIR = Path(__file__).resolve().parent
WORDS_EMB_DIR = Path(os.environ.get("KEYBOARDRAGE_WORDS_EMB_DIR", str(ROOT / "words_emb")))
EMB_PATH = GALAXY_DIR.parent / "semantic" / "semantic_embeddings.f32.npy"
OUT_COORDS = GALAXY_DIR / "semantic_umap50_min001_3d.npy"


def iter_files():
    return sorted(Path(WORDS_EMB_DIR).glob("*.json"))


def count_rows() -> int:
    n = 0
    for path in iter_files():
        data = json.load(open(path, "r", encoding="utf-8"))
        for entry in data.get("words", []):
            if entry.get("embedding_3d"):
                n += 1
    return n


def write_coords(coords: np.ndarray) -> int:
    idx = 0
    for path in iter_files():
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        changed = 0
        for entry in data.get("words", []):
            if not entry.get("embedding_3d"):
                continue
            vec = coords[idx]
            entry["embedding_3d"] = [round(float(vec[0]), 4), round(float(vec[1]), 4), round(float(vec[2]), 4)]
            idx += 1
            changed += 1
        tmp = path.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)
        print(f"  wrote {path.name}: {changed:,} coords", flush=True)
    return idx


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-neighbors", type=int, default=50)
    ap.add_argument("--min-dist", type=float, default=0.01)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--reuse-coords", action="store_true", help="skip UMAP if semantic_umap50_min001_3d.npy exists")
    args = ap.parse_args()

    emb = np.load(EMB_PATH, mmap_mode="r")
    expected = count_rows()
    if expected != emb.shape[0]:
        raise RuntimeError(f"Row mismatch: words_emb has {expected:,} embedded rows, semantic embeddings has {emb.shape[0]:,}")

    print(f"Rows: {expected:,}; dim={emb.shape[1]}; source={WORDS_EMB_DIR}", flush=True)
    if args.reuse_coords and OUT_COORDS.exists():
        coords = np.load(OUT_COORDS, mmap_mode="r")
    else:
        print(f"Running UMAP n_neighbors={args.n_neighbors}, min_dist={args.min_dist}, metric=cosine", flush=True)
        t0 = time.time()
        reducer = umap.UMAP(
            n_components=3,
            n_neighbors=args.n_neighbors,
            min_dist=args.min_dist,
            metric="cosine",
            random_state=args.seed,
            low_memory=True,
            verbose=True,
        )
        coords = reducer.fit_transform(emb).astype(np.float32, copy=False)
        np.save(OUT_COORDS, coords)
        print(f"Saved coords: {OUT_COORDS} ({OUT_COORDS.stat().st_size/1024/1024:.1f} MB)", flush=True)
        print(f"UMAP elapsed: {(time.time()-t0)/60:.1f} min", flush=True)

    print("Writing coordinates back to words_emb JSON...", flush=True)
    written = write_coords(np.asarray(coords, dtype=np.float32))
    print(f"Done. Wrote {written:,} coordinates.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
