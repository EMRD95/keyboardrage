#!/usr/bin/env python3
"""
Precompute top-200 cosine neighbors for all 2.25M word embedding points.

Uses PyTorch GPU (RTX 3090) for speed (~3-5 minutes) with chunked matrix
multiply. Falls back to CPU FAISS if CUDA is unavailable (~hours).

Outputs (in this directory):
  neighbor_ids.npy     (N x 200) int32   → 1.8 GB
  neighbor_scores.npy  (N x 200) float32 → 1.8 GB
  neighbor_meta.json                     → ~1 KB

After running, update semantic_neighbors_server.py to use precomputed arrays.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
EMBEDDINGS_PATH = HERE / "semantic_embeddings.f32.npy"
IDS_PATH = HERE / "neighbor_ids.npy"
SCORES_PATH = HERE / "neighbor_scores.npy"
META_PATH = HERE / "neighbor_meta.json"

TOP_K = 201  # 200 neighbors + self
OUTPUT_K = 200


def compute_gpu(chunk_size: int = 1024):
    """PyTorch GPU path: chunked matmul on RTX 3090."""
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA not available")
    device = torch.device("cuda")
    print(f"GPU: {torch.cuda.get_device_name(0)}", flush=True)

    # Load embeddings (already L2-normalized, memory-mapped)
    print("Loading embeddings (mmap)...", flush=True)
    emb_np = np.load(EMBEDDINGS_PATH, mmap_mode="r")
    n, dim = emb_np.shape
    print(f"Shape: {n:,} x {dim}, float32", flush=True)

    ids_out = np.lib.format.open_memmap(
        IDS_PATH, mode="w+", dtype=np.int32, shape=(n, OUTPUT_K)
    )
    scores_out = np.lib.format.open_memmap(
        SCORES_PATH, mode="w+", dtype=np.float32, shape=(n, OUTPUT_K)
    )

    # Move full database to GPU (3.46 GB)
    print("Moving embeddings to GPU...", flush=True)
    t_db = time.time()
    db_gpu = torch.from_numpy(np.asarray(emb_np, dtype=np.float32)).to(device)
    print(f"  done in {time.time() - t_db:.1f}s, "
          f"{torch.cuda.memory_allocated() / 1e9:.1f} GB allocated", flush=True)

    total_chunks = (n + chunk_size - 1) // chunk_size
    t0 = time.time()

    for chunk_idx, start in enumerate(range(0, n, chunk_size)):
        end = min(start + chunk_size, n)
        chunk_len = end - start

        # Load query chunk to GPU
        query_gpu = torch.from_numpy(
            np.asarray(emb_np[start:end], dtype=np.float32)
        ).to(device)

        # Cosine similarity via inner product (vectors already normalized)
        # query_chunk @ db.T → chunk_len x N
        sim = torch.mm(query_gpu, db_gpu.T)  # (chunk_len, N)

        # Top-k (including self at position [i, start+i])
        top_scores, top_ids = torch.topk(sim, k=TOP_K, dim=1, largest=True)

        # Move to CPU
        top_ids_cpu = top_ids.cpu().numpy().astype(np.int32)
        top_scores_cpu = top_scores.cpu().numpy().astype(np.float32)

        # Filter self-match and keep top OUTPUT_K
        for i in range(chunk_len):
            global_idx = start + i
            mask = top_ids_cpu[i] != global_idx
            filtered_ids = top_ids_cpu[i][mask][:OUTPUT_K]
            filtered_scores = top_scores_cpu[i][mask][:OUTPUT_K]
            ids_out[global_idx, :len(filtered_ids)] = filtered_ids
            scores_out[global_idx, :len(filtered_ids)] = filtered_scores

        # Free GPU tensors
        del query_gpu, sim, top_scores, top_ids
        torch.cuda.empty_cache()

        elapsed = time.time() - t0
        rate = (chunk_idx + 1) / elapsed if elapsed > 0 else 0
        eta = (total_chunks - chunk_idx - 1) / rate if rate > 0 else 0
        print(f"  chunk {chunk_idx + 1}/{total_chunks} "
              f"({end:,}/{n:,}) {rate:.1f} chunks/s ETA {eta:.0f}s", flush=True)

        if (chunk_idx + 1) % 100 == 0:
            ids_out.flush()
            scores_out.flush()

    ids_out.flush()
    scores_out.flush()
    del db_gpu
    torch.cuda.empty_cache()
    print(f"Total GPU time: {(time.time() - t0) / 60:.1f} min", flush=True)


def compute_cpu():
    """CPU fallback: FAISS IndexFlatIP."""
    import faiss

    print("Loading embeddings (mmap)...", flush=True)
    emb = np.load(EMBEDDINGS_PATH, mmap_mode="r")
    n, dim = emb.shape
    print(f"Shape: {n:,} x {dim}, float32", flush=True)

    ids_out = np.lib.format.open_memmap(
        IDS_PATH, mode="w+", dtype=np.int32, shape=(n, OUTPUT_K)
    )
    scores_out = np.lib.format.open_memmap(
        SCORES_PATH, mode="w+", dtype=np.float32, shape=(n, OUTPUT_K)
    )

    print("Building FAISS IndexFlatIP...", flush=True)
    index = faiss.IndexFlatIP(dim)
    index.add(np.asarray(emb, dtype=np.float32))

    print("Searching (this will take a while on CPU)...", flush=True)
    batch = 8192
    t0 = time.time()

    for start in range(0, n, batch):
        end = min(start + batch, n)
        q = np.asarray(emb[start:end], dtype=np.float32)
        scores, ids = index.search(q, TOP_K)

        for i in range(end - start):
            global_idx = start + i
            mask = ids[i] != global_idx
            k = min(OUTPUT_K, mask.sum())
            ids_out[global_idx, :k] = ids[i][mask][:k].astype(np.int32)
            scores_out[global_idx, :k] = scores[i][mask][:k].astype(np.float32)

        elapsed = time.time() - t0
        print(f"  {end:,}/{n:,} ({elapsed / 60:.1f} min)", flush=True)

    ids_out.flush()
    scores_out.flush()
    print(f"Total CPU time: {(time.time() - t0) / 60:.1f} min", flush=True)


def write_meta(n: int, dim: int, mode: str):
    meta = {
        "model": "ibm-granite/granite-embedding-97m-multilingual-r2",
        "metric": "cosine_similarity_via_normalized_inner_product",
        "rows": n,
        "dim": dim,
        "top_k": OUTPUT_K,
        "computation": mode,
        "neighbor_ids": IDS_PATH.name,
        "neighbor_scores": SCORES_PATH.name,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    META_PATH.write_text(json.dumps(meta, indent=2))
    print(f"Meta: {META_PATH}")


def main():
    print("=== Precomputing top-200 cosine neighbors ===", flush=True)

    # Remove stale outputs
    for p in [IDS_PATH, SCORES_PATH, META_PATH]:
        p.unlink(missing_ok=True)

    emb_np = np.load(EMBEDDINGS_PATH, mmap_mode="r")
    n, dim = emb_np.shape

    # Try GPU first
    try:
        import torch
        if torch.cuda.is_available():
            print("Using PyTorch GPU path", flush=True)
            compute_gpu()
            write_meta(n, dim, "pytorch_gpu")
            print("Done!", flush=True)
            return
    except Exception as e:
        print(f"GPU path failed: {e}", flush=True)
        print("Falling back to CPU...", flush=True)

    compute_cpu()
    write_meta(n, dim, "faiss_cpu")
    print("Done!", flush=True)


if __name__ == "__main__":
    main()
