// French-only compact galaxy coordinates loaded lazily by Box Matrix / Box Cube.
// Generated artifacts are in /words and are aligned by sourceIndex with words/french.json.

export type FrenchGalaxyWordPoint = readonly [word: string, x: number, y: number, z: number];

export type FrenchGalaxyPointSet = {
  points: readonly FrenchGalaxyWordPoint[];
  sourceIndexToPointIndex: ReadonlyMap<number, number>;
  totalWords: number;
  visibleDots: number;
  frequencyLimit: number;
};

type FrenchWordsPayload = {
  words: string[];
  embeddingData?: {
    coords?: string;
  };
};

const COORDINATE_SCALE = 0.82;
const DEFAULT_COORDS_URL = '/words/french-galaxy-coords.bin';
const WORDS_URL = '/words/french.json';

let loadPromise: Promise<FrenchGalaxyData> | null = null;

class FrenchGalaxyData {
  readonly words: string[];
  readonly coords: Float32Array;
  private readonly pointSetCache = new Map<number, FrenchGalaxyPointSet>();

  constructor(words: string[], coords: Float32Array) {
    this.words = words;
    this.coords = coords;
  }

  getPointSet(frequencyLimit: number | undefined): FrenchGalaxyPointSet {
    const usableLimit = Math.max(1, Math.min(this.words.length, Math.floor(frequencyLimit || 1000)));
    const cached = this.pointSetCache.get(usableLimit);
    if (cached) return cached;

    const sourceIndexToPointIndex = new Map<number, number>();
    const points: FrenchGalaxyWordPoint[] = [];

    for (let sourceIndex = 0; sourceIndex < usableLimit; sourceIndex += 1) {
      sourceIndexToPointIndex.set(sourceIndex, points.length);
      points.push(this.pointForSourceIndex(sourceIndex));
    }

    const pointSet: FrenchGalaxyPointSet = {
      points,
      sourceIndexToPointIndex,
      totalWords: this.words.length,
      visibleDots: points.length,
      frequencyLimit: usableLimit
    };
    this.pointSetCache.set(usableLimit, pointSet);
    return pointSet;
  }

  pointForSourceIndex(sourceIndex: number): FrenchGalaxyWordPoint {
    const safeIndex = Math.max(0, Math.min(this.words.length - 1, Math.floor(sourceIndex)));
    const offset = safeIndex * 3;
    return [
      this.words[safeIndex] || '',
      this.coords[offset] || 0,
      this.coords[offset + 1] || 0,
      this.coords[offset + 2] || 0
    ] as const;
  }

  coordinateForSourceIndex(sourceIndex: number): [number, number, number] | null {
    if (!Number.isFinite(sourceIndex) || sourceIndex < 0 || sourceIndex >= this.words.length) return null;
    const offset = Math.floor(sourceIndex) * 3;
    return [this.coords[offset] || 0, this.coords[offset + 1] || 0, this.coords[offset + 2] || 0];
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function loadFrenchGalaxyDataNow(): Promise<FrenchGalaxyData> {
  const wordsPayload = await fetchJson<FrenchWordsPayload>(WORDS_URL);
  const coordsUrl = wordsPayload.embeddingData?.coords || DEFAULT_COORDS_URL;
  const response = await fetch(coordsUrl);
  if (!response.ok) throw new Error(`Failed to load ${coordsUrl}: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'KRG1') throw new Error(`Unsupported French galaxy coordinate format: ${magic}`);
  const count = view.getUint32(4, true);
  if (count !== wordsPayload.words.length) {
    throw new Error(`French galaxy coordinate count mismatch: words=${wordsPayload.words.length}, coords=${count}`);
  }

  const raw = new Int16Array(buffer, 8, count * 3);
  const coords = new Float32Array(count * 3);
  for (let i = 0; i < raw.length; i += 1) {
    coords[i] = (raw[i] / 32767) * COORDINATE_SCALE;
  }
  return new FrenchGalaxyData(wordsPayload.words, coords);
}

export function loadFrenchGalaxyData(): Promise<FrenchGalaxyData> {
  if (!loadPromise) {
    loadPromise = loadFrenchGalaxyDataNow().catch((error) => {
      loadPromise = null;
      throw error;
    });
  }
  return loadPromise;
}

export function isFrenchGalaxyLanguage(language: string | undefined) {
  return (language || '').toLowerCase() === 'french';
}
