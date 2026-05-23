#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/ubu/Desktop/keyboardrage"
GALAXY="$ROOT/galaxy"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORDS_BACKUP="$ROOT/words_emb_backup_before_merge_$STAMP"
GALAXY_BACKUP="$GALAXY/backup-before-merged-full-$STAMP"
LOG="$GALAXY/full_rebuild_from_merged_$STAMP.log"

exec > >(tee -a "$LOG") 2>&1

echo "[0/9] Starting full merged rebuild at $STAMP"
echo "Root: $ROOT"
echo "Log: $LOG"

cd "$ROOT"

echo "[1/9] Stopping semantic backend on :8703 if running"
pkill -f 'uvicorn semantic_neighbors_server:app' || true

if [[ ! -d "$ROOT/words_emb_merged" ]]; then
  echo "ERROR: missing $ROOT/words_emb_merged. Run merge_words_emb_by_language.py first." >&2
  exit 1
fi

if [[ -d "$ROOT/words_emb" && ! -L "$ROOT/words_emb" ]]; then
  echo "[2/9] Backing up old embedded word lists"
  mv "$ROOT/words_emb" "$WORDS_BACKUP"
  echo "Backed up original words_emb to: $WORDS_BACKUP"
else
  echo "[2/9] No normal words_emb dir found to backup"
fi

echo "[3/9] Installing merged word lists as active words_emb"
cp -a "$ROOT/words_emb_merged" "$ROOT/words_emb"

cd "$GALAXY"
mkdir -p "$GALAXY_BACKUP"
echo "[4/9] Backing up old galaxy/atlas/semantic artifacts to $GALAXY_BACKUP"
for f in 3D_galaxy/galaxy_data.bin 3D_galaxy/galaxy_words.json 3D_galaxy/galaxy_meta.json 3D_galaxy/galaxy.html atlas/atlas_data.parquet semantic/semantic_embeddings.f32.npy semantic/semantic_faiss_hnsw.index semantic/semantic_index_meta.json semantic/semantic_embeddings.done.json; do
  if [[ -e "$f" ]]; then
    mv "$f" "$GALAXY_BACKUP/$f"
  fi
done

echo "[5/9] Regenerating galaxy binary/words/meta from merged words_emb"
./venv/bin/python 3D_galaxy/generate_galaxy.py

echo "[6/9] Regenerating Apple Atlas parquet from merged words_emb"
./venv/bin/python atlas/generate_atlas.py

echo "[7/9] Rebuilding semantic embeddings from merged words_emb (skip HNSW)"
rm -f semantic/semantic_embeddings.f32.npy semantic/semantic_embeddings.done.json semantic/semantic_faiss_hnsw.index semantic/semantic_index_meta.json
./venv/bin/python semantic/build_semantic_index.py --resume --skip-index

echo "[8/9] Precomputing top-200 neighbors (GPU, ~14 min)"
./venv/bin/python semantic/precompute_neighbors.py

echo "Done. Backups:"
echo "  words_emb backup: $WORDS_BACKUP"
echo "  galaxy artifact backup: $GALAXY_BACKUP"
echo "Restart backend with: cd $GALAXY && ./semantic/launch_semantic_neighbors.sh"
