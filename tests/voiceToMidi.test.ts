import { describe, expect, it } from 'vitest';
import { VoiceToMidi, type V2MEvent } from '../src/audio/midi/voiceToMidi';

const frame = (
  t: number,
  rms: number,
  note: number | null = 60,
  voiced = rms > 0,
) => ({ t, rms, voiced, stableNote: note, smoothedMidi: note ?? 0 });

describe('VoiceToMidi', () => {
  it('does nothing during silence or a short onset', () => {
    const v2m = new VoiceToMidi();
    expect(v2m.push(frame(0, 0, null, false))).toEqual([]);
    expect(v2m.push(frame(16, 0.1))).toEqual([]);
    expect(v2m.push(frame(32, 0, null, false))).toEqual([]);
  });

  it('opens and closes exactly one sustained note', () => {
    const v2m = new VoiceToMidi();
    const events: V2MEvent[] = [];
    for (let t = 0; t <= 500; t += 16) events.push(...v2m.push(frame(t, 0.1)));
    for (let t = 516; t <= 620; t += 16) events.push(...v2m.push(frame(t, 0, null, false)));
    expect(events.filter((event) => event.type === 'noteOn')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'noteOff')).toHaveLength(1);
  });

  it('retriggers or glides on note changes', () => {
    for (const legato of [false, true]) {
      const v2m = new VoiceToMidi();
      v2m.legato = legato;
      v2m.push(frame(0, 0.1));
      v2m.push(frame(32, 0.1));
      const events = v2m.push(frame(48, 0.1, 64));
      expect(events.map((event) => event.type)).toEqual(
        legato ? ['setNote'] : ['noteOff', 'noteOn'],
      );
    }
  });

  it('detects repeated amplitude attacks without releasing in the dip', () => {
    const v2m = new VoiceToMidi();
    const events: V2MEvent[] = [];
    for (let t = 0; t <= 48; t += 16) events.push(...v2m.push(frame(t, 0.1)));
    for (let attack = 0; attack < 2; attack += 1) {
      const base = 64 + attack * 64;
      events.push(...v2m.push(frame(base, 0.015)));
      events.push(...v2m.push(frame(base + 16, 0.04)));
    }
    expect(events.filter((event) => event.type === 'noteOn')).toHaveLength(3);
  });

  it('does not retrigger while decaying through the hysteresis band', () => {
    const v2m = new VoiceToMidi();
    const events: V2MEvent[] = [];
    for (let t = 0; t <= 48; t += 16) events.push(...v2m.push(frame(t, 0.1)));
    [0.019, 0.017, 0.015, 0.013].forEach((rms, index) => {
      events.push(...v2m.push(frame(64 + index * 16, rms)));
    });
    expect(events.filter((event) => event.type === 'noteOn')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'noteOff')).toHaveLength(0);
  });

  it('clamps velocity mapping', () => {
    const velocities: number[] = [];
    for (const rms of [0.02, 0.3, 0.5]) {
      const v2m = new VoiceToMidi();
      v2m.push(frame(0, rms + 0.0001));
      const events = v2m.push(frame(32, rms + 0.0001));
      const noteOn = events.find((event) => event.type === 'noteOn');
      if (noteOn?.type === 'noteOn') velocities.push(noteOn.velocity);
    }
    expect(velocities[0]).toBeCloseTo(40, 0);
    expect(velocities[1]).toBe(120);
    expect(velocities[2]).toBe(120);
  });

  it('balances random note lifetimes after allOff', () => {
    const v2m = new VoiceToMidi();
    let ons = 0;
    let offs = 0;
    let seed = 12345;
    for (let index = 0; index < 2000; index += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const voiced = (seed & 3) !== 0;
      const rms = voiced ? ((seed >>> 8) % 30) / 100 : 0;
      const note = voiced ? 60 + ((seed >>> 16) % 5) : null;
      for (const event of v2m.push(frame(index * 16, rms, note, voiced))) {
        if (event.type === 'noteOn') ons += 1;
        if (event.type === 'noteOff') offs += 1;
      }
    }
    for (const event of v2m.allOff()) if (event.type === 'noteOff') offs += 1;
    expect(offs).toBe(ons);
  });
});
