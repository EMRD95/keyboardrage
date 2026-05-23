#!/usr/bin/env python3
"""Build an exact FAISS IndexFlatIP for immediate semantic-neighbor testing.

The embeddings are already L2-normalized, so inner product is exact cosine similarity.
This is academically exact (no ANN approximation), but each query scans all vectors.
"""
from pathlib import Path
import json, time
import numpy as np
import faiss

GALAXY_DIR = Path(__file__).resolve().parent
EMBEDDINGS_PATH = GALAXY_DIR / "semantic_embeddings.f32.npy"
INDEX_PATH = GALAXY_DIR / "semantic_faiss_hnsw.index"  # server expects this name
META_PATH = GALAXY_DIR / "semantic_index_meta.json"

emb = np.load(EMBEDDINGS_PATH, mmap_mode="r")
n, dim = emb.shape
print(f"Building exact IndexFlatIP for {n:,} x {dim} normalized vectors", flush=True)
index = faiss.IndexFlatIP(dim)
for start in range(0, n, 100_000):
    end = min(start + 100_000, n)
    index.add(np.asarray(emb[start:end], dtype=np.float32))
    print(f"  added {end:,}/{n:,}", flush=True)
print(f"Writing {INDEX_PATH}", flush=True)
faiss.write_index(index, str(INDEX_PATH))
meta = {
    "model": "ibm-granite/granite-embedding-97m-multilingual-r2",
    "metric": "cosine_similarity_via_normalized_inner_product",
    "rows": int(n),
    "dim": int(dim),
    "order": "sorted words_emb/*.json, skipping rows without embedding_3d; matches galaxy_data.bin and atlas_data.parquet",
    "embeddings": EMBEDDINGS_PATH.name,
    "faiss_index": INDEX_PATH.name,
    "faiss": {
        "type": "IndexFlatIP",
        "exact": True,
        "candidate_search_only": False,
        "final_scores": "exact cosine over normalized float32 embeddings",
        "note": "Built for immediate testing after HNSW build was too hot/slow. Queries scan all vectors but ranking is exact."
    },
    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}
META_PATH.write_text(json.dumps(meta, indent=2))
print("done", flush=True)
