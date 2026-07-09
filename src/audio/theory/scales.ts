import type { KeyConfig, ScaleName } from '../../types';

/** Semitone offsets from the tonic for each scale. */
export const SCALE_INTERVALS: Record<ScaleName, readonly number[]> = {
  major:           [0, 2, 4, 5, 7, 9, 11],
  naturalMinor:    [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor:   [0, 2, 3, 5, 7, 8, 11],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues:           [0, 3, 5, 6, 7, 10],
  dorian:          [0, 2, 3, 5, 7, 9, 10],
  mixolydian:      [0, 2, 4, 5, 7, 9, 10],
  chromatic:       [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export function freqToMidiFloat(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const snapCache = new Map<string, Int8Array>();

function buildSnapTable(key: KeyConfig): Int8Array {
  const intervals = SCALE_INTERVALS[key.scale];
  const inScale = new Array<boolean>(12).fill(false);
  for (const interval of intervals) {
    inScale[(key.tonicPc + interval) % 12] = true;
  }

  const table = new Int8Array(128);
  for (let midi = 0; midi < 128; midi += 1) {
    if (inScale[midi % 12]) {
      table[midi] = midi;
      continue;
    }

    for (let distance = 1; distance <= 6; distance += 1) {
      const up = midi + distance;
      const down = midi - distance;
      if (up < 128 && inScale[up % 12]) {
        table[midi] = up;
        break;
      }
      if (down >= 0 && inScale[((down % 12) + 12) % 12]) {
        table[midi] = down;
        break;
      }
    }
  }
  return table;
}

function getSnapTable(key: KeyConfig): Int8Array {
  const cacheKey = `${key.tonicPc}:${key.scale}`;
  let table = snapCache.get(cacheKey);
  if (!table) {
    table = buildSnapTable(key);
    snapCache.set(cacheKey, table);
  }
  return table;
}

/**
 * Returns the nearest MIDI note whose pitch class is in the configured scale.
 * Equidistant notes resolve upward.
 */
export function snapToScale(midiFloat: number, key: KeyConfig): number {
  const table = getSnapTable(key);
  const midi = Math.min(127, Math.max(0, Math.round(midiFloat)));
  const snapped = table[midi]!;
  const floorMidi = Math.min(127, Math.max(0, Math.floor(midiFloat)));
  const ceilMidi = Math.min(127, Math.max(0, Math.ceil(midiFloat)));
  const lowerCandidate = table[floorMidi]!;
  const upperCandidate = table[ceilMidi]!;

  if (lowerCandidate === upperCandidate) {
    return snapped;
  }

  const lowerDistance = Math.abs(midiFloat - lowerCandidate);
  const upperDistance = Math.abs(midiFloat - upperCandidate);
  return upperDistance <= lowerDistance ? upperCandidate : lowerCandidate;
}

/** Returns the scale-degree index (0..length-1), or -1 when out of scale. */
export function degreeOf(midiNote: number, key: KeyConfig): number {
  const intervals = SCALE_INTERVALS[key.scale];
  const pitchClassRelativeToTonic =
    (((midiNote % 12) - key.tonicPc) % 12 + 12) % 12;
  return intervals.indexOf(pitchClassRelativeToTonic);
}
