import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  GRANITE_BOX_MAX_DOTS_PER_LANGUAGE,
  GRANITE_BOX_WORD_POINTS_BY_LANGUAGE,
  getGraniteBoxWordPointSourceIndices,
  resolveGraniteBoxPointIndex
} from '../themes/box-embedding-data.js';
import { buildExpandedBoxPointPositions } from '../themes/box-point-layout.js';

const root = new URL('..', import.meta.url);
const readJson = (relativePath) => JSON.parse(readFileSync(new URL(relativePath, root), 'utf8'));
const languages = readJson('words/languagelist.json');

const sampleSourceIndices = (sourceCount) => {
  const samples = new Set([0, 1, 2, sourceCount - 3, sourceCount - 2, sourceCount - 1]);
  const stride = Math.max(1, Math.floor(sourceCount / 97));
  for (let index = 0; index < sourceCount; index += stride) {
    samples.add(index);
  }
  return [...samples].filter((index) => index >= 0 && index < sourceCount);
};

const pointKeys = (points) => new Set(points.map((point) => String(point[0]).trim().toLocaleLowerCase()));

// Galaxy languages (english, french) use the galaxy-data pipeline instead of
// box-embedding-data. Their Granite entries are vestigial — skip them here.
const GALAXY_LANGUAGES = new Set(['english', 'french']);

for (const language of languages) {
  if (GALAXY_LANGUAGES.has(language)) continue;
  const points = GRANITE_BOX_WORD_POINTS_BY_LANGUAGE[language];
  const sourceIndices = getGraniteBoxWordPointSourceIndices(language);

  assert.ok(points, `${language} must have points`);
  assert.equal(sourceIndices.length, points.length, `${language} needs one source-index representative per dot`);

  // Source-word-based assertions only for languages with a generated word list
  const wordsPath = new URL(`words/${language}/words.json`, root);
  if (existsSync(wordsPath)) {
    const source = readJson(`words/${language}/words.json`);
    const sourceWords = Array.isArray(source) ? source : source.words;

    for (const [pointIndex, sourceIndex] of sourceIndices.entries()) {
      assert.equal(Number.isInteger(sourceIndex), true, `${language}[${pointIndex}] source index must be an integer`);
      assert.ok(sourceIndex >= 0 && sourceIndex < sourceWords.length, `${language}[${pointIndex}] source index is outside the source list`);
    }

    if (sourceWords.length > GRANITE_BOX_MAX_DOTS_PER_LANGUAGE) {
      const exactPointWords = pointKeys(points);
      const nonRepresentativeIndex = sourceWords.findIndex((word) => !exactPointWords.has(String(word).trim().toLocaleLowerCase()));
      assert.notEqual(nonRepresentativeIndex, -1, `${language} should have non-representative source words in this regression`);

      const nonRepresentativePoint = resolveGraniteBoxPointIndex(language, nonRepresentativeIndex);
      assert.ok(
        nonRepresentativePoint >= 0 && nonRepresentativePoint < points.length,
        `${language} non-representative source word must still route to a visible cluster dot`
      );

      for (const sourceIndex of sampleSourceIndices(sourceWords.length)) {
        const pointIndex = resolveGraniteBoxPointIndex(language, sourceIndex);
        assert.ok(
          pointIndex >= 0 && pointIndex < points.length,
          `${language} source index ${sourceIndex} must route to a visible cluster dot`
        );
      }
    }
  } else {
    console.warn(`${language}: no words.json — skipping source-word assertions`);
  }

  const expanded = buildExpandedBoxPointPositions(points, 1.0);
  assert.equal(expanded.length, points.length * 3, `${language} expanded position array length mismatch`);

  const axisMax = [0, 0, 0];
  for (let index = 0; index < expanded.length; index += 3) {
    axisMax[0] = Math.max(axisMax[0], Math.abs(expanded[index]));
    axisMax[1] = Math.max(axisMax[1], Math.abs(expanded[index + 1]));
    axisMax[2] = Math.max(axisMax[2], Math.abs(expanded[index + 2]));
  }

  const filledAxes = axisMax.filter((value) => value >= 0.92).length;
  assert.ok(filledAxes >= 2, `${language} point cloud is too centered; axis maxima were ${axisMax.join(', ')}`);
}

console.log(`Validated cluster routing and expanded point-cloud layout for ${languages.length} language sets.`);
