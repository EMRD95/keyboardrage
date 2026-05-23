#!/usr/bin/env python3
"""Generate compact French gameplay + galaxy-coordinate artifacts from words_emb_merged.

Outputs consumed by the browser:
  words/french.json                 word strings only, frequency ordered
  words/french-galaxy-meta.json     normalization/format metadata
  words/french-galaxy-coords.bin    compact int16 xyz coordinates, aligned by sourceIndex
"""
from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "words_emb_merged" / "french.json"
OUT_DIR = ROOT / "words"
WORDS_OUT = OUT_DIR / "french.json"
META_OUT = OUT_DIR / "french-galaxy-meta.json"
COORDS_OUT = OUT_DIR / "french-galaxy-coords.bin"
LANGS_OUT = OUT_DIR / "languagelist.json"

CUBE_LIMIT = 0.82
ROBUST_PERCENTILE = 98.0


def main() -> None:
    with SOURCE.open("r", encoding="utf-8") as f:
        source = json.load(f)

    entries = [entry for entry in source["words"] if isinstance(entry.get("word"), str) and len(entry.get("embedding_3d", [])) == 3]
    words = [entry["word"] for entry in entries]
    coords = np.array([entry["embedding_3d"] for entry in entries], dtype=np.float32)

    center = np.median(coords, axis=0)
    centered = coords - center
    scale = float(np.percentile(np.max(np.abs(centered), axis=1), ROBUST_PERCENTILE))
    if not np.isfinite(scale) or scale <= 0:
        scale = float(np.max(np.abs(centered))) or 1.0
    normalized = np.clip(centered / scale * CUBE_LIMIT, -CUBE_LIMIT, CUBE_LIMIT)
    quantized = np.rint(normalized / CUBE_LIMIT * 32767.0).astype("<i2")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    char_length = sum(len(word) for word in words) / max(len(words), 1)
    frequency_options = [200, 1000, 2000, 10000, 50000, 100000, len(words)]
    frequency_options = [value for i, value in enumerate(frequency_options) if value <= len(words) and value not in frequency_options[:i]]

    WORDS_OUT.write_text(json.dumps({
        "name": "french",
        "source": "words_emb_merged/french.json",
        "orderedByFrequency": True,
        "charLength": char_length,
        "frequencyOptions": frequency_options,
        "embeddingData": {
            "kind": "keyboardrage-galaxy-int16-v1",
            "coords": "/words/french-galaxy-coords.bin",
            "meta": "/words/french-galaxy-meta.json",
            "coordinateSystem": "words_emb embedding_3d, median centered, robust scaled",
            "sourceIndexAligned": True
        },
        "words": words
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    with COORDS_OUT.open("wb") as f:
        f.write(b"KRG1")
        f.write(struct.pack("<I", len(words)))
        f.write(quantized.tobytes(order="C"))

    META_OUT.write_text(json.dumps({
        "name": "french",
        "source": "words_emb_merged/french.json",
        "count": len(words),
        "format": "KRG1 uint32 count + int16 xyz[count]",
        "coordinateScale": CUBE_LIMIT,
        "normalization": {
            "center": [float(x) for x in center],
            "robustPercentile": ROBUST_PERCENTILE,
            "scale": scale,
            "clamp": [-CUBE_LIMIT, CUBE_LIMIT]
        },
        "lod": {
            "defaultVisibleDots": 1000,
            "maxVisibleDots": len(words),
            "oneWordOneDot": True,
            "activeWordExactCoordinate": True
        }
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    existing_langs: list[str] = []
    if LANGS_OUT.exists():
        try:
            existing_langs = json.loads(LANGS_OUT.read_text(encoding="utf-8"))
        except Exception:
            existing_langs = []
    langs = []
    for lang in [*existing_langs, "english", "french"]:
        if lang not in langs:
            langs.append(lang)
    LANGS_OUT.write_text(json.dumps(langs, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"wrote {WORDS_OUT} ({WORDS_OUT.stat().st_size / 1024 / 1024:.2f} MB)")
    print(f"wrote {COORDS_OUT} ({COORDS_OUT.stat().st_size / 1024 / 1024:.2f} MB)")
    print(f"wrote {META_OUT} ({META_OUT.stat().st_size / 1024:.1f} KB)")
    print(f"words: {len(words):,}; avg chars: {char_length:.2f}; options: {frequency_options}")


if __name__ == "__main__":
    main()
