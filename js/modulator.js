import { SYMBOL_SEC, RAMP_SEC, TONE_FREQS } from './config.js';

export function samplesPerSymbol(fs) {
  return Math.round(SYMBOL_SEC * fs);
}

// symbols: array of tone indices (0..17). Returns mono Float32 samples.
// Each symbol restarts at phase 0; since every tone is a multiple of
// 1/SYMBOL_SEC the previous symbol also ended at phase 0 — no discontinuity.
export function symbolsToSamples(symbols, fs, silenceAfterSec = 0) {
  const sps = samplesPerSymbol(fs);
  const ramp = Math.round(RAMP_SEC * fs);
  const out = new Float32Array(symbols.length * sps + Math.round(silenceAfterSec * fs));
  for (let i = 0; i < symbols.length; i++) {
    const w = (2 * Math.PI * TONE_FREQS[symbols[i]]) / fs;
    const base = i * sps;
    for (let n = 0; n < sps; n++) {
      let env = 1;
      if (n < ramp) env = 0.5 * (1 - Math.cos((Math.PI * n) / ramp));
      else if (n >= sps - ramp) env = 0.5 * (1 - Math.cos((Math.PI * (sps - n)) / ramp));
      out[base + n] = Math.sin(w * n) * env;
    }
  }
  return out;
}
