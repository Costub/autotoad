export const P = {
  bypass: 0,
  retuneMs: 1,
  correctionAmount: 2,
  keyTonic: 3,
  scaleId: 4,
  formantShift: 5,
  pitchShift: 6,
  harmonyVoices: 7,
  harmonyInterval0: 8,
  harmonyInterval1: 9,
  harmonyInterval2: 10,
  harmonyInterval3: 11,
  harmonySpread: 12,
  dryLevel: 13,
  wetLevel: 14,
  inputGain: 15,
  detectedFreq: 20,
  detectedClarity: 21,
  correctedFreq: 22,
  rmsLevel: 23,
  stableNote: 24,
  smoothedMidi: 25,
  workletP95Us: 26,
  shifterLatencySamps: 27,
  LENGTH: 32,
} as const;

export type ParamIndex = Exclude<(typeof P)[keyof typeof P], typeof P.LENGTH>;

const TELEMETRY_START_INDEX = P.detectedFreq;
const MESSAGE_INTERVAL_MS = 16;

interface ParamsMessage {
  type: 'params';
  data: Float64Array;
}

interface TelemetryMessage {
  type: 'telemetry';
  data: Float64Array;
}

function isTelemetryMessage(value: unknown): value is TelemetryMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const message = value as Partial<TelemetryMessage>;
  return message.type === 'telemetry' && message.data instanceof Float64Array;
}

export interface ParamsBus {
  readonly mode: 'sab' | 'message';
  set(index: ParamIndex, value: number): void;
  get(index: ParamIndex): number;
  readonly sab: SharedArrayBuffer | null;
  attachPort(port: MessagePort): void;
}

class SharedParamsBus implements ParamsBus {
  readonly mode = 'sab' as const;
  readonly sab: SharedArrayBuffer;
  private readonly values: Float64Array;

  constructor() {
    this.sab = new SharedArrayBuffer(P.LENGTH * Float64Array.BYTES_PER_ELEMENT);
    this.values = new Float64Array(this.sab);
    setInitialValues(this.values);
  }

  set(index: ParamIndex, value: number): void {
    this.values[index] = value;
  }

  get(index: ParamIndex): number {
    return this.values[index] ?? 0;
  }

  attachPort(_port: MessagePort): void {
    // SAB mode has no message transport to attach.
  }
}

class MessageParamsBus implements ParamsBus {
  readonly mode = 'message' as const;
  readonly sab = null;
  private readonly values = new Float64Array(P.LENGTH);
  private port: MessagePort | null = null;
  private dirty = true;
  private timerId: number | null = null;

  constructor() {
    setInitialValues(this.values);
  }

  set(index: ParamIndex, value: number): void {
    this.values[index] = value;
    if (index < TELEMETRY_START_INDEX) {
      this.dirty = true;
    }
  }

  get(index: ParamIndex): number {
    return this.values[index] ?? 0;
  }

  attachPort(port: MessagePort): void {
    if (this.port === port) {
      return;
    }

    this.detachPort();
    this.port = port;
    port.addEventListener('message', this.handleMessage);
    port.start();
    this.timerId = globalThis.setInterval(() => {
      if (!this.dirty || !this.port) {
        return;
      }
      const message: ParamsMessage = {
        type: 'params',
        data: this.values.slice(),
      };
      this.port.postMessage(message);
      this.dirty = false;
    }, MESSAGE_INTERVAL_MS);
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    if (!isTelemetryMessage(event.data)) {
      return;
    }
    const data = event.data.data;
    const end = Math.min(data.length, P.LENGTH);
    for (let index = TELEMETRY_START_INDEX; index < end; index += 1) {
      this.values[index] = data[index] ?? 0;
    }
  };

  private detachPort(): void {
    if (this.port) {
      this.port.removeEventListener('message', this.handleMessage);
    }
    if (this.timerId !== null) {
      globalThis.clearInterval(this.timerId);
      this.timerId = null;
    }
    this.port = null;
  }
}

function setInitialValues(values: Float64Array): void {
  values[P.bypass] = 0;
  values[P.retuneMs] = 80;
  values[P.correctionAmount] = 1;
  values[P.keyTonic] = 0;
  values[P.scaleId] = 0;
  values[P.harmonySpread] = 0.3;
  values[P.dryLevel] = 0;
  values[P.wetLevel] = 1;
  values[P.inputGain] = 1;
  values[P.stableNote] = -1;
}

export function createParamsBus(): ParamsBus {
  const canUseSharedMemory =
    typeof SharedArrayBuffer !== 'undefined' &&
    globalThis.crossOriginIsolated === true;

  if (canUseSharedMemory) {
    return new SharedParamsBus();
  }

  console.info('AUTOTOAD: SharedArrayBuffer unavailable; using message transport.');
  return new MessageParamsBus();
}
