#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
URL="$(cat atlas_language_url.txt)"
echo "Starting Apple Embedding Atlas on http://localhost:5055/"
echo "Default language-colored view:"
echo "$URL"
echo
ATLAS_DATA="atlas_data.parquet"
exec ../venv/bin/embedding-atlas "$ATLAS_DATA" --x x --y y --text word --duckdb server --port 5055
