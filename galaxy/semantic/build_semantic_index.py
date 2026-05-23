#!/usr/bin/env python3
"""
Build an academically meaningful semantic-neighbor index for KeyboardRage Galaxy.

This uses the same source text as embed_definitions.py: concatenated Wiktionary
definitions, embedded with ibm-granite/granite-embedding-97m-multilingual-r2 and
L2-normalized for cosine/inner-product search.

Outputs in this directory:
  semantic_embeddings.f32.npy   float32 normalized vectors, shape N x D
  semantic_faiss_hnsw.index     FAISS HNSW candidate index for fast lookup
  semantic_index_meta.json      model/order/index metadata

The browser never uses the 3D UMAP projection as semantic truth. The API queries
FAISS for candidates, then reranks using exact cosine scores from the saved
float32 embeddings.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import time
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer

try:
    import faiss  # type: ignore
except Exception:  # pragma: no cover
    faiss = None

ROOT = Path(__file__).resolve().parent.parent.parent
GALAXY_DIR = Path(__file__).resolve().parent
WORDS_EMB_DIR = Path(os.environ.get("KEYBOARDRAGE_WORDS_EMB_DIR", str(ROOT / "words_emb")))
ATLAS_PARQUET = GALAXY_DIR.parent / "atlas" / "atlas_data.parquet"
EMBEDDINGS_PATH = GALAXY_DIR / "semantic_embeddings.f32.npy"
FAISS_INDEX_PATH = GALAXY_DIR / "semantic_faiss_hnsw.index"
META_PATH = GALAXY_DIR / "semantic_index_meta.json"
MODEL_NAME = "ibm-granite/granite-embedding-97m-multilingual-r2"


def iter_entries():
    """Yield entries in the exact same sorted-file/word order as galaxy_data.bin."""
    files = sorted(glob.glob(str(WORDS_EMB_DIR / "*.json")))
    for fpath in files:
        basename = os.path.splitext(os.path.basename(fpath))[0]
        with open(fpath, "r", encoding="utf-8") as f:
            data = json.load(f)
        for entry in data.get("words", []):
            emb3 = entry.get("embedding_3d")
            if not emb3 or len(emb3) < 3:
                continue
            defs = entry.get("definitions", []) or []
            text = " | ".join(str(d).strip() for d in defs if str(d).strip())
            if not text:
                # Should be rare because only embedded rows have embedding_3d, but keep
                # deterministic order and a searchable semantic text.
                text = str(entry.get("word", ""))
            yield basename, str(entry.get("word", "")), text


def count_rows() -> int:
    return sum(1 for _ in iter_entries())


def build_embeddings(batch_size: int, resume: bool) -> tuple[int, int]:
    print("Counting source rows in words_emb/ ...", flush=True)
    n = count_rows()
    print(f"Rows: {n:,}", flush=True)

    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Loading model {MODEL_NAME} on {device} ...", flush=True)
    model = SentenceTransformer(MODEL_NAME, device=device)
    raw_dim = model.get_sentence_embedding_dimension()
    if raw_dim is None:
        raise RuntimeError("SentenceTransformer did not report an embedding dimension")
    dim = int(raw_dim)
    print(f"Embedding dimension: {dim}", flush=True)

    mode = "r+" if resume and EMBEDDINGS_PATH.exists() else "w+"
    embeddings = np.lib.format.open_memmap(
        EMBEDDINGS_PATH, mode=mode, dtype=np.float32, shape=(n, dim)
    )

    done_path = GALAXY_DIR / "semantic_embeddings.done.json"
    start_idx = 0
    if resume and done_path.exists():
        try:
            start_idx = int(json.load(open(done_path)).get("rows_done", 0))
            print(f"Resuming from row {start_idx:,}", flush=True)
        except Exception:
            start_idx = 0

    texts: list[str] = []
    row = 0
    t0 = time.time()
    for _basename, _word, text in iter_entries():
        if row < start_idx:
            row += 1
            continue
        texts.append(text)
        if len(texts) >= batch_size:
            vecs = model.encode(
                texts,
                batch_size=batch_size,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            ).astype(np.float32, copy=False)
            embeddings[row:row + len(texts)] = vecs
            row += len(texts)
            embeddings.flush()
            json.dump({"rows_done": row}, open(done_path, "w"))
            elapsed = max(time.time() - t0, 1e-6)
            print(f"  embedded {row:,}/{n:,} ({row/elapsed:.0f} rows/s)", flush=True)
            texts.clear()

    if texts:
        vecs = model.encode(
            texts,
            batch_size=batch_size,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        ).astype(np.float32, copy=False)
        embeddings[row:row + len(texts)] = vecs
        row += len(texts)
        embeddings.flush()
        json.dump({"rows_done": row}, open(done_path, "w"))

    if row != n:
        raise RuntimeError(f"Embedded {row} rows but expected {n}")

    done_path.unlink(missing_ok=True)
    print(f"Saved embeddings: {EMBEDDINGS_PATH} ({EMBEDDINGS_PATH.stat().st_size / 1024**3:.2f} GiB)")
    return n, dim


def build_faiss_index(hnsw_m: int, ef_construction: int, add_batch: int) -> None:
    if faiss is None:
        raise RuntimeError("faiss is not installed. Run: galaxy/venv/bin/pip install faiss-cpu")
    if not EMBEDDINGS_PATH.exists():
        raise FileNotFoundError(f"Missing {EMBEDDINGS_PATH}; run without --index-only first")

    embeddings = np.load(EMBEDDINGS_PATH, mmap_mode="r")
    n, dim = embeddings.shape
    print(f"Building FAISS HNSW index over {n:,} x {dim} normalized vectors ...", flush=True)
    index = faiss.IndexHNSWFlat(dim, hnsw_m, faiss.METRIC_INNER_PRODUCT)
    index.hnsw.efConstruction = ef_construction
    index.hnsw.efSearch = 128

    t0 = time.time()
    for start in range(0, n, add_batch):
        end = min(start + add_batch, n)
        # FAISS needs a contiguous float32 array.
        index.add(np.asarray(embeddings[start:end], dtype=np.float32))
        elapsed = max(time.time() - t0, 1e-6)
        print(f"  indexed {end:,}/{n:,} ({end/elapsed:.0f} vec/s)", flush=True)

    faiss.write_index(index, str(FAISS_INDEX_PATH))
    print(f"Saved FAISS index: {FAISS_INDEX_PATH} ({FAISS_INDEX_PATH.stat().st_size / 1024**3:.2f} GiB)")


def write_meta(n: int, dim: int, hnsw_m: int, ef_construction: int) -> None:
    meta = {
        "model": MODEL_NAME,
        "metric": "cosine_similarity_via_normalized_inner_product",
        "rows": n,
        "dim": dim,
        "order": "sorted words_emb/*.json, skipping rows without embedding_3d; matches galaxy_data.bin and atlas_data.parquet",
        "embeddings": EMBEDDINGS_PATH.name,
        "faiss_index": FAISS_INDEX_PATH.name,
        "faiss": {
            "type": "IndexHNSWFlat",
            "hnsw_m": hnsw_m,
            "ef_construction": ef_construction,
            "candidate_search_only": True,
            "final_scores": "exact rerank against semantic_embeddings.f32.npy",
        },
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with open(META_PATH, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(f"Saved metadata: {META_PATH}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-size", type=int, default=512)
    parser.add_argument("--resume", action="store_true", help="resume interrupted embedding generation")
    parser.add_argument("--index-only", action="store_true", help="only build FAISS from existing semantic_embeddings.f32.npy")
    parser.add_argument("--skip-index", action="store_true", help="write embeddings but do not build FAISS")
    parser.add_argument("--hnsw-m", type=int, default=32)
    parser.add_argument("--ef-construction", type=int, default=200)
    parser.add_argument("--add-batch", type=int, default=100_000)
    args = parser.parse_args()

    if args.index_only:
        arr = np.load(EMBEDDINGS_PATH, mmap_mode="r")
        n, dim = map(int, arr.shape)
    else:
        n, dim = build_embeddings(args.batch_size, args.resume)

    if not args.skip_index:
        build_faiss_index(args.hnsw_m, args.ef_construction, args.add_batch)

    write_meta(n, dim, args.hnsw_m, args.ef_construction)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
