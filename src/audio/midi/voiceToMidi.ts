const ON_RMS = 0.02;
const OFF_RMS = 0.012;
const ON_HOLD_MS = 30;
const OFF_HOLD_MS = 60;
const REATTACK_RATIO = Math.pow(10, 6 / 20);
const REATTACK_WINDOW_MS = 100;

export interface VoiceToMidiInput {
  t: number;
  voiced: boolean;
  stableNote: number | null;
  smoothedMidi: number;
  rms: number;
}

export type V2MEvent =
  | { type: 'noteOn'; midi: number; velocity: number }
  | { type: 'noteOff'; midi: number }
  | { type: 'setNote'; midi: number }
  | { type: 'pitchBend'; cents: number };

interface RmsPoint { t: number; rms: number }

export class VoiceToMidi {
  legato = false;
  bendEnabled = false;
  private currentNote: number | null = null;
  private lastVelocity = 80;
  private onsetStart: number | null = null;
  private onsetPeak = 0;
  private offStart: number | null = null;
  private rmsWindow: RmsPoint[] = [];

  push(frame: VoiceToMidiInput): V2MEvent[] {
    const events: V2MEvent[] = [];
    if (this.currentNote === null) {
      if (frame.voiced && frame.stableNote !== null && frame.rms > ON_RMS) {
        this.onsetStart ??= frame.t;
        this.onsetPeak = Math.max(this.onsetPeak, frame.rms);
        if (frame.t - this.onsetStart >= ON_HOLD_MS) {
          this.currentNote = frame.stableNote;
          this.lastVelocity = velocityForRms(this.onsetPeak);
          events.push({
            type: 'noteOn',
            midi: this.currentNote,
            velocity: this.lastVelocity,
          });
          this.resetOnset();
          this.rmsWindow = [{ t: frame.t, rms: frame.rms }];
        }
      } else {
        this.resetOnset();
      }
      return events;
    }

    const shouldRelease = !frame.voiced || frame.rms < OFF_RMS;
    if (shouldRelease) {
      this.offStart ??= frame.t;
      if (frame.t - this.offStart >= OFF_HOLD_MS) {
        events.push({ type: 'noteOff', midi: this.currentNote });
        this.closeNote();
        return events;
      }
    } else {
      this.offStart = null;
    }

    if (frame.stableNote !== null && frame.stableNote !== this.currentNote) {
      const previous = this.currentNote;
      this.currentNote = frame.stableNote;
      if (this.legato) {
        events.push({ type: 'setNote', midi: this.currentNote });
      } else {
        events.push(
          { type: 'noteOff', midi: previous },
          { type: 'noteOn', midi: this.currentNote, velocity: this.lastVelocity },
        );
      }
      this.rmsWindow = [{ t: frame.t, rms: frame.rms }];
    } else if (!shouldRelease && this.isReattack(frame)) {
      this.lastVelocity = velocityForRms(frame.rms);
      events.push(
        { type: 'noteOff', midi: this.currentNote },
        { type: 'noteOn', midi: this.currentNote, velocity: this.lastVelocity },
      );
      this.rmsWindow = [{ t: frame.t, rms: frame.rms }];
    }

    if (this.bendEnabled) {
      events.push({
        type: 'pitchBend',
        cents: (frame.smoothedMidi - this.currentNote) * 100,
      });
    }
    return events;
  }

  allOff(): V2MEvent[] {
    if (this.currentNote === null) return [];
    const event: V2MEvent = { type: 'noteOff', midi: this.currentNote };
    this.closeNote();
    return [event];
  }

  private isReattack(frame: VoiceToMidiInput): boolean {
    this.rmsWindow = this.rmsWindow.filter(
      (point) => frame.t - point.t <= REATTACK_WINDOW_MS,
    );
    let minimum = Number.POSITIVE_INFINITY;
    for (const point of this.rmsWindow) minimum = Math.min(minimum, point.rms);
    this.rmsWindow.push({ t: frame.t, rms: frame.rms });
    return Number.isFinite(minimum) && frame.rms > minimum * REATTACK_RATIO;
  }

  private resetOnset(): void {
    this.onsetStart = null;
    this.onsetPeak = 0;
  }

  private closeNote(): void {
    this.currentNote = null;
    this.offStart = null;
    this.rmsWindow = [];
    this.resetOnset();
  }
}

function velocityForRms(rms: number): number {
  const normalized = Math.max(0, Math.min(1, (rms - 0.02) / (0.3 - 0.02)));
  return Math.round(40 + normalized * 80);
}
