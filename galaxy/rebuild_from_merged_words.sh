#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="backup-before-merged-$STAMP"
mkdir -p "$BACKUP_DIR"
for f in 3D_galaxy/galaxy_data.bin 3D_galaxy/galaxy_words.json 3D_galaxy/galaxy_meta.json 3D_galaxy/galaxy.html atlas/atlas_data.parquet semantic/semantic_embeddings.f32.npy semantic/semantic_faiss_hnsw.index semantic/semantic_index_meta.json; do
  if [[ -e "$f" ]]; then
    mv "$f" "$BACKUP_DIR/$f"
  fi
done
export KEYBOARDRAGE_WORDS_EMB_DIR="$ROOT/words_emb_merged"
./venv/bin/python 3D_galaxy/generate_galaxy.py
./venv/bin/python atlas/generate_atlas.py
printf '\nMerged-data galaxy rebuilt. Backup: %s/%s\n' "$(pwd)" "$BACKUP_DIR"
printf 'Next, rebuild semantic embeddings/index against merged data if desired:\n'
printf '  KEYBOARDRAGE_WORDS_EMB_DIR=%s ./venv/bin/python semantic/build_semantic_index.py --resume\n' "$ROOT/words_emb_merged"
