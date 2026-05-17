#!/usr/bin/env python3
"""Generate capped Box Matrix embedding point sets for every KeyboardRage language.

Large word lists are reduced to at most 1000 visible dots by clustering a
representative candidate pool with MiniBatchKMeans in Granite embedding space.
The generated TypeScript module is loaded by both Box Matrix and Box Cube.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.cluster import MiniBatchKMeans
from sklearn.decomposition import PCA

ROOT = Path(__file__).resolve().parents[1]
WORDS_DIR = ROOT / "words"
OUT_PATH = ROOT / "themes" / "box-embedding-data.ts"

MODEL_NAME = "ibm-granite/granite-embedding-97m-multilingual-r2"
MAX_DOTS_PER_LANGUAGE = 1000
MAX_CLUSTER_CANDIDATES = 6000
FORCED_HEAD_WORDS = 200
CUBE_LIMIT = 0.82


@dataclass(frozen=True)
class LanguageSource:
    key: str
    words: list[str]
    source_indices: list[int]
    source_count: int
    ordered_by_frequency: bool | None
    candidates: list[str]
    forced_words: list[str]


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def stable_seed(value: str) -> int:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
    return int(digest[:8], 16)


def unique_words_with_indices(raw_words: list[Any]) -> tuple[list[str], list[int]]:
    seen: set[str] = set()
    words: list[str] = []
    source_indices: list[int] = []
    for source_index, raw in enumerate(raw_words):
        word = str(raw).strip()
        if not word:
            continue
        key = word.casefold()
        if key in seen:
            continue
        seen.add(key)
        words.append(word)
        source_indices.append(source_index)
    return words, source_indices


def load_language_words(language: str) -> tuple[list[str], list[int], bool | None]:
    payload = read_json(WORDS_DIR / f"{language}.json")
    if isinstance(payload, list):
        words, source_indices = unique_words_with_indices(payload)
        return words, source_indices, None
    raw_words = payload.get("words", [])
    if not isinstance(raw_words, list):
        raise ValueError(f"words/{language}.json does not contain a words array")
    words, source_indices = unique_words_with_indices(raw_words)
    ordered = payload.get("orderedByFrequency")
    if ordered is None:
        ordered_value = None
    else:
        ordered_value = bool(ordered)
    return words, source_indices, ordered_value


def choose_candidate_words(language: str, words: list[str], ordered_by_frequency: bool | None) -> list[str]:
    if len(words) <= MAX_CLUSTER_CANDIDATES:
        return words[:]

    indices: set[int] = set()

    # Preserve high-frequency heads where the file claims or appears to be ordered.
    # Explicit orderedByFrequency=false files (huge dictionary-style bases) skip this
    # so the 1000 dots are not wasted on one alphabetic prefix.
    if ordered_by_frequency is not False:
        indices.update(range(min(FORCED_HEAD_WORDS, len(words))))

    remaining = MAX_CLUSTER_CANDIDATES - len(indices)
    if remaining > 0:
        for i in range(remaining):
            idx = round(i * (len(words) - 1) / max(remaining - 1, 1))
            indices.add(idx)

    # Fill collisions from deterministic random positions.
    rng = np.random.default_rng(stable_seed(language))
    while len(indices) < MAX_CLUSTER_CANDIDATES:
        indices.add(int(rng.integers(0, len(words))))

    return [words[i] for i in sorted(indices)]


def forced_words_for_source(words: list[str], ordered_by_frequency: bool | None) -> list[str]:
    if len(words) <= MAX_DOTS_PER_LANGUAGE:
        return []
    if ordered_by_frequency is False:
        return []
    return words[: min(FORCED_HEAD_WORDS, MAX_DOTS_PER_LANGUAGE // 4, len(words))]


def l2_normalize_rows(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix / np.maximum(norms, 1e-8)


def select_cluster_representatives(
    language: str,
    source: LanguageSource,
    embedding_by_word: dict[str, np.ndarray],
) -> list[str]:
    if len(source.words) <= MAX_DOTS_PER_LANGUAGE:
        return source.words[:]

    candidates = source.candidates
    candidate_keys = [word.casefold() for word in candidates]
    candidate_embeddings = np.vstack([embedding_by_word[key] for key in candidate_keys]).astype(np.float32)

    forced_keys = {word.casefold() for word in source.forced_words}
    forced_candidate_indices = [idx for idx, word in enumerate(candidates) if word.casefold() in forced_keys]
    selected_indices: set[int] = set(forced_candidate_indices)

    remaining_indices = [idx for idx in range(len(candidates)) if idx not in selected_indices]
    target_clusters = MAX_DOTS_PER_LANGUAGE - len(selected_indices)

    if target_clusters <= 0:
        selected_indices = set(forced_candidate_indices[:MAX_DOTS_PER_LANGUAGE])
    elif len(remaining_indices) <= target_clusters:
        selected_indices.update(remaining_indices)
    else:
        remaining_embeddings = candidate_embeddings[remaining_indices]
        cluster_count = min(target_clusters, len(remaining_indices))
        kmeans = MiniBatchKMeans(
            n_clusters=cluster_count,
            random_state=stable_seed(f"kmeans:{language}"),
            batch_size=min(2048, max(256, len(remaining_indices))),
            n_init="auto",
            max_iter=120,
            reassignment_ratio=0.01,
        )
        labels = kmeans.fit_predict(remaining_embeddings)
        centers = np.asarray(kmeans.cluster_centers_, dtype=np.float32)

        for cluster_id in range(cluster_count):
            local = np.flatnonzero(labels == cluster_id)
            if local.size == 0:
                continue
            local_embeddings = remaining_embeddings[local]
            distances = np.sum((local_embeddings - centers[cluster_id]) ** 2, axis=1)
            chosen_local = int(local[int(np.argmin(distances))])
            selected_indices.add(remaining_indices[chosen_local])

        if len(selected_indices) < MAX_DOTS_PER_LANGUAGE:
            # Deterministic fill: spread through the candidate list, skipping already selected.
            for idx in remaining_indices:
                selected_indices.add(idx)
                if len(selected_indices) >= MAX_DOTS_PER_LANGUAGE:
                    break

    selected = [candidates[idx] for idx in sorted(selected_indices)[:MAX_DOTS_PER_LANGUAGE]]
    if len(selected) != MAX_DOTS_PER_LANGUAGE:
        raise RuntimeError(f"{language}: expected {MAX_DOTS_PER_LANGUAGE} representatives, got {len(selected)}")
    return selected


def ts_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def format_point(word: str, coords: np.ndarray) -> str:
    x, y, z = (float(v) for v in coords)
    return f"    [{ts_string(word)}, {x:.6f}, {y:.6f}, {z:.6f}],"


def format_source_index_rows(source_indices: list[int]) -> list[str]:
    rows: list[str] = []
    for start in range(0, len(source_indices), 18):
        chunk = ", ".join(str(index) for index in source_indices[start : start + 18])
        rows.append(f"    {chunk},")
    return rows


def build_ts(language_points: dict[str, list[tuple[str, np.ndarray, int]]], sources: list[LanguageSource]) -> str:
    source_counts = {source.key: source.source_count for source in sources}
    generated_for = ", ".join(language_points.keys())
    lines: list[str] = [
        "// Auto-generated semantic coordinates for the Box Matrix / Box Cube themes.",
        "// Do not hand-edit: run scripts/generate-box-embedding-data.py from the project root.",
        f"// Languages: {generated_for}.",
        f"// Embeddings: SentenceTransformer('{MODEL_NAME}'), normalize_embeddings=True.",
        "// Large word sets: representative candidate pool + MiniBatchKMeans agglomeration.",
        "// Reduction: global PCA(n_components=3), median-centered, 98th-percentile scaled into a unit cube.",
        "",
        f"export const GRANITE_BOX_EMBEDDING_MODEL = '{MODEL_NAME}';",
        f"export const GRANITE_BOX_MAX_DOTS_PER_LANGUAGE = {MAX_DOTS_PER_LANGUAGE};",
        f"export const GRANITE_BOX_CLUSTER_CANDIDATE_LIMIT = {MAX_CLUSTER_CANDIDATES};",
        "",
        "export type GraniteBoxWordPoint = readonly [word: string, x: number, y: number, z: number];",
        "",
        "export const GRANITE_BOX_WORD_POINTS_BY_LANGUAGE = {",
    ]

    for language, points in language_points.items():
        lines.append(f"  {json.dumps(language)}: [")
        lines.append(f"    // source words: {source_counts[language]}, visible dots: {len(points)}")
        for word, coords, _source_index in points:
            lines.append(format_point(word, coords))
        lines.append("  ] as const satisfies readonly GraniteBoxWordPoint[],")
    lines.append("} as const;")

    lines.extend([
        "",
        "export const GRANITE_BOX_WORD_POINT_SOURCE_INDICES_BY_LANGUAGE = {",
    ])
    for language, points in language_points.items():
        source_indices = [source_index for _word, _coords, source_index in points]
        lines.append(f"  {json.dumps(language)}: [")
        lines.extend(format_source_index_rows(source_indices))
        lines.append("  ] as const,")
    lines.append("} as const;")
    lines.extend([
        "",
        "export type GraniteBoxLanguage = keyof typeof GRANITE_BOX_WORD_POINTS_BY_LANGUAGE;",
        "",
        "export const GRANITE_BOX_WORD_POINTS_ENGLISH = GRANITE_BOX_WORD_POINTS_BY_LANGUAGE.english;",
        "export const GRANITE_BOX_WORD_POINTS_FRENCH = GRANITE_BOX_WORD_POINTS_BY_LANGUAGE.french;",
        "",
        "// Backward-compatible default for existing imports.",
        "export const GRANITE_BOX_WORD_POINTS = GRANITE_BOX_WORD_POINTS_ENGLISH;",
        "",
        "export function getGraniteBoxWordPoints(language = 'english'): readonly GraniteBoxWordPoint[] {",
        "  const normalized = language.trim().toLowerCase().replace(/-/g, '_');",
        "  const byExactName = GRANITE_BOX_WORD_POINTS_BY_LANGUAGE[normalized as GraniteBoxLanguage];",
        "  if (byExactName) return byExactName;",
        "",
        "  const baseLanguage = normalized.split('_')[0] as GraniteBoxLanguage;",
        "  const byBaseName = GRANITE_BOX_WORD_POINTS_BY_LANGUAGE[baseLanguage];",
        "  if (byBaseName) return byBaseName;",
        "",
        "  return GRANITE_BOX_WORD_POINTS_ENGLISH;",
        "}",
        "",
        "export function getGraniteBoxWordPointSourceIndices(language = 'english'): readonly number[] {",
        "  const normalized = language.trim().toLowerCase().replace(/-/g, '_');",
        "  const byExactName = GRANITE_BOX_WORD_POINT_SOURCE_INDICES_BY_LANGUAGE[normalized as GraniteBoxLanguage];",
        "  if (byExactName) return byExactName;",
        "",
        "  const baseLanguage = normalized.split('_')[0] as GraniteBoxLanguage;",
        "  const byBaseName = GRANITE_BOX_WORD_POINT_SOURCE_INDICES_BY_LANGUAGE[baseLanguage];",
        "  if (byBaseName) return byBaseName;",
        "",
        "  return GRANITE_BOX_WORD_POINT_SOURCE_INDICES_BY_LANGUAGE.english;",
        "}",
        "",
        "export function resolveGraniteBoxPointIndex(language = 'english', sourceIndex?: number | null): number {",
        "  if (typeof sourceIndex !== 'number' || !Number.isFinite(sourceIndex)) return -1;",
        "  const sourceIndices = getGraniteBoxWordPointSourceIndices(language);",
        "  if (sourceIndices.length === 0) return -1;",
        "",
        "  const target = Math.trunc(sourceIndex);",
        "  let low = 0;",
        "  let high = sourceIndices.length - 1;",
        "",
        "  while (low <= high) {",
        "    const mid = (low + high) >> 1;",
        "    const value = sourceIndices[mid];",
        "    if (value === target) return mid;",
        "    if (value < target) low = mid + 1;",
        "    else high = mid - 1;",
        "  }",
        "",
        "  if (low >= sourceIndices.length) return sourceIndices.length - 1;",
        "  if (high < 0) return 0;",
        "",
        "  return Math.abs(sourceIndices[low] - target) < Math.abs(sourceIndices[high] - target) ? low : high;",
        "}",
        "",
    ])
    return "\n".join(lines)


def main() -> None:
    languages = read_json(WORDS_DIR / "languagelist.json")
    if not isinstance(languages, list):
        raise ValueError("words/languagelist.json must be a JSON array")

    sources: list[LanguageSource] = []
    all_candidate_words: dict[str, str] = {}

    for language in languages:
        words, source_indices, ordered = load_language_words(language)
        candidates = choose_candidate_words(language, words, ordered)
        forced_words = forced_words_for_source(words, ordered)
        source = LanguageSource(
            key=language,
            words=words,
            source_indices=source_indices,
            source_count=len(words),
            ordered_by_frequency=ordered,
            candidates=candidates,
            forced_words=forced_words,
        )
        sources.append(source)
        for word in candidates:
            all_candidate_words.setdefault(word.casefold(), word)
        print(
            f"{language:16} source={len(words):7} candidates={len(candidates):5} forced={len(forced_words):3}",
            flush=True,
        )

    unique_candidate_words = list(all_candidate_words.values())
    print(f"Embedding {len(unique_candidate_words)} unique candidate words with {MODEL_NAME}...", flush=True)
    model = SentenceTransformer(MODEL_NAME)
    embeddings = model.encode(
        unique_candidate_words,
        batch_size=512,
        normalize_embeddings=True,
        show_progress_bar=True,
        convert_to_numpy=True,
    ).astype(np.float32)
    embeddings = l2_normalize_rows(embeddings)
    embedding_by_word = {
        word.casefold(): embeddings[index]
        for index, word in enumerate(unique_candidate_words)
    }

    selected_by_language: dict[str, list[str]] = {}
    for source in sources:
        selected = select_cluster_representatives(source.key, source, embedding_by_word)
        selected_by_language[source.key] = selected
        print(f"{source.key:16} selected={len(selected):4}", flush=True)

    selected_embeddings: list[np.ndarray] = []
    selected_refs: list[tuple[str, str]] = []
    for source in sources:
        for word in selected_by_language[source.key]:
            selected_refs.append((source.key, word))
            selected_embeddings.append(embedding_by_word[word.casefold()])

    selected_matrix = np.vstack(selected_embeddings).astype(np.float32)
    coords = PCA(n_components=3, random_state=42).fit_transform(selected_matrix)
    coords = coords - np.median(coords, axis=0, keepdims=True)
    scale = np.percentile(np.linalg.norm(coords, axis=1), 98)
    if not np.isfinite(scale) or scale <= 1e-8:
        scale = 1.0
    coords = np.clip(coords / scale * CUBE_LIMIT, -CUBE_LIMIT, CUBE_LIMIT)

    source_index_by_language: dict[str, dict[str, int]] = {
        source.key: {
            word.casefold(): source.source_indices[index]
            for index, word in enumerate(source.words)
        }
        for source in sources
    }

    language_points: dict[str, list[tuple[str, np.ndarray, int]]] = {source.key: [] for source in sources}
    for (language, word), coord in zip(selected_refs, coords, strict=True):
        source_index = source_index_by_language[language][word.casefold()]
        language_points[language].append((word, coord, source_index))

    OUT_PATH.write_text(build_ts(language_points, sources), encoding="utf-8")
    print(f"Wrote {OUT_PATH.relative_to(ROOT)}", flush=True)


if __name__ == "__main__":
    main()
