const RTL_LANGUAGES = new Set([
  'arabic',
  'hebrew',
  'persian',
  'urdu',
  'pashto',
  'sindhi',
  'kurdish',
  'yiddish',
]);

const CJK_LANGUAGES = new Set([
  'chinese_simplified',
  'chinese_traditional',
  'japanese',
  'korean',
]);

const HAN_RE = /\p{Script=Han}/u;
const HANGUL_RE = /\p{Script=Hangul}/u;
const HIRAGANA_RE = /\p{Script=Hiragana}/u;
const KATAKANA_RE = /\p{Script=Katakana}/u;
const THAI_LIKE_RE = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const INDIC_RE = /[\p{Script=Bengali}\p{Script=Devanagari}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Oriya}\p{Script=Sinhala}\p{Script=Tamil}\p{Script=Telugu}]/u;
const RTL_SCRIPT_RE = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;

function normalizeLanguage(language: string | undefined) {
  return (language || '').toLowerCase();
}

export function isRtlLanguage(language: string | undefined) {
  const normalized = normalizeLanguage(language);
  return RTL_LANGUAGES.has(normalized) || RTL_SCRIPT_RE.test(normalized);
}

export function textDirectionForLanguage(language: string | undefined): CanvasDirection {
  return isRtlLanguage(language) ? 'rtl' : 'ltr';
}

export function usesScriptAwareSpeed(language: string | undefined, words: readonly string[] = []) {
  const normalized = normalizeLanguage(language);
  if (CJK_LANGUAGES.has(normalized) || RTL_LANGUAGES.has(normalized)) return true;
  return words.some(word => {
    for (const char of word) {
      if (HAN_RE.test(char) || HANGUL_RE.test(char) || HIRAGANA_RE.test(char) || KATAKANA_RE.test(char)
        || THAI_LIKE_RE.test(char) || INDIC_RE.test(char) || RTL_SCRIPT_RE.test(char)) {
        return true;
      }
    }
    return false;
  });
}

export function estimateTypingEffort(text: string) {
  let effort = 0;
  for (const char of text.trim()) {
    if (/\s/u.test(char)) continue;

    // CJK words are usually 1-3 visible glyphs, but each glyph typically costs
    // multiple physical keystrokes through an IME. Treat the falling speed as
    // typed-workload, not raw Unicode codepoint count, otherwise Chinese/Korean
    // drops almost twice as fast as Latin at the same WPM setting.
    if (HAN_RE.test(char)) effort += 2.5;
    else if (HANGUL_RE.test(char) || HIRAGANA_RE.test(char) || KATAKANA_RE.test(char)) effort += 2.0;
    else if (THAI_LIKE_RE.test(char) || INDIC_RE.test(char)) effort += 1.35;
    else effort += 1;
  }
  return effort;
}

export function averageTypingEffort(words: readonly string[], fallbackAverage: number) {
  if (words.length === 0) return fallbackAverage;
  const total = words.reduce((sum, word) => sum + estimateTypingEffort(word), 0);
  return total / words.length;
}

export function effectiveAverageWordLength(
  language: string | undefined,
  words: readonly string[],
  fallbackAverage: number,
) {
  if (!usesScriptAwareSpeed(language, words)) return fallbackAverage;

  const normalized = normalizeLanguage(language);
  const effortAverage = averageTypingEffort(words, fallbackAverage);
  const cjkFloor = CJK_LANGUAGES.has(normalized) ? 4.5 : 0;
  return Math.max(fallbackAverage, effortAverage, cjkFloor);
}
