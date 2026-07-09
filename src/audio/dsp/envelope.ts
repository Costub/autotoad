/** Block RMS plus an attack/release envelope follower. All times are in ms. */
export class EnvelopeFollower {
  private env = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly attackMs = 5,
    private readonly releaseMs = 80,
  ) {}

  processBlock(input: Float32Array): { rms: number; env: number } {
    if (input.length === 0) {
      return { rms: 0, env: this.env };
    }

    let sum = 0;
    for (let index = 0; index < input.length; index += 1) {
      const sample = input[index]!;
      sum += sample * sample;
    }

    const rms = Math.sqrt(sum / input.length);
    const tauMs = rms > this.env ? this.attackMs : this.releaseMs;
    const blockMs = (input.length / this.sampleRate) * 1000;
    this.env += (rms - this.env) * (1 - Math.exp(-blockMs / tauMs));
    return { rms, env: this.env };
  }
}
