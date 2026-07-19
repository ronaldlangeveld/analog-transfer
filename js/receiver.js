import { Demodulator } from './demodulator.js';

// Mic -> AudioWorklet -> Demodulator, plus an AnalyserNode for the spectrum
// canvas. The AudioContext is created only after getUserMedia and inside a
// user gesture (iOS requirement); every DSP constant derives from the actual
// ctx.sampleRate.
export class Receiver {
  async start({ onFrame, onStatus } = {}) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.ctx = new AudioContext();
    await this.ctx.resume();
    await this.ctx.audioWorklet.addModule(new URL('capture-worklet.js', import.meta.url));

    const src = this.ctx.createMediaStreamSource(this.stream);
    this.demod = new Demodulator(this.ctx.sampleRate, { onFrame, onStatus });

    this.node = new AudioWorkletNode(this.ctx, 'capture', {
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.node.port.onmessage = (e) => this.demod.push(e.data);
    src.connect(this.node);
    this.node.connect(this.ctx.destination); // worklet outputs silence; keeps graph alive

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;
    src.connect(this.analyser);
    return { sampleRate: this.ctx.sampleRate, analyser: this.analyser };
  }

  stop() {
    if (this.node) this.node.disconnect();
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close();
  }
}
