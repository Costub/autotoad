import type { KeyConfig } from '../../types';
import { SCALE_INTERVALS, degreeOf, snapToScale } from './scales';

/**
 * Returns the semitone offset from a note to a signed number of scale degrees
 * away. Out-of-scale inputs snap first, while the result remains relative to
 * the original input note.
 */
export function resolveInterval(
  stableNoteMidi: number,
  key: KeyConfig,
  intervalSteps: number,
): number {
  const intervals = SCALE_INTERVALS[key.scale];
  const length = intervals.length;

  let base = stableNoteMidi;
  let degree = degreeOf(base, key);
  if (degree === -1) {
    base = snapToScale(base, key);
    degree = degreeOf(base, key);
  }

  const baseOctaveOffset =
    base - (key.tonicPc + intervals[degree]!);
  const targetDegreeRaw = degree + intervalSteps;
  const octaveShift = Math.floor(targetDegreeRaw / length);
  const targetDegree =
    ((targetDegreeRaw % length) + length) % length;
  const target =
    baseOctaveOffset +
    key.tonicPc +
    intervals[targetDegree]! +
    12 * octaveShift;

  return target - stableNoteMidi;
}

export const HARMONY_PRESETS = {
  off: [] as number[],
  duet: [2],
  triad: [2, 4],
  choir: [2, 4, -7],
  octaves: [7, -7],
} as const;
