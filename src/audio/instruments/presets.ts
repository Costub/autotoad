import * as Tone from 'tone';
import type { InstrumentName } from '../../types';

export interface InstrumentInstance {
  triggerAttack(midi: number, velocity01: number): void;
  triggerRelease(midi: number): void;
  setNote(midi: number): void;
  releaseAll(): void;
  out: Tone.Gain;
  dispose(): void;
}

type Playable = Tone.Synth | Tone.FMSynth | Tone.PolySynth<Tone.AMSynth> | Tone.PluckSynth;

const frequency = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

export function createInstrument(name: InstrumentName): InstrumentInstance {
  const out = new Tone.Gain(0.65);
  let synth: Playable;
  const effects: Tone.ToneAudioNode[] = [];
  const transpose = name === 'fmBass' ? -12 : 0;

  if (name === 'chiptune') {
    synth = new Tone.Synth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.005, decay: 0.08, sustain: 0.5, release: 0.05 },
    });
    const crusher = new Tone.BitCrusher(4);
    const delay = new Tone.FeedbackDelay({
      delayTime: '16n',
      feedback: 0.15,
      wet: 0.2,
    });
    synth.chain(crusher, delay, out);
    effects.push(crusher, delay);
  } else if (name === 'fmBass') {
    synth = new Tone.FMSynth({
      harmonicity: 1,
      modulationIndex: 8,
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.1 },
    }).connect(out);
  } else if (name === 'pluck') {
    synth = new Tone.PluckSynth({
      attackNoise: 1,
      dampening: 3500,
      resonance: 0.9,
    });
    const plate = new Tone.Reverb({ decay: 0.8, wet: 0.25 });
    void plate.generate();
    synth.chain(plate, out);
    effects.push(plate);
  } else {
    synth = new Tone.PolySynth(Tone.AMSynth, {
      envelope: { attack: 0.4, release: 1.2 },
    });
    const chorus = new Tone.Chorus(2.5, 3.5, 0.5).start();
    synth.chain(chorus, out);
    effects.push(chorus);
  }

  const active = new Set<number>();
  const note = (midi: number): number => frequency(midi + transpose);

  return {
    out,
    triggerAttack(midi, velocity01) {
      active.add(midi);
      if (synth instanceof Tone.PluckSynth) {
        synth.volume.rampTo(-18 + velocity01 * 12, 0.01);
        synth.triggerAttack(note(midi), Tone.now());
      } else {
        synth.triggerAttack(note(midi), Tone.now(), velocity01);
      }
    },
    triggerRelease(midi) {
      active.delete(midi);
      if (synth instanceof Tone.PluckSynth) return;
      synth.triggerRelease(note(midi), Tone.now());
    },
    setNote(midi) {
      const previous = active.values().next().value as number | undefined;
      if (synth instanceof Tone.Synth || synth instanceof Tone.FMSynth) {
        synth.setNote(note(midi), Tone.now());
        active.clear();
        active.add(midi);
        return;
      }
      if (previous !== undefined) this.triggerRelease(previous);
      this.triggerAttack(midi, 0.75);
    },
    releaseAll() {
      if ('releaseAll' in synth) synth.releaseAll(Tone.now());
      else if (!(synth instanceof Tone.PluckSynth)) synth.triggerRelease(Tone.now());
      active.clear();
    },
    dispose() {
      synth.dispose();
      for (const effect of effects) effect.dispose();
      out.dispose();
    },
  };
}
