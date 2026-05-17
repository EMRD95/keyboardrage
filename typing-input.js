const DIACRITIC_MARKS = /[\u0300-\u036f]/g;
const LIGATURE_FALLBACKS = {
    œ: 'oe',
    Œ: 'OE',
    æ: 'ae',
    Æ: 'AE'
};
const DEAD_ACCENT_KEYS_BY_TARGET = {
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
export function normalizeTypingValue(value) {
    let normalized = '';
    for (const char of value) {
        normalized += LIGATURE_FALLBACKS[char] ?? char;
    }
    return normalized.normalize('NFD').replace(DIACRITIC_MARKS, '');
}
function firstCharacter(value) {
    return Array.from(value)[0] ?? '';
}
function isAccentFoldableCharacter(value) {
    if (!value)
        return false;
    return normalizeTypingValue(value) !== value;
}
export function shouldIgnoreDeadAccentKey(key, pendingText) {
    const expected = firstCharacter(pendingText).toLowerCase();
    if (!expected)
        return false;
    return DEAD_ACCENT_KEYS_BY_TARGET[expected]?.includes(key) ?? false;
}
export function typedKeyPrefixLength(pendingText, key) {
    if (!pendingText || !key)
        return 0;
    if (pendingText.startsWith(key))
        return key.length;
    const expected = firstCharacter(pendingText);
    if (!expected || !isAccentFoldableCharacter(expected))
        return 0;
    return normalizeTypingValue(expected) === normalizeTypingValue(key)
        ? expected.length
        : 0;
}
