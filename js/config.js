// All protocol constants live here. Time-based values are in seconds and are
// converted to sample counts at runtime from the actual AudioContext sample
// rate (never hardcode 48000 — iOS often runs at 44100).

export const SYMBOL_SEC = 0.020; // 50 baud
export const RAMP_SEC = 0.003;   // raised-cosine fade at each symbol edge
export const WIN_SEC = 0.015;    // analysis window, centered in the symbol

// 16 data tones, 4 bits/symbol: 2000..3500 Hz in 100 Hz steps.
// Every tone is a multiple of 1/SYMBOL_SEC = 50 Hz, so each symbol holds an
// integer number of cycles and starts/ends at phase 0.
//
// The whole alphabet, markers included, must stay inside ~1.7-3.8 kHz.
// A musical-semitone plan (C7-D#8, markers A6/E8) was tried and reverted:
// its top marker at 5274 Hz falls into the high-frequency rolloff of small
// speakers and off-axis mics, and under rolloff + room reverb the receiver
// never locks at all (see the "hostile channel" test). 12-TET octaves are
// also exact 2:1 ratios, so speaker/mic distortion harmonics of the low
// tones land exactly on the high tones' bins; on this grid every harmonic
// (2x2000=4000 and up) lands outside the band instead.
export const DATA_TONE_COUNT = 16;
export const TONE_FREQS = [];
for (let k = 0; k < DATA_TONE_COUNT; k++) TONE_FREQS.push(2000 + 100 * k);
// Marker tones sit outside the data band so control can't be mistaken for data.
TONE_FREQS.push(1700); // index 16 = M0
TONE_FREQS.push(3800); // index 17 = M1
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
