export function fmtBytes(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export function fmtSecs(s) {
  if (s < 90) return `${Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

// Live mic spectrum with the FSK band highlighted. Returns a stop function.
export function startSpectrum(canvas, analyser, sampleRate) {
  const ctx2d = canvas.getContext('2d');
  const bins = new Uint8Array(analyser.frequencyBinCount);
  const binHz = sampleRate / 2 / bins.length;
  let running = true;
  const draw = () => {
    if (!running) return;
    analyser.getByteFrequencyData(bins);
    const { width: w, height: h } = canvas;
    ctx2d.clearRect(0, 0, w, h);
    // Show 0..6 kHz
    const maxBin = Math.min(bins.length, Math.ceil(6000 / binHz));
    const bw = w / maxBin;
    for (let i = 0; i < maxBin; i++) {
      const f = i * binHz;
      const inBand = f >= 1600 && f <= 3900;
      const v = bins[i] / 255;
      ctx2d.fillStyle = inBand ? `rgba(53,224,90,${0.25 + 0.75 * v})` : `rgba(109,153,118,${0.15 + 0.6 * v})`;
      ctx2d.fillRect(i * bw, h - v * h, Math.max(1, bw - 1), v * h);
    }
    requestAnimationFrame(draw);
  };
  draw();
  return () => {
    running = false;
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  };
}

export class ChunkGrid {
  constructor(el) {
    this.el = el;
    this.cells = [];
  }

  build(count) {
    this.el.innerHTML = '';
    this.cells = [];
    for (let i = 0; i < count; i++) {
      const c = document.createElement('div');
      c.className = 'cell';
      c.title = `chunk ${i}`;
      this.el.appendChild(c);
      this.cells.push(c);
    }
  }

  mark(i) {
    if (this.cells[i]) this.cells[i].classList.add('got');
  }

  clear() {
    this.el.innerHTML = '';
    this.cells = [];
  }
}

export function showResult(els, bytes, meta) {
  els.result.classList.remove('hidden');
  els.rxName.textContent = meta.name || 'received.bin';
  els.rxSize.textContent = fmtBytes(bytes.length);
  els.preview.innerHTML = '';
  const mime = meta.mime || 'application/octet-stream';
  const blob = new Blob([bytes], { type: mime });
  if (mime.startsWith('text/')) {
    const pre = document.createElement('pre');
    pre.textContent = new TextDecoder().decode(bytes);
    els.preview.appendChild(pre);
  } else if (mime.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    els.preview.appendChild(img);
  }
  els.download.href = URL.createObjectURL(blob);
  els.download.download = meta.name || 'received.bin';
}
