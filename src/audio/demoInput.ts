import { midiToFreq } from './theory/scales';

const MELODY_MIDI = [60, 62, 64, 65, 67, 65, 64, 62] as const;
const DETUNE_CENTS = [40, -35, 45, -40, 30, -45, 35, -30] as const;
const NOTE_SECONDS = 0.5;
const GAP_SECONDS = 0.03;
const ATTACK_SECONDS = 0.03;
const RELEASE_SECONDS = 0.08;
const TAIL_SECONDS = 0.3;
const cache = new Map<number, Promise<AudioBuffer>>();

export function getDemoBuffer(ctx: AudioContext): Promise<AudioBuffer> {
  const existing = cache.get(ctx.sampleRate);
  if (existing) return existing;

  const promise = renderDemo(ctx.sampleRate);
  cache.set(ctx.sampleRate, promise);
  return promise;
}

async function renderDemo(sampleRate: number): Promise<AudioBuffer> {
  const duration = MELODY_MIDI.length * NOTE_SECONDS + TAIL_SECONDS;
  const offline = new OfflineAudioContext(1, Math.ceil(duration * sampleRate), sampleRate);

  for (let index = 0; index < MELODY_MIDI.length; index += 1) {
    const start = index * NOTE_SECONDS;
    const end = start + NOTE_SECONDS - GAP_SECONDS;
    const frequency = midiToFreq(
      MELODY_MIDI[index]! + DETUNE_CENTS[index]! / 100,
    );
    const oscillator = new OscillatorNode(offline, {
      type: 'sawtooth',
      frequency,
    });
    const vibrato = new OscillatorNode(offline, {
      type: 'sine',
      frequency: 5.5,
    });
    const vibratoGain = new GainNode(offline, { gain: frequency * 0.004 });
    const filter = new BiquadFilterNode(offline, {
      type: 'lowpass',
      frequency: 1200,
    });
    const envelope = new GainNode(offline, { gain: 0 });

    vibrato.connect(vibratoGain).connect(oscillator.frequency);
    oscillator.connect(filter).connect(envelope).connect(offline.destination);
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(0.5, start + ATTACK_SECONDS);
    envelope.gain.setValueAtTime(0.5, Math.max(start + ATTACK_SECONDS, end - RELEASE_SECONDS));
    envelope.gain.linearRampToValueAtTime(0, end);
    oscillator.start(start);
    vibrato.start(start);
    oscillator.stop(end);
    vibrato.stop(end);
  }

  return offline.startRendering();
}
