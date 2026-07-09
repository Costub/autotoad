const RETUNE_TAU_FLOOR_MS = 1; // ms

export interface CorrectionFrame {
  appliedTarget: number;
  correctionSemitones: number;
  targetMidi: number;
}

/** Stateful retune-target smoother. All pitch values are MIDI semitones. */
export class CorrectionSmoother {
  private readonly blockMs: number;
  private appliedTarget = 0;
  private wasVoiced = false;

  constructor(sampleRate: number, blockSize = 128) {
    this.blockMs = (blockSize / sampleRate) * 1000;
  }

  process(
    smoothedMidi: number,
    snappedTarget: number,
    correctionAmount: number,
    retuneMs: number,
    voiced: boolean,
  ): CorrectionFrame {
    if (!voiced) {
      this.wasVoiced = false;
      return {
        appliedTarget: this.appliedTarget,
        correctionSemitones: 0,
        targetMidi: this.appliedTarget,
      };
    }

    const targetMidi =
      smoothedMidi + (snappedTarget - smoothedMidi) * correctionAmount;
    if (!this.wasVoiced || retuneMs <= RETUNE_TAU_FLOOR_MS) {
      this.appliedTarget = targetMidi;
    } else {
      const alpha = 1 - Math.exp(-this.blockMs / retuneMs);
      this.appliedTarget += (targetMidi - this.appliedTarget) * alpha;
    }
    this.wasVoiced = true;

    return {
      appliedTarget: this.appliedTarget,
      correctionSemitones: this.appliedTarget - smoothedMidi,
      targetMidi,
    };
  }

  reset(): void {
    this.appliedTarget = 0;
    this.wasVoiced = false;
  }
}
