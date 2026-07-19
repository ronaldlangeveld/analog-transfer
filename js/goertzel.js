// Goertzel filterbank: exact-frequency tone energy at arbitrary sample rates,
// which an FFT can't give us at both 44.1 and 48 kHz with 100 Hz tone spacing.
// Energies are normalized so a full-scale sine of amplitude A reads ~A^2
// regardless of window length (Hann coherent gain 0.5 -> peak A*N/4).
export class Filterbank {
  constructor(fs, winLen, freqs) {
    this.n = winLen;
    this.hann = new Float32Array(winLen);
    for (let k = 0; k < winLen; k++) {
      this.hann[k] = 0.5 * (1 - Math.cos((2 * Math.PI * k) / (winLen - 1)));
    }
    this.coeffs = freqs.map((f) => 2 * Math.cos((2 * Math.PI * f) / fs));
    this.norm = 16 / (winLen * winLen);
    this.windowed = new Float32Array(winLen);
    this.out = new Float32Array(freqs.length);
  }

  // buf must have length winLen. Returns energies (reused array — copy if kept).
  energies(buf) {
    const n = this.n;
    const w = this.windowed;
    for (let k = 0; k < n; k++) w[k] = buf[k] * this.hann[k];
    for (let t = 0; t < this.coeffs.length; t++) {
      const coeff = this.coeffs[t];
      let s1 = 0;
      let s2 = 0;
      for (let k = 0; k < n; k++) {
        const s0 = w[k] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      this.out[t] = (s1 * s1 + s2 * s2 - coeff * s1 * s2) * this.norm;
    }
    return this.out;
  }
}
