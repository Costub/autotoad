export class TakeRecorder {
  private readonly destination: MediaStreamAudioDestinationNode;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  constructor(ctx: AudioContext, masterGain: GainNode) {
    this.destination = ctx.createMediaStreamDestination();
    masterGain.connect(this.destination);
  }

  start(): void {
    if (this.recorder?.state === 'recording') return;
    this.chunks = [];
    const preferred = 'audio/webm;codecs=opus';
    const options =
      MediaRecorder.isTypeSupported(preferred) ? { mimeType: preferred } : undefined;
    this.recorder = new MediaRecorder(this.destination.stream, options);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start();
  }

  stop(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder || recorder.state !== 'recording') return Promise.resolve();
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, {
          type: recorder.mimeType || 'audio/webm',
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `autotoad-take-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
        anchor.click();
        globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
        this.chunks = [];
        resolve();
      };
      recorder.stop();
    });
  }
}
