import * as Tone from 'tone';

export class Metronome {
  private readonly synth: Tone.Synth;
  private readonly output: Tone.Gain;
  private eventId: number | null = null;
  private beat = 0;

  constructor(masterGain: AudioNode) {
    this.output = new Tone.Gain(0);
    this.output.connect(masterGain);
    this.synth = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 0.025, sustain: 0, release: 0.01 },
    }).connect(this.output);
  }

  start(): void {
    if (this.eventId === null) {
      this.eventId = Tone.getTransport().scheduleRepeat((time) => {
        this.synth.triggerAttackRelease(this.beat % 4 === 0 ? 2000 : 1000, '32n', time, 0.3);
        this.beat += 1;
      }, '4n');
    }
    if (Tone.getTransport().state !== 'started') Tone.getTransport().start();
  }

  setBpm(value: number): void {
    Tone.getTransport().bpm.rampTo(value, 0.1);
  }

  setEnabled(enabled: boolean): void {
    this.output.gain.rampTo(enabled ? 1 : 0, 0.05);
  }

  dispose(): void {
    if (this.eventId !== null) Tone.getTransport().clear(this.eventId);
    this.synth.dispose();
    this.output.dispose();
  }
}
