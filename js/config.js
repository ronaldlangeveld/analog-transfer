// All protocol constants live here. Time-based values are in seconds and are
// converted to sample counts at runtime from the actual AudioContext sample
// rate (never hardcode 48000 — iOS often runs at 44100).

export const SYMBOL_SEC = 0.020; // 50 baud
export const RAMP_SEC = 0.005;   // raised-cosine fade at each symbol edge
export const WIN_SEC = 0.015;    // analysis window, centered in the symbol

// 16 data tones, 4 bits/symbol, mapped to musical semitones (12-TET, A4=440)
// C7..D#8 so random data plays as a chromatic arpeggio instead of an
// inharmonic screech. The Goertzel filterbank evaluates exact frequencies, so
// the tones don't need to sit on any uniform Hz grid — they only need enough
// spacing (>=100 Hz; the tightest pair, C7-C#7, is 124 Hz apart). Symbol
// edges are amplitude-ramped to zero, so phase continuity between symbols is
// irrelevant.
export const DATA_TONE_COUNT = 16;
export const TONE_FREQS = [
  2093.0, 2217.46, 2349.32, 2489.02, // C7  C#7 D7  D#7
  2637.02, 2793.83, 2959.96, 3135.96, // E7  F7  F#7 G7
  3322.44, 3520.0, 3729.31, 3951.07, // G#7 A7  A#7 B7
  4186.01, 4434.92, 4698.64, 4978.03, // C8  C#8 D8  D#8
];
// Marker tones sit outside the data band so control can't be mistaken for
// data: A6 below, E8 above (a clean fifth over the top data note).
TONE_FREQS.push(1760.0); // index 16 = M0
TONE_FREQS.push(5274.04); // index 17 = M1
export const M0 = 16;
export const M1 = 17;

// Pass structure: PREAMBLE, HEADER frame, CHUNK frames, EOT, silence, repeat.
export const PREAMBLE_PAIRS = 8;              // 16 symbols alternating M1,M0
export const SYNC_SYMBOLS = [3, 12, 5, 10];   // nibbles confirming lock
export const EOT_SYMBOLS = 10;                // 10x M1 = end of pass
export const PASS_GAP_SEC = 1.0;              // silence between passes

// Frames. Every frame = [M0, M1] marker + body nibbles (high nibble first).
// Chunk body:  seq u8 | payload 48 B (zero-padded) | crc32 over seq+payload
// Header body: seq=0xFF | len u8 | header payload | crc32 over seq..payload
export const CHUNK_PAYLOAD = 48;
export const HEADER_SEQ = 0xff;
export const MAGIC = [0xd1, 0xa1];
export const VERSION = 1;
export const NAME_MAX = 32;
export const MIME_MAX = 24; // fits "application/octet-stream"

export const MAX_FILE_BYTES = 10240; // protocol hard cap: 255 * 48 = 12240
