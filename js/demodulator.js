import {
  TONE_FREQS, DATA_TONE_COUNT, M0, M1,
  SYMBOL_SEC, WIN_SEC, SYNC_SYMBOLS, EOT_SYMBOLS,
  CHUNK_PAYLOAD, HEADER_SEQ,
} from './config.js';
import { crc32 } from './crc32.js';
import { Filterbank } from './goertzel.js';

const HOP_DIV = 4;             // hunt scan hops per symbol (5 ms)
const PREAMBLE_HOPS = 24;      // template window: 6 symbols of history
const TEMPLATE_MIN = 0.6;      // normalized preamble correlation threshold
const MARKER_FRAC_MIN = 0.5;   // marker share of in-band energy during preamble
const MIN_AMP2 = 1e-6;         // absolute floor ~ amplitude 0.001
const SYNC_TIMEOUT_SYMBOLS = 40;
const MAX_MARKER_FAILS = 3;
const ALIGN_SEC = 0.003;       // preamble/trial fine-align search: +/-3 ms
const MARKER_ALIGN_SEC = 0.005; // per-frame resync search: +/-5 ms
const FINE_STEP_SEC = 0.0005;

function readU32be(bytes, off) {
  return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
}

// Streaming FSK demodulator. Feed it raw mono Float32 samples via push();
// it emits CRC-checked frame bodies through cb.onFrame and state changes
// through cb.onStatus. All positions are absolute sample indices since start.
export class Demodulator {
  constructor(fs, cb = {}) {
    this.fs = fs;
    this.cb = cb;
    this.sps = Math.round(SYMBOL_SEC * fs);
    this.winLen = Math.round(WIN_SEC * fs);
    this.winOff = Math.round((this.sps - this.winLen) / 2);
    this.hop = Math.round(this.sps / HOP_DIV);
    this.fine = Math.max(1, Math.round(FINE_STEP_SEC * fs));
    this.bank = new Filterbank(fs, this.winLen, TONE_FREQS);
    this.scratch = new Float32Array(this.winLen);
    this.chunkBodySymbols = (1 + CHUNK_PAYLOAD + 4) * 2;

    this.cap = 1 << 19;
    while (this.cap < fs * 6) this.cap <<= 1;
    this.ring = new Float32Array(this.cap);
    this.absEnd = 0;

    this.state = 'hunt';
    this.huntPos = 0;
    this.hist = [];
    this.trial = false;
  }

  push(samples) {
    let src = 0;
    while (src < samples.length) {
      const off = this.absEnd % this.cap;
      const take = Math.min(samples.length - src, this.cap - off);
      this.ring.set(samples.subarray(src, src + take), off);
      this.absEnd += take;
      src += take;
    }
    this._process();
  }

  _have(symStart) {
    return symStart + this.winOff + this.winLen <= this.absEnd;
  }

  // Tone energies for a symbol hypothetically starting at symStart.
  // Returns null if the window is out of range or already overwritten.
  _energies(symStart) {
    const p = symStart + this.winOff;
    if (p < 0 || p + this.winLen > this.absEnd || p < this.absEnd - this.cap) return null;
    const off = p % this.cap;
    const first = Math.min(this.winLen, this.cap - off);
    this.scratch.set(this.ring.subarray(off, off + first), 0);
    if (first < this.winLen) this.scratch.set(this.ring.subarray(0, this.winLen - first), first);
    // Copy: the filterbank reuses its output array, and callers hold two
    // windows' energies at once (e.g. both marker symbols).
    return Float32Array.from(this.bank.energies(this.scratch));
  }

  _status(state, detail) {
    this.cb.onStatus?.({ state, detail });
  }

  _toHunt(pos) {
    this.state = 'hunt';
    this.huntPos = Math.max(0, pos, this.absEnd - this.cap + this.winLen);
    this.hist = [];
    this.trial = false;
    this._status('hunt');
  }

  _process() {
    let guard = 0;
    while (guard++ < 1000000) {
      let progressed = false;
      if (this.state === 'hunt') progressed = this._stepHunt();
      else if (this.state === 'align') progressed = this._stepAlign();
      else if (this.state === 'sync') progressed = this._stepSync();
      else if (this.state === 'trialAlign') progressed = this._stepTrialAlign();
      else if (this.state === 'marker') progressed = this._stepMarker();
      else if (this.state === 'body') progressed = this._stepBody();
      else if (this.state === 'eot') progressed = this._stepEot();
      if (!progressed) return;
    }
  }

  _stepHunt() {
    if (!this._have(this.huntPos)) return false;
    const e = this._energies(this.huntPos);
    if (!e) {
      this.huntPos = Math.max(this.huntPos + this.hop, this.absEnd - this.cap + this.winLen);
      return true;
    }
    const m0 = e[M0];
    const m1 = e[M1];
    let dataMax = 0;
    let tot = 0;
    for (let i = 0; i < TONE_FREQS.length; i++) tot += e[i];
    for (let i = 0; i < DATA_TONE_COUNT; i++) if (e[i] > dataMax) dataMax = e[i];
    const d = (m1 - m0) / (m1 + m0 + 1e-12);
    this.hist.push({ pos: this.huntPos, d, m0, m1, dataMax, tot });
    if (this.hist.length > 64) this.hist.shift();
    const cur = this.huntPos;
    this.huntPos += this.hop;
    if (this._tryPreamble()) return true;
    if (this._tryTrialMarker(cur, m0, m1, dataMax)) return true;
    return true;
  }

  // Preamble = M1/M0 alternating at 25 Hz. The normalized marker-difference d
  // then follows a square wave with period 8 hops; brute-force the 8 phases.
  _tryPreamble() {
    if (this.hist.length < PREAMBLE_HOPS) return false;
    const h = this.hist.slice(-PREAMBLE_HOPS);
    let markerFrac = 0;
    let markerMean = 0;
    for (const x of h) {
      markerFrac += (x.m0 + x.m1) / (x.tot + 1e-12);
      markerMean += x.m0 + x.m1;
    }
    markerFrac /= h.length;
    markerMean /= h.length;
    if (markerFrac < MARKER_FRAC_MIN || markerMean < MIN_AMP2) return false;

    let norm = 1e-12;
    for (const x of h) norm += Math.abs(x.d);
    let best = -Infinity;
    let bestPhi = 0;
    for (let phi = 0; phi < 8; phi++) {
      let s = 0;
      for (let i = 0; i < h.length; i++) s += ((i + phi) % 8 < 4 ? 1 : -1) * h[i].d;
      if (s > best) {
        best = s;
        bestPhi = phi;
      }
    }
    if (best / norm < TEMPLATE_MIN) return false;

    // Hop where (i+phi)%8 == 0 is the estimated start of an M1 symbol.
    for (let i = h.length - 1; i >= 0; i--) {
      if ((i + bestPhi) % 8 === 0) {
        this.alignBase = h[i].pos;
        this.state = 'align';
        this._status('align');
        return true;
      }
    }
    return false;
  }

  // Mid-pass acquisition: a lone strong M0 might be a frame marker. Validated
  // later by a trial frame decode — only a good CRC lets it become a lock.
  _tryTrialMarker(pos, m0, m1, dataMax) {
    if (!(m0 > 4 * m1 && m0 > 2 * dataMax && m0 > MIN_AMP2)) return false;
    // Recent M1-dominant hops mean we're likely inside the preamble; let the
    // preamble detector handle that instead.
    for (let i = this.hist.length - 2; i >= Math.max(0, this.hist.length - 9); i--) {
      const x = this.hist[i];
      if (x.m1 > 2 * x.m0 && x.m1 > MIN_AMP2) return false;
    }
    this.trialBase = pos;
    this.huntResume = this.huntPos;
    this.state = 'trialAlign';
    return true;
  }

  _stepAlign() {
    const range = Math.round(ALIGN_SEC * this.fs);
    const K = 4;
    if (!this._have(this.alignBase + range + (K - 1) * this.sps)) return false;
    let best = -Infinity;
    let bestOff = 0;
    for (let o = -range; o <= range; o += this.fine) {
      let s = 0;
      let valid = true;
      for (let k = 0; k < K; k++) {
        const e = this._energies(this.alignBase + o + k * this.sps);
        if (!e) {
          valid = false;
          break;
        }
        s += ((k & 1) === 0 ? 1 : -1) * (e[M1] - e[M0]);
      }
      if (valid && s > best) {
        best = s;
        bestOff = o;
      }
    }
    if (best === -Infinity) {
      this._toHunt(this.alignBase + this.sps);
      return true;
    }
    this.symPos = this.alignBase + bestOff;
    this.syncSeen = [];
    this.syncCount = 0;
    this.state = 'sync';
    this._status('sync');
    return true;
  }

  _stepSync() {
    if (!this._have(this.symPos)) return false;
    const e = this._energies(this.symPos);
    if (!e) {
      this._toHunt(this.symPos + this.sps);
      return true;
    }
    let sym = 0;
    for (let i = 1; i < TONE_FREQS.length; i++) if (e[i] > e[sym]) sym = i;
    this.syncSeen.push(sym);
    if (this.syncSeen.length > SYNC_SYMBOLS.length) this.syncSeen.shift();
    this.symPos += this.sps;
    this.syncCount++;
    if (
      this.syncSeen.length === SYNC_SYMBOLS.length &&
      this.syncSeen.every((v, i) => v === SYNC_SYMBOLS[i])
    ) {
      this.P = this.symPos;
      this.markerFails = 0;
      this.state = 'marker';
      this._status('locked');
      return true;
    }
    if (this.syncCount > SYNC_TIMEOUT_SYMBOLS) this._toHunt(this.symPos);
    return true;
  }

  _stepTrialAlign() {
    const range = Math.round(ALIGN_SEC * this.fs);
    if (!this._have(this.trialBase + range + this.sps)) return false;
    let best = -Infinity;
    let bestOff = 0;
    for (let o = -range; o <= range; o += this.fine) {
      const e0 = this._energies(this.trialBase + o);
      const e1 = this._energies(this.trialBase + o + this.sps);
      if (!e0) continue;
      const s0 = e0[M0] - e0[M1];
      if (!e1) continue;
      const s = s0 + (e1[M1] - e1[M0]);
      if (s > best) {
        best = s;
        bestOff = o;
      }
    }
    const C = this.trialBase + bestOff;
    const e0 = this._energies(C);
    const e1 = this._energies(C + this.sps);
    if (
      best === -Infinity || !e0 || !e1 ||
      !(e0[M0] > 2 * e0[M1] && e0[M0] > MIN_AMP2 && e1[M1] > 2 * e1[M0] && e1[M1] > MIN_AMP2)
    ) {
      this._toHunt(this.huntResume);
      return true;
    }
    this.trial = true;
    this.markerFails = 0;
    this._startBody(C + 2 * this.sps);
    return true;
  }

  _startBody(start) {
    this.bodyStart = start;
    this.bodySyms = [];
    this.bodyNeed = 2; // grows once seq (and for headers, len) is known
    this.confSum = 0;
    this.state = 'body';
  }

  _stepBody() {
    while (this.bodySyms.length < this.bodyNeed) {
      const symStart = this.bodyStart + this.bodySyms.length * this.sps;
      if (!this._have(symStart)) return false;
      const e = this._energies(symStart);
      if (!e) {
        this._toHunt(symStart);
        return true;
      }
      let bi = 0;
      let tot = 1e-12;
      for (let i = 0; i < DATA_TONE_COUNT; i++) {
        tot += e[i];
        if (e[i] > e[bi]) bi = i;
      }
      this.confSum += e[bi] / tot;
      this.bodySyms.push(bi);
      if (this.bodySyms.length === 2) {
        const seq = (this.bodySyms[0] << 4) | this.bodySyms[1];
        this.bodyNeed = seq === HEADER_SEQ ? 4 : this.chunkBodySymbols;
      } else if (this.bodySyms.length === 4 && this.bodyNeed === 4) {
        const len = (this.bodySyms[2] << 4) | this.bodySyms[3];
        this.bodyNeed = (6 + len) * 2; // seq + len + payload + crc32, in symbols
      }
    }
    const nBytes = this.bodySyms.length / 2;
    const bytes = new Uint8Array(nBytes);
    for (let i = 0; i < nBytes; i++) {
      bytes[i] = (this.bodySyms[2 * i] << 4) | this.bodySyms[2 * i + 1];
    }
    const crcOk =
      nBytes >= 6 && crc32(bytes.subarray(0, nBytes - 4)) === readU32be(bytes, nBytes - 4);
    if (this.trial && !crcOk) {
      this._toHunt(this.huntResume);
      return true;
    }
    if (this.trial) this._status('locked');
    this.trial = false;
    this.cb.onFrame?.({ bytes, crcOk, confidence: this.confSum / this.bodySyms.length });
    this.P = this.bodyStart + this.bodySyms.length * this.sps;
    this.state = 'marker';
    return true;
  }

  // Expect the next frame's [M0, M1] marker at P; fine-search +/-5 ms around it
  // so clock drift is re-zeroed on every frame.
  _stepMarker() {
    const range = Math.round(MARKER_ALIGN_SEC * this.fs);
    if (!this._have(this.P + range + this.sps)) return false;
    let best = -Infinity;
    let bestOff = 0;
    for (let o = -range; o <= range; o += this.fine) {
      const e0 = this._energies(this.P + o);
      const e1 = this._energies(this.P + o + this.sps);
      if (!e0 || !e1) continue;
      const s = e0[M0] - e0[M1] + (e1[M1] - e1[M0]);
      if (s > best) {
        best = s;
        bestOff = o;
      }
    }
    if (best === -Infinity) {
      this._toHunt(this.P);
      return true;
    }
    this.P += bestOff;
    const e0 = this._energies(this.P);
    const e1 = this._energies(this.P + this.sps);
    if (!e0 || !e1) {
      this._toHunt(this.P);
      return true;
    }
    if (e0[M1] > 2 * e0[M0] && e1[M1] > 2 * e1[M0] && e0[M1] > MIN_AMP2) {
      this.eotStart = this.P;
      this.state = 'eot';
      return true;
    }
    const ok =
      e0[M0] > e0[M1] && e0[M0] > MIN_AMP2 && e1[M1] > e1[M0] && e1[M1] > MIN_AMP2;
    if (ok) {
      this.markerFails = 0;
      this._startBody(this.P + 2 * this.sps);
      return true;
    }
    this.markerFails++;
    if (this.markerFails >= MAX_MARKER_FAILS) {
      this._toHunt(this.P);
      return true;
    }
    // Assume a chunk-sized frame went by unheard and try the next slot.
    this.P += (2 + this.chunkBodySymbols) * this.sps;
    return true;
  }

  _stepEot() {
    if (!this._have(this.eotStart + (EOT_SYMBOLS - 1) * this.sps)) return false;
    let cnt = 0;
    for (let k = 0; k < EOT_SYMBOLS; k++) {
      const e = this._energies(this.eotStart + k * this.sps);
      if (!e) continue;
      let dataMax = 0;
      for (let i = 0; i < DATA_TONE_COUNT; i++) if (e[i] > dataMax) dataMax = e[i];
      if (e[M1] > e[M0] && e[M1] > dataMax) cnt++;
    }
    if (cnt >= 7) {
      this._status('eot');
      this.cb.onEot?.();
      this._toHunt(this.eotStart + EOT_SYMBOLS * this.sps);
    } else {
      this._toHunt(this.eotStart + this.sps);
    }
    return true;
  }
}
