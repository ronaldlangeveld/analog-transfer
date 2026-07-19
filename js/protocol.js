import {
  M0, M1, PREAMBLE_PAIRS, SYNC_SYMBOLS, EOT_SYMBOLS, PASS_GAP_SEC,
  CHUNK_PAYLOAD, HEADER_SEQ, MAGIC, VERSION, NAME_MAX, MIME_MAX,
  SYMBOL_SEC,
} from './config.js';
import { crc32 } from './crc32.js';

function u32be(x) {
  return [(x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff];
}

function readU32be(bytes, off) {
  return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
}

export function chunkCountFor(fileSize) {
  return Math.ceil(fileSize / CHUNK_PAYLOAD);
}

function bytesToSymbols(bytes) {
  const syms = [];
  for (const b of bytes) syms.push((b >> 4) & 0x0f, b & 0x0f);
  return syms;
}

// body bytes (crc included) -> marker + nibble symbols
function frameSymbols(body) {
  return [M0, M1, ...bytesToSymbols(body)];
}

function withCrc(body) {
  return [...body, ...u32be(crc32(Uint8Array.from(body)))];
}

export function buildHeaderPayload(fileBytes, name, mime) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name).slice(0, NAME_MAX);
  const mimeB = enc.encode(mime || 'application/octet-stream').slice(0, MIME_MAX);
  const size = fileBytes.length;
  return [
    ...MAGIC, VERSION,
    (size >> 8) & 0xff, size & 0xff,
    chunkCountFor(size),
    ...u32be(crc32(fileBytes)),
    nameB.length, ...nameB,
    mimeB.length, ...mimeB,
  ];
}

export function parseHeaderPayload(p) {
  if (p.length < 12 || p[0] !== MAGIC[0] || p[1] !== MAGIC[1]) return null;
  const dec = new TextDecoder();
  const fileSize = (p[3] << 8) | p[4];
  const chunkCount = p[5];
  const fileCrc = readU32be(p, 6);
  let off = 10;
  const nameLen = p[off++];
  const name = dec.decode(Uint8Array.from(p.slice(off, off + nameLen)));
  off += nameLen;
  const mimeLen = p[off++];
  const mime = dec.decode(Uint8Array.from(p.slice(off, off + mimeLen)));
  return { version: p[2], fileSize, chunkCount, fileCrc, name, mime };
}

// One full transmission pass as an ordered list of segments; the sender turns
// each segment into one AudioBuffer just-in-time (never the whole pass — a
// 10 KB pass is ~8 minutes of audio).
export function buildPassSegments(fileBytes, name, mime) {
  const segments = [];

  const preamble = [];
  for (let i = 0; i < PREAMBLE_PAIRS; i++) preamble.push(M1, M0);
  preamble.push(...SYNC_SYMBOLS);
  segments.push({ label: 'preamble', symbols: preamble });

  const hp = buildHeaderPayload(fileBytes, name, mime);
  const headerBody = withCrc([HEADER_SEQ, hp.length, ...hp]);
  segments.push({ label: 'header', symbols: frameSymbols(headerBody) });

  const count = chunkCountFor(fileBytes.length);
  for (let seq = 0; seq < count; seq++) {
    const payload = new Uint8Array(CHUNK_PAYLOAD);
    payload.set(fileBytes.subarray(seq * CHUNK_PAYLOAD, (seq + 1) * CHUNK_PAYLOAD));
    const body = withCrc([seq, ...payload]);
    segments.push({ label: `chunk ${seq}`, symbols: frameSymbols(body), seq });
  }

  const eot = new Array(EOT_SYMBOLS).fill(M1);
  segments.push({ label: 'eot', symbols: eot, silenceAfterSec: PASS_GAP_SEC });

  return segments;
}

export function passDurationSec(segments) {
  let t = 0;
  for (const s of segments) t += s.symbols.length * SYMBOL_SEC + (s.silenceAfterSec || 0);
  return t;
}

// Collects CRC-verified frames across passes; order-independent and idempotent,
// so the sender can just loop and the receiver fills holes each pass.
export class Assembler {
  constructor(onEvent) {
    this.onEvent = onEvent || (() => {});
    this.meta = null;
    this.chunks = new Map();
    this.done = false;
  }

  handleFrame({ bytes, crcOk }) {
    if (this.done) return;
    if (!crcOk || bytes.length < 6) {
      this.onEvent({ type: 'bad' });
      return;
    }
    const seq = bytes[0];
    if (seq === HEADER_SEQ) {
      const len = bytes[1];
      const meta = parseHeaderPayload(Array.from(bytes.subarray(2, 2 + len)));
      if (!meta) {
        this.onEvent({ type: 'bad' });
        return;
      }
      if (!this.meta) {
        this.meta = meta;
        this.onEvent({ type: 'header', meta });
      }
    } else {
      if (!this.chunks.has(seq)) {
        this.chunks.set(seq, bytes.slice(1, 1 + CHUNK_PAYLOAD));
        this.onEvent({ type: 'chunk', seq, have: this.chunks.size, total: this.meta?.chunkCount });
      }
    }
    this.checkComplete();
  }

  missingChunks() {
    if (!this.meta) return null;
    const missing = [];
    for (let i = 0; i < this.meta.chunkCount; i++) if (!this.chunks.has(i)) missing.push(i);
    return missing;
  }

  checkComplete() {
    if (!this.meta || this.done) return;
    const missing = this.missingChunks();
    if (missing.length > 0) return;
    const out = new Uint8Array(this.meta.fileSize);
    for (let i = 0; i < this.meta.chunkCount; i++) {
      const start = i * CHUNK_PAYLOAD;
      out.set(this.chunks.get(i).subarray(0, Math.min(CHUNK_PAYLOAD, out.length - start)), start);
    }
    if (crc32(out) === this.meta.fileCrc) {
      this.done = true;
      this.onEvent({ type: 'complete', bytes: out, meta: this.meta });
    } else {
      // Every chunk passed its own CRC yet the file doesn't match — most likely
      // chunks from a different transmission got mixed in. Start over.
      this.chunks.clear();
      this.onEvent({ type: 'restart' });
    }
  }
}
