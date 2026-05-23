import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  GRANITE_BOX_MAX_DOTS_PER_LANGUAGE,
  GRANITE_BOX_WORD_POINTS_BY_LANGUAGE,
  getGraniteBoxWordPoints
} from '../themes/box-embedding-data.js';

const root = new URL('..', import.meta.url);
const readJson = (relativePath) => JSON.parse(readFileSync(new URL(relativePath, root), 'utf8'));
const languages = readJson('words/languagelist.json');

assert.equal(GRANITE_BOX_MAX_DOTS_PER_LANGUAGE, 1000, 'embedding data must declare the 1000-dot language cap');

const uniqueSourceWordCount = (words) => {
  const seen = new Set();
  for (const word of words) {
    const text = String(word).trim();
    if (text) seen.add(text.toLocaleLowerCase());
  }
  return seen.size;
};

// Galaxy languages (english, french) use the galaxy-data pipeline instead of
// box-embedding-data. Their Granite entries are vestigial — skip them here.
const GALAXY_LANGUAGES = new Set(['english', 'french']);

for (const language of languages) {
  if (GALAXY_LANGUAGES.has(language)) continue;
  const points = GRANITE_BOX_WORD_POINTS_BY_LANGUAGE[language];

  assert.ok(points, `${language} must have an embedding point set`);
  assert.equal(getGraniteBoxWordPoints(language), points, `${language} lookup must return its own point set`);
  assert.ok(points.length > 0, `${language} point set must not be empty`);
  assert.ok(
    points.length <= GRANITE_BOX_MAX_DOTS_PER_LANGUAGE,
    `${language} has ${points.length} dots, above the 1000-dot cap`
  );

  // Word-file-based assertions only for languages with a generated word list
  const wordsPath = new URL(`words/${language}/words.json`, root);
  if (existsSync(wordsPath)) {
    const source = readJson(`words/${language}/words.json`);
    const sourceWords = Array.isArray(source) ? source : source.words;
    const uniqueCount = uniqueSourceWordCount(sourceWords);
    if (uniqueCount <= GRANITE_BOX_MAX_DOTS_PER_LANGUAGE) {
      assert.equal(points.length, uniqueCount, `${language} should keep every unique source word when already under cap`);
    } else {
      assert.equal(points.length, GRANITE_BOX_MAX_DOTS_PER_LANGUAGE, `${language} should agglomerate to exactly 1000 dots`);
    }
  } else {
    console.warn(`${language}: no words.json — skipping source-word assertions`);
  }

  for (const [index, point] of points.entries()) {
    assert.equal(point.length, 4, `${language}[${index}] must be [word, x, y, z]`);
    assert.equal(typeof point[0], 'string', `${language}[${index}] word must be a string`);
    assert.ok(point[0].length > 0, `${language}[${index}] word must be non-empty`);
    for (const coord of point.slice(1)) {
      assert.equal(typeof coord, 'number', `${language}[${index}] coordinates must be numbers`);
      assert.ok(Number.isFinite(coord), `${language}[${index}] coordinates must be finite`);
      assert.ok(coord >= -0.82 && coord <= 0.82, `${language}[${index}] coordinate ${coord} is outside the visual cube`);
    }
  }
}

console.log(`Validated Box Matrix embedding data for ${languages.length} language sets.`);
