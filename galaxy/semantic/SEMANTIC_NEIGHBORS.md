# KeyboardRage semantic neighbors

This adds original-embedding semantic-neighbor inspection to `galaxy_fly_three.html`.

Note: I first prototyped the UI on `galaxy.html`, but the intended primary view is the Three.js fly-through view at:

```text
http://localhost:8888/galaxy/3D_galaxy/galaxy_fly_three.html
```

Important distinction:
- The 3D galaxy coordinates (`x/y/z`) are only the visual UMAP projection.
- Semantic neighbors are queried from original Granite definition embeddings.
- FAISS HNSW is only used for candidate retrieval.
- Final ranking/scores are exact cosine similarities against normalized float32 embeddings.

## One-time index build

From this directory:

```bash
../venv/bin/python build_semantic_index.py --resume
```

Outputs:
- `semantic_embeddings.f32.npy`
- `semantic_faiss_hnsw.index`
- `semantic_index_meta.json`

The embeddings file is large because it keeps float32 vectors for exact reranking.
For ~2.84M rows x 384 dims, expect about 4.1 GiB for the `.npy` plus the FAISS HNSW index.

## Run the backend

```bash
./launch_semantic_neighbors.sh
```

Equivalent:

```bash
../venv/bin/uvicorn semantic_neighbors_server:app --host 127.0.0.1 --port 8703
```

## Run the galaxy

From the project root:

```bash
cd /home/ubu/Desktop/keyboardrage
python3 -m http.server 8888
```

Open:

```text
http://localhost:8888/galaxy/3D_galaxy/galaxy_fly_three.html
```

Click `Inspect semantic neighbors: off` to enable the panel. Then click a point.

Controls:
- `K`: number of neighbors returned.
- `filter`: all / same language / cross-language.
- `lines`: show/hide 3D lines from selected point to semantic neighbors.
- `table`: show/hide the Atlas-style neighbor table.
- clicking a table row focuses that neighbor and queries its neighbors.

If the backend/index is not ready, the browser panel shows the exact command to start the server or build the index.
