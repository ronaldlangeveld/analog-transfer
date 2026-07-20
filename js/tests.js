// Pure-JS loopback tests: encoder output fed straight into the decoder with
// no audio hardware. Runs in node (run-tests.mjs) and in the browser
// (test.html). Deterministic — seeded PRNG, no Math.random.
import { buildPassSegments, Assembler } from './protocol.js';
import { symbolsToSamples } from './modulator.js';
import { Demodulator } from './demodulator.js';
import { crc32 } from './crc32.js';

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeFile(n, seed = 42) {
  const rnd = lcg(seed);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * 256);
  return b;
}

function passSamples(fileBytes, fs, name = 'test.bin', mime = 'application/octet-stream') {
  const segments = buildPassSegments(fileBytes, name, mime);
  const parts = segments.map((s) => symbolsToSamples(s.symbols, fs, s.silenceAfterSec || 0));
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function withSilence(samples, fs, beforeSec = 0.2, afterSec = 0.3) {
  const out = new Float32Array(
    Math.round(beforeSec * fs) + samples.length + Math.round(afterSec * fs),
  );
  out.set(samples, Math.round(beforeSec * fs));
  return out;
}

function scale(samples, gain) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

function addNoise(samples, snrDb, seed = 7) {
  const rnd = lcg(seed);
  let p = 0;
  for (let i = 0; i < samples.length; i++) p += samples[i] * samples[i];
  p /= samples.length;
  const sigma = Math.sqrt(p / 10 ** (snrDb / 10));
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 2) {
    // Box-Muller
    const u1 = Math.max(rnd(), 1e-12);
    const u2 = rnd();
    const r = Math.sqrt(-2 * Math.log(u1));
    out[i] = samples[i] + sigma * r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < samples.length) out[i + 1] = samples[i + 1] + sigma * r * Math.sin(2 * Math.PI * u2);
  }
  return out;
}

// N-pole one-pole-cascade lowpass: models small-speaker / off-axis-mic
// high-frequency rolloff.
function lowpass(samples, fs, fc, poles) {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / fs);
  let out = samples;
  for (let p = 0; p < poles; p++) {
    const y = new Float32Array(out.length);
    let lp = 0;
    for (let i = 0; i < out.length; i++) {
      lp += a * (out[i] - lp);
      y[i] = lp;
    }
    out = y;
  }
  return out;
}

// Sparse deterministic room impulse response: direct path, early reflections,
// late taps decaying with tau ~ 40 ms.
function reverb(samples, fs, seed = 3) {
  const rnd = lcg(seed);
  const taps = [[0, 1], [7, 0.5], [13, -0.35], [23, 0.25], [31, -0.18]]
    .map(([ms, g]) => [Math.round((ms / 1000) * fs), g]);
  for (let k = 0; k < 24; k++) {
    const ms = 35 + rnd() * 85;
    const g = 0.15 * Math.exp(-ms / 40) * (rnd() < 0.5 ? -1 : 1);
    taps.push([Math.round((ms / 1000) * fs), g]);
  }
  const out = new Float32Array(samples.length);
  for (const [d, g] of taps) {
    for (let i = d; i < samples.length; i++) out[i] += g * samples[i - d];
  }
  return out;
}

function resample(samples, factor) {
  const n = Math.floor(samples.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * factor;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = samples[j] * (1 - f) + (samples[j + 1] ?? 0) * f;
  }
  return out;
}

function concat(arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// Feed samples to a fresh demod+assembler in 1024-sample pushes; return result.
function decode(samples, fs) {
  let result = null;
  const asm = new Assembler((ev) => {
    if (ev.type === 'complete') result = ev;
  });
  const demod = new Demodulator(fs, { onFrame: (f) => asm.handleFrame(f) });
  for (let i = 0; i < samples.length; i += 1024) {
    demod.push(samples.subarray(i, Math.min(i + 1024, samples.length)));
  }
  return { result, asm };
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function runTests(log = console.log) {
  let passed = 0;
  let failed = 0;
  const t = (name, fn) => {
    const t0 = Date.now();
    try {
      const ok = fn();
      const ms = Date.now() - t0;
      if (ok) {
        passed++;
        log(`PASS ${name} (${ms}ms)`);
      } else {
        failed++;
        log(`FAIL ${name} (${ms}ms)`);
      }
    } catch (err) {
      failed++;
      log(`FAIL ${name} — ${err.stack || err}`);
    }
  };

  t('crc32 known vector', () => crc32(new TextEncoder().encode('123456789')) === 0xcbf43926);

  for (const fs of [48000, 44100]) {
    t(`clean loopback 300 B @ ${fs}`, () => {
      const file = makeFile(300);
      const { result } = decode(withSilence(passSamples(file, fs), fs), fs);
      return !!result && bytesEqual(result.bytes, file) && result.meta.name === 'test.bin';
    });
  }

  t('clean loopback 1 KB @ 48000, low level (gain 0.05)', () => {
    const file = makeFile(1024, 3);
    const { result } = decode(withSilence(scale(passSamples(file, 48000), 0.05), 48000), 48000);
    return !!result && bytesEqual(result.bytes, file);
  });

  for (const snr of [20, 10]) {
    t(`noisy loopback 300 B @ 48000, ${snr} dB SNR`, () => {
      const file = makeFile(300, 11);
      const samples = addNoise(withSilence(passSamples(file, 48000), 48000), snr);
      const { result } = decode(samples, 48000);
      return !!result && bytesEqual(result.bytes, file);
    });
  }

  t('clock drift 200 ppm @ 48000', () => {
    const file = makeFile(300, 5);
    const samples = resample(withSilence(passSamples(file, 48000), 48000), 1.0002);
    const { result } = decode(samples, 48000);
    return !!result && bytesEqual(result.bytes, file);
  });

  t('0.5 s dropout recovered on second pass (carousel)', () => {
    const fs = 48000;
    const file = makeFile(600, 9);
    const pass = passSamples(file, fs);
    const damaged = new Float32Array(pass);
    const from = Math.floor(pass.length * 0.3);
    damaged.fill(0, from, from + Math.round(0.5 * fs));
    const samples = withSilence(concat([damaged, pass]), fs);
    const { result } = decode(samples, fs);
    return !!result && bytesEqual(result.bytes, file);
  });

  t('join mid-pass, complete on next pass', () => {
    const fs = 48000;
    const file = makeFile(600, 13);
    const pass = passSamples(file, fs);
    const late = pass.subarray(Math.floor(pass.length * 0.4));
    const samples = withSilence(concat([late, pass]), fs);
    const { result } = decode(samples, fs);
    return !!result && bytesEqual(result.bytes, file);
  });

  // Guards the tone plan: the whole alphabet (markers included) must survive
  // steep high-frequency rolloff plus room reverb. The musical-semitone plan
  // (markers at A6/E8) decoded zero frames here — any tone above ~4 kHz dies
  // in this channel, so keep everything under ~3.8 kHz.
  t('hostile channel: 3 kHz 4-pole rolloff + reverb, 3 passes', () => {
    const fs = 48000;
    const file = makeFile(300, 11);
    const pass = passSamples(file, fs);
    const stream = withSilence(concat([pass, pass, pass]), fs);
    const { result } = decode(reverb(lowpass(stream, fs, 3000, 4), fs), fs);
    return !!result && bytesEqual(result.bytes, file);
  });

  t('full-size 10 KB clean loopback @ 48000', () => {
    const file = makeFile(10240, 21);
    const { result } = decode(withSilence(passSamples(file, 48000), 48000), 48000);
    return !!result && bytesEqual(result.bytes, file);
  });

  log(`\n${passed} passed, ${failed} failed`);
  return { passed, failed };
}
