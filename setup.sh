#!/usr/bin/env bash
# KeyboardRage — Download semantic models from HuggingFace
# Usage: ./setup.sh [--force]
#
# Downloads the full semantic model bundle (~16 GB) from:
#   https://huggingface.co/emrd95/keyboardrage-semantic
#
# Prerequisites: hf CLI (https://hf.co/cli/install.sh)
#   curl -LsSf https://hf.co/cli/install.sh | bash -s
#   hf auth login   # optional, only needed for private repos

set -euo pipefail

HF_REPO="emrd95/keyboardrage-semantic"
FORCE=false

if [[ "${1:-}" == "--force" ]]; then
    FORCE=true
    shift
fi

# ── Check hf CLI ──────────────────────────────────────────────
if ! command -v hf &>/dev/null; then
    echo "ERROR: 'hf' CLI not found."
    echo "Install: curl -LsSf https://hf.co/cli/install.sh | bash -s"
    exit 1
fi

# ── Check if already downloaded ────────────────────────────────
SEMANTIC_CHECK="galaxy/semantic/semantic_embeddings.f32.npy"
ATLAS_CHECK="galaxy/atlas/atlas_data.parquet"
WORDS_CHECK="words_emb_merged/english.json"

already_have_all() {
    [[ -f "$SEMANTIC_CHECK" ]] && [[ -f "$ATLAS_CHECK" ]] && [[ -f "$WORDS_CHECK" ]]
}

if already_have_all && ! $FORCE; then
    SIZE=$(du -sh galaxy/semantic/ words_emb_merged/ galaxy/atlas/atlas_data.parquet 2>/dev/null | awk '{sum+=$1} END {print sum}')
    echo "Models already present (~${SIZE:-?} GB). Use --force to re-download."
    exit 0
fi

# ── Download ──────────────────────────────────────────────────
echo "Downloading semantic models from HuggingFace..."
echo "Repo: https://huggingface.co/${HF_REPO}"
echo ""

# Download galaxy/semantic/ data files (npy, index, json, server script)
echo "[1/3] galaxy/semantic/ …"
hf download "$HF_REPO" galaxy/semantic/ \
    --include "*.npy" "*.index" "*.json" "semantic_neighbors_server.py" \
    --local-dir . 2>&1 | tail -5

# Download atlas metadata
echo "[2/3] galaxy/atlas/atlas_data.parquet …"
hf download "$HF_REPO" galaxy/atlas/atlas_data.parquet \
    --local-dir . 2>&1 | tail -3

# Download word embeddings
echo "[3/3] words_emb_merged/ …"
hf download "$HF_REPO" --include "words_emb_merged/*.json" --local-dir . 2>&1 | tail -5

# Download pre-generated galaxy visualisation files
echo "[4/4] galaxy/3D_galaxy/ (viewer data) …"
hf download "$HF_REPO" galaxy/3D_galaxy/galaxy_data.bin galaxy/3D_galaxy/galaxy_words.json galaxy/3D_galaxy/galaxy_meta.json --local-dir . 2>&1 | tail -5

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Download complete."
echo ""
echo "Directory structure:"
echo "  galaxy/semantic/   — embeddings, FAISS index, precomputed neighbors (108 languages)"
echo "  galaxy/atlas/       — 3D projection metadata"
echo "  galaxy/3D_galaxy/   — pre-generated 3D galaxy viewer data"
echo "  words_emb_merged/   — raw word embeddings per language"
echo ""
echo "To start the semantic neighbors API:"
echo "  cd galaxy/semantic"
echo "  pip install fastapi uvicorn numpy duckdb pyarrow"
echo "  python semantic_neighbors_server.py"
echo ""
echo "API will be available at http://localhost:8703"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
