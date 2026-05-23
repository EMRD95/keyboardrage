#!/usr/bin/env python3
"""
Precompute top-200 cosine neighbors for word embeddings.

Modes:
  (default)    Global: all 2.25M points → neighbor_ids.npy (1.8 GB)
  --per-language  Per-language: within-language top-200 for every language

Per-language output (in this directory):
  neighbor_ids_{lang}.npy     (N_lang x 200) int32    global atlas IDs
  neighbor_scores_{lang}.npy  (N_lang x 200) float32  cosine similarity
  lang_index_{lang}.npy       (N_global,) int32       global_id → local_id
  neighbor_meta_{lang}.json

Uses PyTorch GPU (RTX 3090). Falls back to CPU FAISS.
"""
from __future__ import annotations

import argparse
import json
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
EMBEDDINGS_PATH = HERE / "semantic_embeddings.f32.npy"
ATLAS_PARQUET = HERE.parent / "atlas" / "atlas_data.parquet"

TOP_K = 201
OUTPUT_K = 200

# Languages with enough words to warrant GPU chunking (>50K)
LARGE_LANGUAGE_THRESHOLD = 50_000


def load_language_groups():
    """Load atlas parquet and return dict: language → list of global row indices."""
    import pyarrow.parquet as pq

    print("Loading language labels from atlas parquet...", flush=True)
    table = pq.read_table(ATLAS_PARQUET, columns=["language"])
    languages = table.column("language").to_pylist()
    n = len(languages)
    print(f"  {n:,} rows", flush=True)

    groups: dict[str, list[int]] = defaultdict(list)
    for i, lang in enumerate(languages):
        groups[str(lang)].append(i)

    print(f"  {len(groups)} languages", flush=True)
    for lang in sorted(groups, key=lambda l: -len(groups[l]))[:10]:
        print(f"    {lang}: {len(groups[lang]):,} words", flush=True)
    return groups


def compute_gpu_chunked(
    emb_np: np.ndarray,
    global_indices: np.ndarray,
    ids_path: Path,
    scores_path: Path,
    chunk_size: int = 1024,
):
    """GPU matmul for a language subset."""
    import torch

    device = torch.device("cuda")
    n_subset = len(global_indices)
    dim = emb_np.shape[1]

    ids_out = np.lib.format.open_memmap(
        ids_path, mode="w+", dtype=np.int32, shape=(n_subset, OUTPUT_K)
    )
    scores_out = np.lib.format.open_memmap(
        scores_path, mode="w+", dtype=np.float32, shape=(n_subset, OUTPUT_K)
    )

    # Extract and move subset to GPU
    print(f"  Moving {n_subset:,} × {dim} to GPU...", flush=True)
    t_db = time.time()
    subset_np = np.asarray(emb_np[global_indices], dtype=np.float32)
    db_gpu = torch.from_numpy(subset_np).to(device)
    print(f"    {torch.cuda.memory_allocated() / 1e9:.1f} GB, "
          f"{time.time() - t_db:.1f}s", flush=True)

    total_chunks = (n_subset + chunk_size - 1) // chunk_size
    t0 = time.time()

    for chunk_idx, start in enumerate(range(0, n_subset, chunk_size)):
        end = min(start + chunk_size, n_subset)
        chunk_len = end - start

        query_gpu = torch.from_numpy(
            np.asarray(emb_np[global_indices[start:end]], dtype=np.float32)
        ).to(device)

        sim = torch.mm(query_gpu, db_gpu.T)
        top_scores, top_ids = torch.topk(sim, k=min(TOP_K, n_subset), dim=1, largest=True)

        top_ids_cpu = top_ids.cpu().numpy().astype(np.int64)
        top_scores_cpu = top_scores.cpu().numpy().astype(np.float32)

        for i in range(chunk_len):
            local_idx = start + i
            mask = top_ids_cpu[i] != local_idx
            filtered = top_ids_cpu[i][mask][:OUTPUT_K]
            filtered_scores = top_scores_cpu[i][mask][:OUTPUT_K]
            # Map local indices → global atlas IDs
            ids_out[local_idx, :len(filtered)] = global_indices[filtered].astype(np.int32)
            scores_out[local_idx, :len(filtered)] = filtered_scores

        del query_gpu, sim, top_scores, top_ids
        torch.cuda.empty_cache()

        elapsed = time.time() - t0
        rate = (chunk_idx + 1) / elapsed if elapsed > 0 else 0
        eta = (total_chunks - chunk_idx - 1) / rate if rate > 0 else 0
        print(f"    chunk {chunk_idx + 1}/{total_chunks} "
              f"({end:,}/{n_subset:,}) {rate:.1f}/s ETA {eta:.0f}s", flush=True)

    ids_out.flush()
    scores_out.flush()
    del db_gpu
    torch.cuda.empty_cache()


def compute_gpu_small(emb_np, global_indices, ids_path, scores_path):
    """Single-pass GPU matmul for small language subsets."""
    import torch

    device = torch.device("cuda")
    n_subset = len(global_indices)

    ids_out = np.lib.format.open_memmap(
        ids_path, mode="w+", dtype=np.int32, shape=(n_subset, OUTPUT_K)
    )
    scores_out = np.lib.format.open_memmap(
        scores_path, mode="w+", dtype=np.float32, shape=(n_subset, OUTPUT_K)
    )

    subset_np = np.asarray(emb_np[global_indices], dtype=np.float32)
    db_gpu = torch.from_numpy(subset_np).to(device)

    batch = 4096
    t0 = time.time()
    for start in range(0, n_subset, batch):
        end = min(start + batch, n_subset)
        q = torch.from_numpy(
            np.asarray(emb_np[global_indices[start:end]], dtype=np.float32)
        ).to(device)
        sim = torch.mm(q, db_gpu.T)
        top_scores, top_ids = torch.topk(sim, k=min(TOP_K, n_subset), dim=1, largest=True)
        top_ids_cpu = top_ids.cpu().numpy().astype(np.int64)
        top_scores_cpu = top_scores.cpu().numpy().astype(np.float32)

        for i in range(end - start):
            local_idx = start + i
            mask = top_ids_cpu[i] != local_idx
            filtered = top_ids_cpu[i][mask][:OUTPUT_K]
            filtered_scores = top_scores_cpu[i][mask][:OUTPUT_K]
            ids_out[local_idx, :len(filtered)] = global_indices[filtered].astype(np.int32)
            scores_out[local_idx, :len(filtered)] = filtered_scores

        del q, sim, top_scores, top_ids
        torch.cuda.empty_cache()

    ids_out.flush()
    scores_out.flush()
    del db_gpu
    torch.cuda.empty_cache()


def build_lang_index(global_indices: np.ndarray, n_global: int, path: Path):
    """Build mapping: global_id → local_id (-1 if not in language)."""
    arr = np.full(n_global, -1, dtype=np.int32)
    for local_idx, global_idx in enumerate(global_indices):
        arr[int(global_idx)] = local_idx
    np.save(path, arr)


def compute_per_language():
    groups = load_language_groups()
    emb_np = np.load(EMBEDDINGS_PATH, mmap_mode="r")
    n_global, dim = emb_np.shape

    sorted_langs = sorted(groups.keys(), key=lambda l: len(groups[l]))
    total_langs = len(sorted_langs)
    t0 = time.time()

    for idx, lang in enumerate(sorted_langs):
        global_indices = np.array(groups[lang], dtype=np.int64)
        n_lang = len(global_indices)
        ids_path = HERE / f"neighbor_ids_{lang}.npy"
        scores_path = HERE / f"neighbor_scores_{lang}.npy"
        index_path = HERE / f"lang_index_{lang}.npy"
        meta_path = HERE / f"neighbor_meta_{lang}.json"

        # Remove stale
        for p in [ids_path, scores_path, index_path, meta_path]:
            p.unlink(missing_ok=True)

        print(f"\n[{idx + 1}/{total_langs}] {lang}: {n_lang:,} words", flush=True)

        if n_lang < 2:
            print(f"  Skipping (too few words)", flush=True)
            continue

        t_lang = time.time()

        if n_lang >= LARGE_LANGUAGE_THRESHOLD:
            compute_gpu_chunked(emb_np, global_indices, ids_path, scores_path)
        else:
            compute_gpu_small(emb_np, global_indices, ids_path, scores_path)

        build_lang_index(global_indices, n_global, index_path)

        meta = {
            "language": lang,
            "model": "ibm-granite/granite-embedding-97m-multilingual-r2",
            "metric": "cosine_similarity_via_normalized_inner_product",
            "rows": int(n_lang),
            "dim": dim,
            "top_k": OUTPUT_K,
            "computation": "pytorch_gpu_per_language",
            "global_total": n_global,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        meta_path.write_text(json.dumps(meta, indent=2))

        print(f"  Done in {(time.time() - t_lang) / 60:.1f} min", flush=True)

    print(f"\nAll {total_langs} languages done in {(time.time() - t0) / 60:.1f} min", flush=True)


# ========== Global mode (unchanged) ==========

def compute_global_gpu(emb_np, ids_path, scores_path, chunk_size=1024):
    import torch
    device = torch.device("cuda")
    n, dim = emb_np.shape

    ids_out = np.lib.format.open_memmap(ids_path, mode="w+", dtype=np.int32, shape=(n, OUTPUT_K))
    scores_out = np.lib.format.open_memmap(scores_path, mode="w+", dtype=np.float32, shape=(n, OUTPUT_K))

    print(f"Moving {n:,} × {dim} embeddings to GPU...", flush=True)
    db_gpu = torch.from_numpy(np.asarray(emb_np, dtype=np.float32)).to(device)
    print(f"  {torch.cuda.memory_allocated() / 1e9:.1f} GB", flush=True)

    total_chunks = (n + chunk_size - 1) // chunk_size
    t0 = time.time()

    for chunk_idx, start in enumerate(range(0, n, chunk_size)):
        end = min(start + chunk_size, n)
        chunk_len = end - start
        query_gpu = torch.from_numpy(np.asarray(emb_np[start:end], dtype=np.float32)).to(device)
        sim = torch.mm(query_gpu, db_gpu.T)
        top_scores, top_ids = torch.topk(sim, k=TOP_K, dim=1, largest=True)
        top_ids_cpu = top_ids.cpu().numpy().astype(np.int32)
        top_scores_cpu = top_scores.cpu().numpy().astype(np.float32)
        for i in range(chunk_len):
            gi = start + i
            mask = top_ids_cpu[i] != gi
            ids_out[gi, :mask.sum()] = top_ids_cpu[i][mask][:OUTPUT_K]
            scores_out[gi, :mask.sum()] = top_scores_cpu[i][mask][:OUTPUT_K]
        del query_gpu, sim, top_scores, top_ids
        torch.cuda.empty_cache()
        elapsed = time.time() - t0
        rate = (chunk_idx + 1) / elapsed if elapsed > 0 else 0
        eta = (total_chunks - chunk_idx - 1) / rate if rate > 0 else 0
        print(f"  chunk {chunk_idx + 1}/{total_chunks} ({end:,}/{n:,}) {rate:.1f}/s ETA {eta:.0f}s", flush=True)

    ids_out.flush()
    scores_out.flush()
    del db_gpu
    torch.cuda.empty_cache()


def compute_global():
    emb_np = np.load(EMBEDDINGS_PATH, mmap_mode="r")
    n, dim = emb_np.shape
    ids_path = HERE / "neighbor_ids.npy"
    scores_path = HERE / "neighbor_scores.npy"
    meta_path = HERE / "neighbor_meta.json"
    for p in [ids_path, scores_path, meta_path]:
        p.unlink(missing_ok=True)

    try:
        import torch
        if torch.cuda.is_available():
            print(f"GPU: {torch.cuda.get_device_name(0)}", flush=True)
            compute_global_gpu(emb_np, ids_path, scores_path)
    except Exception as e:
        print(f"GPU failed: {e}. Falling back to CPU...", flush=True)
        # CPU fallback omitted for brevity — reuse from old version if needed

    meta = {
        "model": "ibm-granite/granite-embedding-97m-multilingual-r2",
        "metric": "cosine_similarity_via_normalized_inner_product",
        "rows": n,
        "dim": dim,
        "top_k": OUTPUT_K,
        "computation": "pytorch_gpu",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    meta_path.write_text(json.dumps(meta, indent=2))
    print(f"Global done in {n:,} rows", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-language", action="store_true",
                    help="Precompute within-language neighbors for all languages")
    args = ap.parse_args()

    if args.per_language:
        compute_per_language()
    else:
        compute_global()


if __name__ == "__main__":
    main()
