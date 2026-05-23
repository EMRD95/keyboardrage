#!/usr/bin/env python3
"""
Generate a parquet file from word embeddings for Apple Embedding Atlas.
Reads all JSON files from ../words_emb/, extracts 3D coordinates, words,
definitions, and language labels, then writes to atlas_data.parquet.
"""

import json
import os
import glob
import pyarrow as pa
import pyarrow.parquet as pq

# Multi-word language overrides: basename -> language group
MULTI_WORD_OVERRIDES = {
    "chinese_simplified": "chinese_simplified",
    "chinese_traditional": "chinese_traditional",
    "norwegian_nynorsk": "norwegian_nynorsk",
    "armenian_western": "armenian_western",
    "swiss_german": "swiss_german",
    "serbian_latin": "serbian_latin",
    "ukrainian_latynka": "ukrainian_latynka",
    "belarusian_lacinka": "belarusian_lacinka",
    "esperanto_h_sistemo": "esperanto_h_sistemo",
    "esperanto_x_sistemo": "esperanto_x_sistemo",
    "tatar_crimean_cyrillic": "tatar_crimean_cyrillic",
    "tatar_crimean": "tatar_crimean",
    "arabic_egypt": "arabic_egypt",
    "arabic_morocco": "arabic_morocco",
    "japanese_romaji": "japanese_romaji",
    "japanese_hiragana": "japanese_hiragana",
    "japanese_katakana": "japanese_katakana",
    "portuguese_acentos_e_cedilha": "portuguese_acentos_e_cedilha",
}


def get_language(basename: str) -> str:
    """Determine the language group for a filename basename."""
    # Check multi-word overrides (longest match first)
    for prefix in sorted(MULTI_WORD_OVERRIDES.keys(), key=len, reverse=True):
        if basename == prefix or basename.startswith(prefix + "_"):
            return MULTI_WORD_OVERRIDES[prefix]
    # Default: first word before underscore
    return basename.split("_")[0]


def main():
    src_dir = os.environ.get(
        "KEYBOARDRAGE_WORDS_EMB_DIR",
        os.path.join(os.path.dirname(__file__), "..", "..", "words_emb"),
    )
    out_path = os.path.join(os.path.dirname(__file__), "atlas_data.parquet")

    files = sorted(glob.glob(os.path.join(src_dir, "*.json")))
    print(f"Found {len(files)} JSON files in {src_dir}")

    all_x = []
    all_y = []
    all_z = []
    all_words = []
    all_languages = []
    all_definitions = []

    for fpath in files:
        basename = os.path.splitext(os.path.basename(fpath))[0]
        language = get_language(basename)
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print(f"  SKIP {basename}: {e}")
            continue

        words_list = data.get("words", [])
        count = 0
        for entry in words_list:
            emb = entry.get("embedding_3d")
            if not emb or len(emb) < 3:
                continue
            word = entry.get("word", "")
            defs = entry.get("definitions", [])
            def_str = "; ".join(d for d in defs if d) if defs else ""

            all_x.append(float(emb[0]))
            all_y.append(float(emb[1]))
            all_z.append(float(emb[2]))
            all_words.append(word)
            all_languages.append(language)
            all_definitions.append(def_str)
            count += 1

        print(f"  {basename} -> {language}: {count} words")

    print(f"\nTotal words: {len(all_words)}")

    # Build PyArrow table
    table = pa.table({
        "x": pa.array(all_x, type=pa.float32()),
        "y": pa.array(all_y, type=pa.float32()),
        "z": pa.array(all_z, type=pa.float32()),
        "word": pa.array(all_words, type=pa.string()),
        "language": pa.array(all_languages, type=pa.string()),
        "definition": pa.array(all_definitions, type=pa.string()),
    })

    pq.write_table(table, out_path, row_group_size=100_000)
    fsize = os.path.getsize(out_path)
    print(f"\nWrote {out_path}")
    print(f"  Rows: {len(all_words)}")
    print(f"  Size: {fsize / (1024*1024):.1f} MB")
    print("Done!")


if __name__ == "__main__":
    main()
