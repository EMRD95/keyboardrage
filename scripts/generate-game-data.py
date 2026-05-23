#!/usr/bin/env python3
"""Generate compact game-data + galaxy-coordinate artifacts for any language from words_emb_merged.

Usage:
  python3 scripts/generate-game-data.py english
  python3 scripts/generate-game-data.py french

Outputs in words/:
  <lang>.json                  word strings, frequency ordered, charLengthByFrequency
  <lang>-galaxy-coords.bin     compact int16 xyz coordinates, sourceIndex-aligned
  <lang>-galaxy-meta.json      normalization metadata
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "words"
CUBE_LIMIT = 0.82


def main() -> None:
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <language>", file=sys.stderr)
        sys.exit(1)

    language = sys.argv[1].lower()
    source_path = ROOT / "words_emb_merged" / f"{language}.json"
    if not source_path.exists():
        print(f"Source not found: {source_path}", file=sys.stderr)
        sys.exit(1)

    with source_path.open("r", encoding="utf-8") as f:
        source = json.load(f)

    entries = [
        entry for entry in source["words"]
        if isinstance(entry.get("word"), str) and len(entry.get("embedding_3d", [])) == 3
    ]
    words = [entry["word"] for entry in entries]
    coords = np.array([entry["embedding_3d"] for entry in entries], dtype=np.float32)

    # Use the same coordinate normalization as galaxy/3D_galaxy/galaxy_fly_three.html:
    # center by mean and scale by max Euclidean distance. This avoids the old
    # robust-percentile cube clipping that put ~2% of points exactly on cube faces.
    center = np.mean(coords, axis=0)
    centered = coords - center
    dist = np.linalg.norm(centered, axis=1)
    scale = float(np.max(dist))
    if not np.isfinite(scale) or scale <= 0:
        scale = 1.0
    normalized = centered / scale * CUBE_LIMIT
    quantized = np.rint(normalized / CUBE_LIMIT * 32767.0).astype("<i2")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    char_length = round(sum(len(w) for w in words) / max(len(words), 1), 2)

    # Sensible frequency tiers — cap at actual word count
    candidates = [200, 1000, 2000, 5000, 10000, 25000, 50000, 100000, len(words)]
    frequency_options: list[int] = []
    for value in candidates:
        if value <= len(words) and value not in frequency_options:
            frequency_options.append(value)

    char_length_by_frequency: dict[str, float] = {}
    for limit in frequency_options:
        subset = words[:limit]
        char_length_by_frequency[str(limit)] = round(sum(len(w) for w in subset) / len(subset), 2)

    lang_dir = OUT_DIR / language
    lang_dir.mkdir(parents=True, exist_ok=True)
    words_out = lang_dir / "words.json"
    coords_out = lang_dir / "galaxy-coords.bin"
    meta_out = lang_dir / "galaxy-meta.json"

    words_out.write_text(json.dumps({
        "name": language,
        "source": f"words_emb_merged/{language}.json",
        "orderedByFrequency": True,
        "charLength": char_length,
        "charLengthByFrequency": char_length_by_frequency,
        "frequencyOptions": frequency_options,
        "embeddingData": {
            "kind": "keyboardrage-galaxy-int16-v1",
            "coords": f"/words/{language}/galaxy-coords.bin",
            "meta": f"/words/{language}/galaxy-meta.json",
            "coordinateSystem": "words_emb embedding_3d, mean centered, max-distance scaled",
            "sourceIndexAligned": True
        },
        "words": words
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    with coords_out.open("wb") as f:
        f.write(b"KRG1")
        f.write(struct.pack("<I", len(words)))
        f.write(quantized.tobytes(order="C"))

    meta_out.write_text(json.dumps({
        "name": language,
        "source": f"words_emb_merged/{language}.json",
        "count": len(words),
        "format": "KRG1 uint32 count + int16 xyz[count]",
        "coordinateScale": CUBE_LIMIT,
        "normalization": {
            "center": [float(x) for x in center],
            "method": "mean centered, max-distance scaled",
            "scale": scale,
            "clamp": None
        },
        "lod": {
            "defaultVisibleDots": 1000,
            "maxVisibleDots": len(words),
            "oneWordOneDot": True,
            "activeWordExactCoordinate": True
        }
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    langs_out = OUT_DIR / "languagelist.json"
    existing: list[str] = []
    if langs_out.exists():
        try:
            existing = json.loads(langs_out.read_text(encoding="utf-8"))
        except Exception:
            existing = []
    langs: list[str] = []
    for lang in [*existing, "english", "french", language]:
        if lang not in langs:
            langs.append(lang)
    langs_out.write_text(json.dumps(langs, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"wrote {words_out} ({words_out.stat().st_size / 1024 / 1024:.2f} MB)")
    print(f"wrote {coords_out} ({coords_out.stat().st_size / 1024 / 1024:.2f} MB)")
    print(f"wrote {meta_out} ({meta_out.stat().st_size:.1f} KB)")
    print(f"words: {len(words):,}; avg chars: {char_length}; options: {frequency_options}")
    print(f"charLengthByFrequency: {char_length_by_frequency}")


if __name__ == "__main__":
    main()
