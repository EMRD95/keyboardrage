# Tests

## box-embedding-data.test.mjs

Validates the compiled-in Granite embedding data used by Box Matrix and Box Cube
themes for languages WITHOUT galaxy coordinate files.

**What it checks:**
- Every language in `words/languagelist.json` has an entry in `GRANITE_BOX_WORD_POINTS_BY_LANGUAGE`
- `getGraniteBoxWordPoints(language)` returns the correct point set
- Point sets respect the 1000-dot cap (`GRANITE_BOX_MAX_DOTS_PER_LANGUAGE`)
- Languages with word JSON files have correct source-word → dot count mapping
- Every point is `[word, x, y, z]` with valid coordinates in [-0.82, 0.82]
- Galaxy languages (english, french) are skipped — they use the galaxy-data pipeline

**Run:** `node tests/box-embedding-data.test.mjs`

## box-embedding-cluster-routing.test.mjs

Validates that cluster routing works correctly: source words that are NOT
directly represented as dots (because the language has >1000 unique words) still
route to a valid visible cluster dot via `resolveGraniteBoxPointIndex()`.

**What it checks:**
- `getGraniteBoxWordPointSourceIndices(language)` returns one source index per dot
- All source indices are valid integers within the source word list range
- Non-representative source words route to a valid cluster dot
- Sampled source indices (0, 1, 2, last-3, last-2, last-1, plus ~97 evenly spaced) all route correctly
- `buildExpandedBoxPointPositions()` produces correct-length position arrays
- Point clouds are not too centered (at least 2 axes filled to ≥0.92)

**Run:** `node tests/box-embedding-cluster-routing.test.mjs`
