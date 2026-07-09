import * as Tone from 'tone';

export type FxParam =
  | 'reverbSend'
  | 'reverbDecay'
  | 'delaySend'
  | 'delayTime'
  | 'delayFeedback';

export interface FxBus {
  connectSource(node: AudioNode | Tone.ToneAudioNode): void;
  setParam(name: FxParam, value: number): void;
  dispose(): void;
}

const DIVISIONS = ['8n', '8n.', '4n', '2n'] as const;

export function createFxBus(masterGain: AudioNode): FxBus {
  const reverbInput = new Tone.Gain();
  const highpass = new Tone.Filter(150, 'highpass');
  const reverbs: [Tone.Reverb, Tone.Reverb] = [
    new Tone.Reverb({ decay: 2.2, preDelay: 0.02, wet: 1 }),
    new Tone.Reverb({ decay: 2.2, preDelay: 0.02, wet: 1 }),
  ];
  const reverbGains: [Tone.Gain, Tone.Gain] = [
    new Tone.Gain(1),
    new Tone.Gain(0),
  ];
  const delayInput = new Tone.Gain();
  const delay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.35, maxDelay: 2, wet: 1 });
  const lowpass = new Tone.Filter(4000, 'lowpass');
  const sourceSends: Array<{ reverb: Tone.Gain; delay: Tone.Gain }> = [];
  let reverbLevel = 0.18;
  let delayLevel = 0;
  let activeReverb = 0;
  let decayTimer: number | null = null;

  reverbInput.connect(highpass);
  highpass.connect(reverbs[0]);
  highpass.connect(reverbs[1]);
  reverbs[0].connect(reverbGains[0]);
  reverbs[1].connect(reverbGains[1]);
  reverbGains[0].connect(masterGain);
  reverbGains[1].connect(masterGain);
  delayInput.chain(delay, lowpass);
  lowpass.connect(masterGain);
  void Promise.all(reverbs.map((reverb) => reverb.generate()));

  const regenerate = (decay: number): void => {
    if (decayTimer !== null) globalThis.clearTimeout(decayTimer);
    decayTimer = globalThis.setTimeout(() => {
      const idle = activeReverb === 0 ? 1 : 0;
      reverbs[idle]!.decay = decay;
      void reverbs[idle]!.generate().then(() => {
        reverbGains[activeReverb]!.gain.rampTo(0, 0.08);
        reverbGains[idle]!.gain.rampTo(1, 0.08);
        activeReverb = idle;
      });
    }, 150);
  };

  return {
    connectSource(node) {
      const reverbSend = new Tone.Gain(reverbLevel);
      const delaySend = new Tone.Gain(delayLevel);
      Tone.connect(node, reverbSend);
      Tone.connect(node, delaySend);
      reverbSend.connect(reverbInput);
      delaySend.connect(delayInput);
      sourceSends.push({ reverb: reverbSend, delay: delaySend });
    },
    setParam(name, value) {
      if (name === 'reverbSend') {
        reverbLevel = value;
        sourceSends.forEach((send) => send.reverb.gain.rampTo(value, 0.05));
      } else if (name === 'delaySend') {
        delayLevel = value;
        sourceSends.forEach((send) => send.delay.gain.rampTo(value, 0.05));
      } else if (name === 'delayFeedback') {
        delay.feedback.rampTo(Math.min(0.75, Math.max(0, value)), 0.05);
      } else if (name === 'delayTime') {
        delay.delayTime.rampTo(DIVISIONS[Math.round(value)] ?? '8n.', 0.05);
      } else {
        regenerate(Math.min(8, Math.max(0.5, value)));
      }
    },
    dispose() {
      if (decayTimer !== null) globalThis.clearTimeout(decayTimer);
      sourceSends.forEach((send) => {
        send.reverb.dispose();
        send.delay.dispose();
      });
      reverbInput.dispose();
      highpass.dispose();
      reverbs.forEach((reverb) => reverb.dispose());
      reverbGains.forEach((gain) => gain.dispose());
      delayInput.dispose();
      delay.dispose();
      lowpass.dispose();
    },
  };
}
