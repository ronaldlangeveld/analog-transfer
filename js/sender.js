import { symbolsToSamples } from './modulator.js';

// Plays a pass (list of segments) through the speaker. Segments are rendered
// to AudioBuffers just-in-time and scheduled a few seconds ahead at exact
// sample-accumulated times, so a 10 KB / 8-minute pass never lives in memory
// at once.
export class Sender {
  constructor() {
    this.playing = false;
  }

  async start(segments, { loop = true, onProgress, onPass, onDone } = {}) {
    if (this.playing) this.stop();
    this.segments = segments;
    this.loop = loop;
    this.onProgress = onProgress;
    this.onPass = onPass;
    this.onDone = onDone;

    this.ctx = new AudioContext();
    await this.ctx.resume();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.8;
    this.gain.connect(this.ctx.destination);

    this.playing = true;
    this.segIdx = 0;
    this.pass = 1;
    this.finished = false;
    this.nextTime = this.ctx.currentTime + 0.2;
    this.active = new Set();
    this.timer = setInterval(() => this._pump(), 250);
    this._pump();
  }

  _pump() {
    if (!this.playing) return;
    while (!this.finished && this.nextTime - this.ctx.currentTime < 4) {
      this._scheduleNext();
    }
    if (this.finished && this.ctx.currentTime >= this.nextTime) {
      const done = this.onDone;
      this.stop();
      done?.();
    }
  }

  _scheduleNext() {
    if (this.segIdx >= this.segments.length) {
      if (!this.loop) {
        this.finished = true;
        return;
      }
      this.segIdx = 0;
      this.pass++;
      this.onPass?.(this.pass);
    }
    const seg = this.segments[this.segIdx++];
    const fs = this.ctx.sampleRate;
    const samples = symbolsToSamples(seg.symbols, fs, seg.silenceAfterSec || 0);
    const buffer = this.ctx.createBuffer(1, samples.length, fs);
    buffer.copyToChannel(samples, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);
    src.start(this.nextTime);
    this.active.add(src);
    src.onended = () => this.active.delete(src);
    this.nextTime += samples.length / fs;
    this.onProgress?.(this.segIdx, this.segments.length, this.pass);
  }

  stop() {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const src of this.active || []) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.active = new Set();
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close();
  }
}
