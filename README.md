# dialup-sim

A dial-up modem in your browser: transfer a small file between two devices using nothing but **sound** — one device plays it through its speaker, the other decodes it from its microphone. No network, no backend, no libraries.

## How it works

- **Modulation:** 16-ary FSK, hand-rolled with the Web Audio API. Each 20 ms symbol is one of 16 tones (2000–3500 Hz, 100 Hz apart) carrying 4 bits. Marker tones at 1700/3800 Hz frame the data. ~22 bytes/sec effective. The band deliberately stays under ~3.8 kHz — small speakers and off-axis mics roll off hard above that, and every distortion harmonic lands outside the band.
- **Framing:** each pass = preamble → header (name, size, MIME, CRC32) → 48-byte chunks (each with its own CRC32) → end-of-transmission. The sender loops passes; the receiver keeps whatever chunks verified and fills the holes on the next pass — no back-channel needed.
- **Decoding:** a Goertzel filterbank evaluates exact tone frequencies at whatever sample rate the device runs (44.1 or 48 kHz), with per-frame clock resync so two devices' independent clocks stay aligned.

## Run it

```sh
python3 -m http.server 8000     # or: npm run serve
```

- Open http://localhost:8000 on the **sending** machine, pick a file (≤ 10 KB) or just type a message, hit Transmit. Volume up.
- Open the same app on the **receiving** device, Receive tab, Start listening. Keep the mic within ~30–60 cm.

The mic requires a secure context: `localhost` works as-is; for a phone, deploy the folder to any static host (Netlify drag-and-drop, GitHub Pages) and open the HTTPS URL.

A 1 KB file takes about a minute per pass; 10 KB about 8 minutes. Keep screens on (the app requests a wake lock, but help it).

## Test it

```sh
node run-tests.mjs   # or: npm test
```

Pure loopback tests — encoder output fed straight into the decoder, no audio hardware: clean transfers at 44.1/48 kHz, 10 dB SNR noise, 200 ppm clock drift, a 0.5 s dropout recovered by a second pass, joining mid-transmission, and a full 10 KB file. `test.html` runs the same suite in a browser.

## Layout

```
js/config.js       protocol constants (tones, timing, frame sizes)
js/modulator.js    symbols -> Float32 samples
js/goertzel.js     exact-frequency tone-energy filterbank
js/demodulator.js  streaming decoder: hunt/align/sync/frame state machine
js/protocol.js     file <-> frames, carousel assembler
js/sender.js       just-in-time AudioBuffer scheduling
js/receiver.js     mic -> AudioWorklet -> demodulator
js/capture-worklet.js  audio-thread capture shim
js/main.js, ui.js  the app
```
