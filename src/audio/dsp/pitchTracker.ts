import { PitchDetector } from 'pitchy';
import { freqToMidiFloat, midiToFreq } from '../theory/scales';

const WINDOW_SIZE = 2048; // samples
const DEFAULT_BLOCK_SIZE = 128; // samples
const CLARITY_GATE = 0.9;
const RMS_GATE = 0.01;
const MIN_TRACKED_FREQ_HZ = 40; // Hz
const MAX_TRACKED_FREQ_HZ = 2000; // Hz
const OCTAVE_JUMP_SEMITONES = 9; // semitones per frame
const OCTAVE_JUMP_CLARITY_OK = 0.97;
const GLITCH_HOLD_FRAMES = 3; // frames
const MEDIAN_LEN = 5; // voiced frames
const MEDIAN_WARMUP_LEN = 3; // voiced frames
const SMOOTH_TAU_MS = 8; // ms
const HYST_HARD_CENTS = 60; // cents past boundary
const HYST_SOFT_CENTS = 40; // cents past boundary
const HYST_SOFT_MS = 80; // ms
const UNVOICED_CLEAR_FRAMES = 5; // frames

export interface SmoothingResult {
  smoothedMidi: number;
  voiced: boolean;
  stableNote: number | null;
}

export class SmoothingPipeline {
  private readonly blockMs: number;
  private readonly medianValues = new Float64Array(MEDIAN_LEN);
  private readonly medianScratch = new Float64Array(MEDIAN_LEN);
  private medianCount = 0;
  private medianWriteIndex = 0;
  private smoothedMidi = 0;
  private wasVoiced = false;
  private lastGoodMidi = Number.NaN;
  private glitchCount = 0;
  private stableNote: number | null = null;
  private softBoundaryMs = 0;
  private softCandidate: number | null = null;
  private unvoicedFrames = 0;

  constructor(sampleRate: number, blockSize = DEFAULT_BLOCK_SIZE) {
    this.blockMs = (blockSize / sampleRate) * 1000;
  }

  push(midiFloatOrNaN: number, clarity: number): SmoothingResult {
    let midi = midiFloatOrNaN;
    let voiced = Number.isFinite(midi);

    if (
      voiced &&
      Number.isFinite(this.lastGoodMidi) &&
      Math.abs(midi - this.lastGoodMidi) > OCTAVE_JUMP_SEMITONES &&
      clarity < OCTAVE_JUMP_CLARITY_OK
    ) {
      this.glitchCount += 1;
      if (this.glitchCount <= GLITCH_HOLD_FRAMES) {
        midi = this.lastGoodMidi;
      } else {
        voiced = false;
        midi = Number.NaN;
      }
    } else if (voiced) {
      this.glitchCount = 0;
    }

    if (!voiced) {
      this.wasVoiced = false;
      this.unvoicedFrames += 1;
      this.softBoundaryMs = 0;
      this.softCandidate = null;
      if (this.unvoicedFrames > UNVOICED_CLEAR_FRAMES) {
        this.stableNote = null;
        if (this.unvoicedFrames === UNVOICED_CLEAR_FRAMES + 1) {
          this.medianCount = 0;
          this.medianWriteIndex = 0;
          this.lastGoodMidi = Number.NaN;
          this.glitchCount = 0;
        }
      }
      return {
        smoothedMidi: 0,
        voiced: false,
        stableNote: this.stableNote,
      };
    }

    this.lastGoodMidi = midi;
    this.unvoicedFrames = 0;
    this.medianValues[this.medianWriteIndex] = midi;
    this.medianWriteIndex = (this.medianWriteIndex + 1) % MEDIAN_LEN;
    this.medianCount = Math.min(MEDIAN_LEN, this.medianCount + 1);

    const median =
      this.medianCount < MEDIAN_WARMUP_LEN ? midi : this.calculateMedian();

    if (!this.wasVoiced) {
      this.smoothedMidi = median;
      this.wasVoiced = true;
    } else {
      const alpha = 1 - Math.exp(-this.blockMs / SMOOTH_TAU_MS);
      this.smoothedMidi += (median - this.smoothedMidi) * alpha;
    }

    this.updateStableNote();
    return {
      smoothedMidi: this.smoothedMidi,
      voiced: true,
      stableNote: this.stableNote,
    };
  }

  reset(): void {
    this.medianValues.fill(0);
    this.medianScratch.fill(0);
    this.medianCount = 0;
    this.medianWriteIndex = 0;
    this.smoothedMidi = 0;
    this.wasVoiced = false;
    this.lastGoodMidi = Number.NaN;
    this.glitchCount = 0;
    this.stableNote = null;
    this.softBoundaryMs = 0;
    this.softCandidate = null;
    this.unvoicedFrames = 0;
  }

  private calculateMedian(): number {
    for (let index = 0; index < this.medianCount; index += 1) {
      this.medianScratch[index] = this.medianValues[index]!;
    }

    for (let index = 1; index < this.medianCount; index += 1) {
      const value = this.medianScratch[index]!;
      let cursor = index - 1;
      while (cursor >= 0 && this.medianScratch[cursor]! > value) {
        this.medianScratch[cursor + 1] = this.medianScratch[cursor]!;
        cursor -= 1;
      }
      this.medianScratch[cursor + 1] = value;
    }

    return this.medianScratch[Math.floor(this.medianCount / 2)]!;
  }

  private updateStableNote(): void {
    const candidate = Math.round(this.smoothedMidi);
    if (this.stableNote === null) {
      this.stableNote = candidate;
      this.softBoundaryMs = 0;
      this.softCandidate = null;
      return;
    }

    if (candidate === this.stableNote) {
      this.softBoundaryMs = 0;
      this.softCandidate = null;
      return;
    }

    const distanceCents = Math.abs(this.smoothedMidi - this.stableNote) * 100;
    if (distanceCents > HYST_HARD_CENTS) {
      this.stableNote = candidate;
      this.softBoundaryMs = 0;
      this.softCandidate = null;
      return;
    }

    if (distanceCents > HYST_SOFT_CENTS) {
      if (this.softCandidate !== candidate) {
        this.softCandidate = candidate;
        this.softBoundaryMs = 0;
      }
      this.softBoundaryMs += this.blockMs;
      if (this.softBoundaryMs > HYST_SOFT_MS) {
        this.stableNote = candidate;
        this.softBoundaryMs = 0;
        this.softCandidate = null;
      }
      return;
    }

    this.softBoundaryMs = 0;
    this.softCandidate = null;
  }
}

export interface PitchAnalysis {
  freq: number;
  clarity: number;
  smoothedMidi: number;
  voiced: boolean;
  stableNote: number | null;
}

export class PitchTracker {
  private readonly detector = PitchDetector.forFloat32Array(WINDOW_SIZE);
  private readonly ring = new Float32Array(WINDOW_SIZE);
  private readonly analysisWindow = new Float32Array(WINDOW_SIZE);
  private readonly smoothing: SmoothingPipeline;
  private ringWriteIndex = 0;

  constructor(private readonly sampleRate: number) {
    this.smoothing = new SmoothingPipeline(sampleRate);
  }

  analyze(block: Float32Array, rms: number): PitchAnalysis {
    this.appendToRing(block);
    this.copyAnalysisWindow();

    if (rms < RMS_GATE) {
      return this.toAnalysis(0, 0, this.smoothing.push(Number.NaN, 0));
    }

    const [frequency, clarity] = this.detector.findPitch(
      this.analysisWindow,
      this.sampleRate,
    );
    const detectedInRange =
      clarity >= CLARITY_GATE &&
      frequency > MIN_TRACKED_FREQ_HZ &&
      frequency < MAX_TRACKED_FREQ_HZ;

    if (!detectedInRange) {
      return this.toAnalysis(0, clarity, this.smoothing.push(Number.NaN, clarity));
    }

    const result = this.smoothing.push(freqToMidiFloat(frequency), clarity);
    const smoothedFrequency = result.voiced
      ? midiToFreq(result.smoothedMidi)
      : 0;
    return this.toAnalysis(smoothedFrequency, clarity, result);
  }

  reset(): void {
    this.ring.fill(0);
    this.analysisWindow.fill(0);
    this.ringWriteIndex = 0;
    this.smoothing.reset();
  }

  private appendToRing(block: Float32Array): void {
    for (let index = 0; index < block.length; index += 1) {
      this.ring[this.ringWriteIndex] = block[index]!;
      this.ringWriteIndex = (this.ringWriteIndex + 1) % WINDOW_SIZE;
    }
  }

  private copyAnalysisWindow(): void {
    for (let index = 0; index < WINDOW_SIZE; index += 1) {
      this.analysisWindow[index] =
        this.ring[(this.ringWriteIndex + index) % WINDOW_SIZE]!;
    }
  }

  private toAnalysis(
    frequency: number,
    clarity: number,
    result: SmoothingResult,
  ): PitchAnalysis {
    return {
      freq: frequency,
      clarity,
      smoothedMidi: result.smoothedMidi,
      voiced: result.voiced,
      stableNote: result.stableNote,
    };
  }
}
