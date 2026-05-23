#!/usr/bin/env bash
set -euo pipefail
ROOT="/home/ubu/Desktop/keyboardrage"
GALAXY="$ROOT/galaxy"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$GALAXY/rebuild_umap50_projection_$STAMP.log"
WORDS_BACKUP="$ROOT/words_emb_backup_before_umap50_$STAMP"
GALAXY_BACKUP="$GALAXY/backup-before-umap50-$STAMP"

exec > >(tee -a "$LOG") 2>&1

echo "[0/5] Rebuilding visual 3D projection only"
echo "Log: $LOG"

echo "[1/5] Stop semantic backend so it does not serve during coordinate rewrite"
pkill -f 'uvicorn semantic_neighbors_server:app' || true

echo "[2/5] Backup current merged words_emb before rewriting embedding_3d"
cp -a "$ROOT/words_emb" "$WORDS_BACKUP"
echo "words_emb backup: $WORDS_BACKUP"

cd "$GALAXY"
mkdir -p "$GALAXY_BACKUP"
echo "[3/5] Backup current visual artifacts"
for f in 3D_galaxy/galaxy_data.bin 3D_galaxy/galaxy_words.json 3D_galaxy/galaxy_meta.json 3D_galaxy/galaxy.html atlas/atlas_data.parquet 3D_galaxy/semantic_umap50_min001_3d.npy; do
  if [[ -e "$f" ]]; then
    cp -a "$f" "$GALAXY_BACKUP/$f"
  fi
done
echo "artifact backup: $GALAXY_BACKUP"

echo "[4/5] Run UMAP50/min_dist0.01 from existing Granite embeddings and write coords into words_emb"
./venv/bin/python 3D_galaxy/rebuild_umap50_coordinates.py --n-neighbors 50 --min-dist 0.01 --seed 42

echo "[5/5] Regenerate galaxy and atlas files. Semantic embeddings/index are unchanged and remain ID-aligned."
./venv/bin/python 3D_galaxy/generate_galaxy.py
./venv/bin/python atlas/generate_atlas.py

echo "Done. Restart backend with: cd $GALAXY && ./semantic/launch_semantic_neighbors.sh"
