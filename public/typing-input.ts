const DIACRITIC_MARKS = /[\u0300-\u036f]/g;

const LIGATURE_FALLBACKS: Record<string, string> = {
  œ: 'oe',
  Œ: 'OE',
  æ: 'ae',
  Æ: 'AE'
};

const DEAD_ACCENT_KEYS_BY_TARGET: Record<string, readonly string[]> = {
  à: ['`'],
  è: ['`'],
  ù: ['`'],
  á: ["'", '´'],
  é: ["'", '´'],
  í: ["'", '´'],
  ó: ["'", '´'],
  ú: ["'", '´'],
  ý: ["'", '´'],
  â: ['^'],
  ê: ['^'],
  î: ['^'],
  ô: ['^'],
  û: ['^'],
  ä: ['¨', '"'],
  ë: ['¨', '"'],
  ï: ['¨', '"'],
  ö: ['¨', '"'],
  ü: ['¨', '"'],
  ÿ: ['¨', '"'],
  ã: ['~'],
  ñ: ['~'],
  õ: ['~']
};

export function normalizeTypingValue(value: string) {
  let normalized = '';
  for (const char of value) {
    normalized += LIGATURE_FALLBACKS[char] ?? char;
  }
  return normalized.normalize('NFD').replace(DIACRITIC_MARKS, '');
}

function firstCharacter(value: string) {
  return Array.from(value)[0] ?? '';
}

function isAccentFoldableCharacter(value: string) {
  if (!value) return false;
  return normalizeTypingValue(value) !== value;
}

export function shouldIgnoreDeadAccentKey(key: string, pendingText: string) {
  const expected = firstCharacter(pendingText).toLowerCase();
  if (!expected) return false;
  if (key === 'Dead') return isAccentFoldableCharacter(expected);
  return DEAD_ACCENT_KEYS_BY_TARGET[expected]?.includes(key) ?? false;
}

function typedDeadAccentPrefixLength(pendingText: string, key: string, deadAccentKey: string) {
  const expected = firstCharacter(pendingText);
  if (!expected || !isAccentFoldableCharacter(expected)) return 0;

  // Some browsers expose the actual dead key (^, ¨, ', `, ~), while others
  // only report "Dead". If the exact accent is available, require the one that
  // can produce the target character. If not, still allow the composed sequence
  // so strict diacritic mode remains usable on those keyboard layouts.
  const acceptsDeadKey = deadAccentKey === 'Dead'
    || (DEAD_ACCENT_KEYS_BY_TARGET[expected.toLowerCase()]?.includes(deadAccentKey) ?? false);
  if (!acceptsDeadKey) return 0;

  return normalizeTypingValue(expected) === normalizeTypingValue(key)
    ? expected.length
    : 0;
}

export function typedKeyPrefixLength(
  pendingText: string,
  key: string,
  allowDiacriticFolding = false,
  deadAccentKey: string | null = null,
) {
  if (!pendingText || !key) return 0;
  if (pendingText.startsWith(key)) return key.length;

  if (deadAccentKey) {
    const deadAccentLength = typedDeadAccentPrefixLength(pendingText, key, deadAccentKey);
    if (deadAccentLength > 0) return deadAccentLength;
  }

  if (!allowDiacriticFolding) return 0;

  const expected = firstCharacter(pendingText);
  if (!expected || !isAccentFoldableCharacter(expected)) return 0;

  return normalizeTypingValue(expected) === normalizeTypingValue(key)
    ? expected.length
    : 0;
}
