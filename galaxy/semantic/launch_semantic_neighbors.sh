#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec ../venv/bin/uvicorn semantic_neighbors_server:app --host 127.0.0.1 --port 8703
