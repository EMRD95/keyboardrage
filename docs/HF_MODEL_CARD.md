---
language:
- af
- am
- ar
- hy
- az
- bn
- ba
- be
- bs
- bg
- ca
- zh
- hr
- cs
- da
- nl
- en
- eo
- et
- eu
- fil
- fi
- fr
- fur
- gl
- ka
- de
- el
- gu
- ha
- haw
- he
- hi
- hu
- is
- id
- ga
- it
- ja
- kn
- kk
- km
- ko
- ky
- lo
- la
- lv
- lt
- mk
- mg
- ms
- ml
- mt
- mr
- mn
- my
- ne
- nn
- oc
- om
- ps
- fa
- pl
- pt
- ro
- ru
- sa
- sat
- sr
- sn
- si
- sk
- sl
- es
- sw
- sv
- gsw
- ta
- tt
- te
- th
- bo
- tr
- udm
- uk
- ur
- uz
- vi
- cy
- xh
- yi
- yo
- zu
tags:
- keyboardrage
- semantic-search
- embeddings
- typing-game
- multilingual
- faiss
- granite-embedding
license: mit
datasets:
- wiktionary
- monkeytype
---

# KeyboardRage Semantic Models

Precomputed multilingual semantic embeddings and neighbor indices for the [KeyboardRage](https://github.com/EMRD95/keyboardrage) typing game's Galaxy visualization.

## Overview

This repository contains the trained semantic models that power the 3D semantic word galaxy in KeyboardRage. 2,250,636 words across 108 languages are embedded into a 384-dimensional space using IBM's Granite multilingual embedding model, then projected to 3D via UMAP. Precomputed nearest-neighbor indices enable real-time similarity queries.

## Contents

### Global embeddings & index (15 GB)
| File | Size | Description |
|------|------|-------------|
| `semantic_embeddings.f32.npy` | 3.3 GB | Float32 embeddings for all 2.25M words (384-dim, inner-product normalized) |
| `semantic_faiss_hnsw.index` | 3.3 GB | FAISS flat inner-product index (exact cosine similarity over normalized vectors) |
| `neighbor_ids.npy` | 1.7 GB | Precomputed global top-200 neighbor IDs (rows × 200, int64) |
| `neighbor_scores.npy` | 1.7 GB | Precomputed global top-200 cosine similarity scores (float32) |
| `semantic_index_meta.json` | ~1 KB | Model metadata (embedding model, dimensions, row count) |

### Per-language neighbor indices
108 languages, each with 4 files:
- `neighbor_ids_{lang}.npy` — precomputed within-language top-200 neighbor IDs
- `neighbor_scores_{lang}.npy` — cosine similarity scores
- `lang_index_{lang}.npy` — global-ID → local-ID mapping
- `neighbor_meta_{lang}.json` — per-language statistics

### 3D projection metadata
| File | Size | Description |
|------|------|-------------|
| `atlas_data.parquet` | 88 MB | Word metadata: 3D UMAP coordinates (x, y, z), word, language, definition |

### Raw word embeddings (834 MB)
`words_emb_merged/{lang}.json` — raw embedding vectors per language, used for regeneration workflows.

## Model Details

- **Embedding model**: [ibm-granite/granite-embedding-97m-multilingual-r2](https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2)
- **Embedding dimension**: 384
- **Total words embedded**: 2,250,636
- **Languages**: 108
- **Similarity metric**: Cosine similarity via normalized inner product
- **3D projection**: UMAP (n_components=3, metric='cosine')
- **Neighbor count**: Top 200 per word (global + per-language)

## 108 Supported Languages

afrikaans, albanian, amharic, arabic (+egypt, +morocco), armenian (+western), azerbaijani, bangla, bashkir, belarusian (+lacinka), bosnian, bulgarian, catalan, chinese_simplified, chinese_traditional, croatian, czech, danish, dutch, english, esperanto (+h_sistemo, +x_sistemo), estonian, euskera, filipino, finnish, french, friulian, galician, georgian, german, greek, gujarati, hausa, hawaiian, hebrew, hindi, hungarian, icelandic, indonesian, irish, italian, japanese (hiragana, katakana, romaji), kannada, kazakh, khmer, korean, kyrgyz, lao, latin, latvian, lithuanian, macedonian, malagasy, malay, malayalam, maltese, marathi, mongolian, myanmar, nepali, norwegian_nynorsk, occitan, oromo, pashto, persian, polish, portuguese (+acentos_e_cedilha), romanian, russian, sanskrit, santali, serbian (+latin), shona, sinhala, slovak, slovenian, spanish, swahili, swedish, swiss_german, tamil, tatar (+crimean, +crimean_cyrillic), telugu, thai, tibetan, turkish, udmurt, ukrainian (+latynka), urdu, uzbek, vietnamese, welsh, xhosa, yiddish, yoruba, zulu

## On-Premise Deployment

### Prerequisites
- Python 3.10+
- FastAPI, NumPy, DuckDB, PyArrow

### Quick start

```bash
# 1. Clone the game code
git clone https://github.com/EMRD95/keyboardrage
cd keyboardrage

# 2. Download models from HuggingFace
./setup.sh

# 3. Run the semantic neighbors API
cd galaxy/semantic
pip install fastapi uvicorn numpy duckdb pyarrow
python semantic_neighbors_server.py
# API available at http://localhost:8703
```

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Server status, available languages, row count |
| `GET /point/{id}` | Get word metadata by global ID |
| `GET /neighbors/{id}?k=10&language=french` | Get nearest neighbors (global or per-language) |
| `GET /search?q=mot&language=french` | Full-text word search |

## Source Code

The KeyboardRage game source code and visualization themes are at:
**[github.com/EMRD95/keyboardrage](https://github.com/EMRD95/keyboardrage)**

## Regeneration

To rebuild these models from scratch:

```bash
# 1. Rebuild embeddings from merged word lists
cd galaxy && ./rebuild_from_merged_words.sh

# 2. Rebuild semantic index
cd semantic && python build_semantic_index.py

# 3. Precompute neighbors
python precompute_neighbors.py --per-language

# 4. Rebuild 3D projection
cd ../3D_galaxy && ./run_umap50_projection_rebuild.sh
```

All rebuild scripts are in the [GitHub repository](https://github.com/EMRD95/keyboardrage/tree/develop/galaxy).

## License

MIT — same as KeyboardRage.
