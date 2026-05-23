// Compact galaxy coordinates for any language with pre-generated .bin artifacts.
// Generated artifacts live in /words/<lang>/words.json + /words/<lang>/galaxy-coords.bin.
//
// Design: the full dot cloud is always displayed visually. The frequency limit
// only gates which source indices are "active" (flash red when typed). Changing the
// frequency updates a single number — no geometry rebuild, no blink.
/** Languages that have pre-generated .bin coordinate artifacts. */
const GALAXY_LANGUAGES = new Set(['english', 'french']);
const COORDINATE_SCALE = 0.82;
const CUBE_POINT_SCALE = 0.8832;
// --- Color precomputation (mirrors box-cube rebuildPointColors) ---
const BASE_DOT_BRIGHT_R = 0x00 / 255;
const BASE_DOT_BRIGHT_G = 0xff / 255;
const BASE_DOT_BRIGHT_B = 0x33 / 255;
function precomputeBaseColors(points, count) {
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
        const x = points[i][1], y = points[i][2], z = points[i][3];
        const semanticDepth = Math.min(1, Math.max(0, (z + 0.82) / 1.64));
        const electricBand = Math.sin((x * 8.5) + (y * 5.0) + (z * 6.0)) * 0.5 + 0.5;
        const greenIntensity = 0.2 + (semanticDepth * 0.5) + (electricBand * 0.3);
        colors[i * 3] = BASE_DOT_BRIGHT_R * 0.4;
        colors[i * 3 + 1] = greenIntensity * 0.6 + BASE_DOT_BRIGHT_G * 0.4;
        colors[i * 3 + 2] = BASE_DOT_BRIGHT_B * 0.4;
    }
    return colors;
}
// --- Position precomputation (mirrors buildExpandedBoxPointPositions) ---
function percentile(sorted, ratio) {
    if (sorted.length === 0)
        return 0;
    if (sorted.length === 1)
        return sorted[0];
    const pos = Math.min(ratio, 1) * (sorted.length - 1);
    const lower = Math.floor(pos), upper = Math.ceil(pos);
    if (lower === upper)
        return sorted[lower];
    const mix = pos - lower;
    return sorted[lower] * (1 - mix) + sorted[upper] * mix;
}
function computeAxisStats(points, count, axis) {
    const values = new Float64Array(count);
    for (let i = 0; i < count; i += 1)
        values[i] = points[i][axis];
    values.sort();
    let low = percentile(values, 0.02), high = percentile(values, 0.98);
    if (!Number.isFinite(low) || !Number.isFinite(high) || high - low < 1e-5) {
        low = values[0] ?? -1;
        high = values[values.length - 1] ?? 1;
    }
    const center = (low + high) * 0.5;
    const halfRange = Math.max((high - low) * 0.5, 1e-5);
    return { center, halfRange };
}
function expandPosition(value, stats, targetHalfExtent) {
    const n = Math.min(1, Math.max(-1, (value - stats.center) / stats.halfRange));
    return Math.sign(n) * Math.pow(Math.abs(n), 0.72) * targetHalfExtent;
}
function precomputePositions(points, count, stats, targetHalfExtent) {
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
        positions[i * 3] = expandPosition(points[i][1], stats[0], targetHalfExtent);
        positions[i * 3 + 1] = expandPosition(points[i][2], stats[1], targetHalfExtent);
        positions[i * 3 + 2] = expandPosition(points[i][3], stats[2], targetHalfExtent);
    }
    return positions;
}
// --- Data class ---
class GalaxyData {
    constructor(words, coords) {
        this.fullPointSet = null;
        this.words = words;
        this.coords = coords;
    }
    getPointSet(frequencyLimit) {
        const usableLimit = Math.max(1, Math.min(this.words.length, Math.floor(frequencyLimit || this.words.length)));
        if (this.fullPointSet) {
            this.fullPointSet.frequencyLimit = usableLimit;
            return this.fullPointSet;
        }
        const fullCount = this.words.length;
        const sourceIndexToPointIndex = new Map();
        const points = [];
        for (let sourceIndex = 0; sourceIndex < fullCount; sourceIndex += 1) {
            sourceIndexToPointIndex.set(sourceIndex, points.length);
            points.push(this.pointForSourceIndex(sourceIndex));
        }
        const axisStats = [
            computeAxisStats(points, fullCount, 1),
            computeAxisStats(points, fullCount, 2),
            computeAxisStats(points, fullCount, 3)
        ];
        this.fullPointSet = {
            points,
            sourceIndexToPointIndex,
            totalWords: this.words.length,
            visibleDots: fullCount,
            frequencyLimit: usableLimit,
            positions: precomputePositions(points, fullCount, axisStats, CUBE_POINT_SCALE),
            baseColors: precomputeBaseColors(points, fullCount),
            axisStats
        };
        return this.fullPointSet;
    }
    pointForSourceIndex(sourceIndex) {
        const si = Math.max(0, Math.min(this.words.length - 1, Math.floor(sourceIndex)));
        const offset = si * 3;
        return [
            this.words[si] || '',
            this.coords[offset] || 0,
            this.coords[offset + 1] || 0,
            this.coords[offset + 2] || 0
        ];
    }
    coordinateForSourceIndex(sourceIndex) {
        if (!Number.isFinite(sourceIndex) || sourceIndex < 0 || sourceIndex >= this.words.length)
            return null;
        const offset = Math.floor(sourceIndex) * 3;
        return [this.coords[offset] || 0, this.coords[offset + 1] || 0, this.coords[offset + 2] || 0];
    }
}
// --- Fetch with per-language cache ---
const dataCache = new Map();
async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok)
        throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
    return response.json();
}
async function loadGalaxyDataNow(language) {
    const wordsUrl = `/words/${language}/words.json`;
    const wordsPayload = await fetchJson(wordsUrl);
    const coordsUrl = wordsPayload.embeddingData?.coords || `/words/${language}/galaxy-coords.bin`;
    const response = await fetch(coordsUrl);
    if (!response.ok)
        throw new Error(`Failed to load ${coordsUrl}: HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const view = new DataView(buffer);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'KRG1')
        throw new Error(`Unsupported galaxy coordinate format: ${magic}`);
    const count = view.getUint32(4, true);
    if (count !== wordsPayload.words.length) {
        throw new Error(`Galaxy coordinate count mismatch for ${language}: words=${wordsPayload.words.length}, coords=${count}`);
    }
    const raw = new Int16Array(buffer, 8, count * 3);
    const coords = new Float32Array(count * 3);
    for (let i = 0; i < raw.length; i += 1)
        coords[i] = (raw[i] / 32767) * COORDINATE_SCALE;
    return new GalaxyData(wordsPayload.words, coords);
}
export function loadGalaxyData(language) {
    const cached = dataCache.get(language);
    if (cached)
        return cached;
    const promise = loadGalaxyDataNow(language).catch((error) => {
        dataCache.delete(language);
        throw error;
    });
    dataCache.set(language, promise);
    return promise;
}
export function isGalaxyLanguage(language) {
    return GALAXY_LANGUAGES.has((language || '').toLowerCase());
}
