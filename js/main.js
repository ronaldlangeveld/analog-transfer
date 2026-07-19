import { MAX_FILE_BYTES } from './config.js';
import { buildPassSegments, passDurationSec, Assembler } from './protocol.js';
import { Sender } from './sender.js';
import { Receiver } from './receiver.js';
import { fmtBytes, fmtSecs, startSpectrum, ChunkGrid, showResult } from './ui.js';

const $ = (id) => document.getElementById(id);

// ---- tabs ----
const tabs = { send: [$('tab-send'), $('panel-send')], receive: [$('tab-receive'), $('panel-receive')] };
for (const [name, [tab]] of Object.entries(tabs)) {
  tab.addEventListener('click', () => {
    for (const [tab2, panel2] of Object.values(tabs)) {
      tab2.classList.remove('active');
      panel2.classList.remove('active');
    }
    tabs[name][0].classList.add('active');
    tabs[name][1].classList.add('active');
  });
}

// ---- wake lock (screens off = transfer dead on phones) ----
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock) wakeLock = await navigator.wakeLock?.request('screen');
    if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* not critical */
  }
}

// ---- send ----
const sender = new Sender();
let picked = null; // { bytes, name, mime, segments }

$('file-input').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    $('drop-label').textContent = `Too big: ${fmtBytes(file.size)} — max is ${fmtBytes(MAX_FILE_BYTES)}`;
    picked = null;
    $('btn-send').disabled = true;
    return;
  }
  if (file.size === 0) {
    $('drop-label').textContent = 'File is empty — pick something with bytes in it';
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const segments = buildPassSegments(bytes, file.name, file.type);
  picked = { bytes, name: file.name, mime: file.type, segments };
  $('drop').classList.add('armed');
  $('drop-label').textContent = 'File loaded — ready to transmit';
  $('file-info').classList.remove('hidden');
  $('fi-name').textContent = file.name;
  $('fi-size').textContent = fmtBytes(file.size);
  $('fi-chunks').textContent = String(segments.length - 3); // minus preamble/header/eot
  $('fi-eta').textContent = fmtSecs(passDurationSec(segments));
  $('btn-send').disabled = false;
});

let sending = false;
$('btn-send').addEventListener('click', async () => {
  if (sending) {
    sender.stop();
    sendStopped();
    return;
  }
  if (!picked) return;
  sending = true;
  keepAwake(true);
  $('btn-send').textContent = 'Stop';
  $('btn-send').classList.add('stop');
  $('send-status').classList.remove('hidden');
  $('send-pass').textContent = 'pass 1';
  await sender.start(picked.segments, {
    loop: $('loop-toggle').checked,
    onProgress: (idx, total) => {
      $('send-state').textContent = picked.segments[Math.min(idx, total - 1)].label;
      $('send-progress').style.width = `${Math.round((idx / total) * 100)}%`;
    },
    onPass: (n) => {
      $('send-pass').textContent = `pass ${n}`;
    },
    onDone: sendStopped,
  });
});

function sendStopped() {
  sending = false;
  keepAwake(false);
  $('btn-send').textContent = 'Transmit';
  $('btn-send').classList.remove('stop');
  $('send-state').textContent = 'stopped';
}

// ---- receive ----
const receiver = new Receiver();
const grid = new ChunkGrid($('chunk-grid'));
let listening = false;
let stopSpectrum = null;
let asm = null;

const els = {
  result: $('result'),
  rxName: $('rx-name'),
  rxSize: $('rx-size'),
  preview: $('preview'),
  download: $('download'),
};

const STATE_TEXT = {
  hunt: 'Listening — hunting for signal…',
  align: 'Signal detected — aligning…',
  sync: 'Preamble found — syncing…',
  locked: 'LOCKED — receiving',
  eot: 'End of pass — waiting for missing chunks',
};

$('btn-listen').addEventListener('click', async () => {
  if (listening) {
    stopListening('Mic off.');
    return;
  }
  asm = new Assembler(onAsmEvent);
  grid.clear();
  els.result.classList.add('hidden');
  $('rx-count').textContent = '';
  try {
    const { sampleRate, analyser } = await receiver.start({
      onFrame: (f) => asm.handleFrame(f),
      onStatus: ({ state }) => {
        if (listening) $('rx-state').textContent = STATE_TEXT[state] || state;
      },
    });
    listening = true;
    keepAwake(true);
    $('btn-listen').textContent = 'Stop listening';
    $('btn-listen').classList.add('stop');
    $('rx-state').textContent = STATE_TEXT.hunt;
    stopSpectrum = startSpectrum($('spectrum'), analyser, sampleRate);
  } catch (err) {
    $('rx-state').textContent = `Mic error: ${err.message}`;
  }
});

function onAsmEvent(ev) {
  if (ev.type === 'header') {
    grid.build(ev.meta.chunkCount);
    for (const seq of asm.chunks.keys()) grid.mark(seq);
    $('rx-count').textContent = `${asm.chunks.size}/${ev.meta.chunkCount} chunks`;
  } else if (ev.type === 'chunk') {
    grid.mark(ev.seq);
    $('rx-count').textContent = ev.total ? `${ev.have}/${ev.total} chunks` : `${ev.have} chunks`;
  } else if (ev.type === 'restart') {
    grid.build(asm.meta.chunkCount);
    $('rx-count').textContent = 'file CRC mismatch — starting over';
  } else if (ev.type === 'complete') {
    stopListening('Done.');
    showResult(els, ev.bytes, ev.meta);
  }
}

function stopListening(msg) {
  receiver.stop();
  listening = false;
  keepAwake(false);
  stopSpectrum?.();
  stopSpectrum = null;
  $('btn-listen').textContent = 'Start listening';
  $('btn-listen').classList.remove('stop');
  $('rx-state').textContent = msg;
}
