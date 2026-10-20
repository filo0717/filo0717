// Rilevamento automatico del bersaglio (trasformata di Hough circolare guidata dal gradiente)
// e rilevamento sperimentale dei fori.
// Lavora su una versione ridotta dell'immagine per restare veloce anche su telefono.

function toGray(source, maxSize) {
  const sw = source.width ?? source.naturalWidth ?? source.videoWidth;
  const sh = source.height ?? source.naturalHeight ?? source.videoHeight;
  const scale = Math.min(1, maxSize / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    gray[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }
  return { gray, w, h, scale };
}

function boxBlur(src, w, h, radius) {
  // blur separabile con somme cumulative
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const size = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    for (let x = -radius; x <= radius; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / size;
      const xa = Math.max(0, Math.min(w - 1, x - radius));
      const xb = Math.min(w - 1, x + radius + 1);
      acc += src[row + xb] - src[row + xa];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / size;
      const ya = Math.max(0, Math.min(h - 1, y - radius));
      const yb = Math.min(h - 1, y + radius + 1);
      acc += tmp[yb * w + x] - tmp[ya * w + x];
    }
  }
  return out;
}

function sobel(g, w, h) {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1];
      const d = g[i - 1], f = g[i + 1];
      const gg = g[i + w - 1], hh = g[i + w], k = g[i + w + 1];
      const sx = (c + 2 * f + k) - (a + 2 * d + gg);
      const sy = (gg + 2 * hh + k) - (a + 2 * b + c);
      gx[i] = sx; gy[i] = sy; mag[i] = Math.hypot(sx, sy);
    }
  }
  return { gx, gy, mag };
}

function percentile(arr, p) {
  const hist = new Uint32Array(1024);
  let max = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  if (max === 0) return 0;
  for (let i = 0; i < arr.length; i++) hist[Math.min(1023, Math.floor((arr[i] / max) * 1023))]++;
  let acc = 0;
  const target = p * arr.length;
  for (let b = 0; b < 1024; b++) {
    acc += hist[b];
    if (acc >= target) return (b / 1023) * max;
  }
  return max;
}

function smooth1d(a, radius = 2) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let s = 0, n = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j >= 0 && j < a.length) { s += a[j]; n++; }
    }
    out[i] = s / n;
  }
  return out;
}

/**
 * Trova il bersaglio circolare principale.
 * @returns {{cx:number, cy:number, r:number, rings:number[], confidence:number}} coordinate nell'immagine originale
 */
export function detectTarget(source, { maxSize = 480 } = {}) {
  const { gray, w, h, scale } = toGray(source, maxSize);
  const blurred = boxBlur(gray, w, h, 1);
  const { gx, gy, mag } = sobel(blurred, w, h);
  const thr = Math.max(25, percentile(mag, 0.9));

  const edges = [];
  for (let i = 0; i < mag.length; i++) if (mag[i] >= thr) edges.push(i);

  const minDim = Math.min(w, h);
  const rmin = Math.max(6, Math.round(0.05 * minDim));
  const rmax = Math.round(0.6 * minDim);

  // Accumulatore dei centri: ogni pixel di bordo vota lungo la direzione del gradiente.
  const acc = new Float32Array(w * h);
  const rStep = minDim > 300 ? 2 : 1;
  for (const i of edges) {
    const x = i % w, y = (i - x) / w;
    const m = mag[i];
    const nx = gx[i] / m, ny = gy[i] / m;
    for (let r = rmin; r <= rmax; r += rStep) {
      for (let s = -1; s <= 1; s += 2) {
        const cx = Math.round(x + s * nx * r), cy = Math.round(y + s * ny * r);
        if (cx >= 0 && cx < w && cy >= 0 && cy < h) acc[cy * w + cx] += 1;
      }
    }
  }
  const accS = boxBlur(acc, w, h, 2);

  // Candidati: top-5 con soppressione dei non massimi.
  const candidates = [];
  const suppressed = new Uint8Array(w * h);
  for (let k = 0; k < 5; k++) {
    let best = -1, bi = -1;
    for (let i = 0; i < accS.length; i++) if (!suppressed[i] && accS[i] > best) { best = accS[i]; bi = i; }
    if (bi < 0 || best <= 0) break;
    const bx = bi % w, by = (bi - bx) / w;
    candidates.push({ x: bx, y: by, votes: best });
    const R = rmin;
    for (let y = Math.max(0, by - R); y <= Math.min(h - 1, by + R); y++)
      for (let x = Math.max(0, bx - R); x <= Math.min(w - 1, bx + R); x++) suppressed[y * w + x] = 1;
  }

  let bestResult = null;
  for (const cand of candidates) {
    const res = analyzeCenter(cand, edges, gx, gy, mag, w, rmin, rmax);
    if (!res) continue;
    // Preferisci leggermente i bersagli vicini al centro dell'inquadratura.
    const dc = Math.hypot(cand.x - w / 2, cand.y - h / 2) / minDim;
    res.score *= 1 - 0.3 * Math.min(1, dc);
    if (!bestResult || res.score > bestResult.score) bestResult = { ...res, x: cand.x, y: cand.y };
  }

  if (!bestResult) {
    return { cx: (w / 2) / scale, cy: (h / 2) / scale, r: (minDim * 0.35) / scale, rings: [], confidence: 0 };
  }
  return {
    cx: bestResult.x / scale,
    cy: bestResult.y / scale,
    r: bestResult.outer / scale,
    rings: bestResult.rings.map((r) => r / scale),
    confidence: bestResult.confidence,
  };
}

function analyzeCenter(c, edges, gx, gy, mag, w, rmin, rmax) {
  const maxR = Math.round(rmax * 1.15);
  const hist = new Float32Array(maxR + 1);
  for (const i of edges) {
    const x = i % w, y = (i - x) / w;
    const dx = x - c.x, dy = y - c.y;
    const d = Math.hypot(dx, dy);
    if (d < 3 || d > maxR) continue;
    const m = mag[i];
    const dot = Math.abs((gx[i] * dx + gy[i] * dy) / (m * d));
    if (dot < 0.85) continue; // il gradiente deve essere radiale
    hist[Math.round(d)] += 1;
  }
  const hs = smooth1d(hist, 1);
  // completezza: voti rispetto alla circonferenza
  const comp = new Float32Array(maxR + 1);
  for (let r = 3; r <= maxR; r++) comp[r] = hs[r] / (2 * Math.PI * r);
  const peaks = [];
  let maxComp = 0;
  for (let r = Math.max(4, Math.round(rmin * 0.5)); r < maxR; r++) {
    if (comp[r] >= comp[r - 1] && comp[r] > comp[r + 1] && comp[r] > 0.08) {
      peaks.push({ r, comp: comp[r] });
      maxComp = Math.max(maxComp, comp[r]);
    }
  }
  if (!peaks.length) return null;
  // Unisci picchi troppo vicini (bordi doppi della stessa linea).
  const merged = [];
  for (const p of peaks.sort((a, b) => a.r - b.r)) {
    const last = merged[merged.length - 1];
    if (last && p.r - last.r <= 3) { if (p.comp > last.comp) merged[merged.length - 1] = p; }
    else merged.push(p);
  }
  const strong = merged.filter((p) => p.comp >= Math.max(0.12, 0.25 * maxComp));
  if (!strong.length) return null;
  const outer = strong[strong.length - 1].r;
  const score = strong.reduce((a, p) => a + Math.min(1, p.comp), 0) + maxComp;
  return { outer, rings: strong.map((p) => p.r), confidence: Math.min(1, maxComp), score };
}

/**
 * Rilevamento sperimentale dei fori.
 * Il bersaglio è simmetrico per rotazione: per ogni distanza dal centro si calcola la mediana
 * dell'intensità lungo l'anello; ciò che se ne discosta molto (e non è un bordo stampato) è un foro.
 * @param source immagine
 * @param target {cx, cy, r} in px immagine
 * @param holeRadiusPx raggio atteso del foro in px immagine
 * @returns {Array<{x:number,y:number}>} coordinate nell'immagine originale
 */
export function detectHoles(source, target, holeRadiusPx, { maxSize = 900, sensitivity = 45 } = {}) {
  const { gray, w, h, scale } = toGray(source, maxSize);
  const hr = Math.max(1.5, holeRadiusPx * scale);
  const cx = target.cx * scale, cy = target.cy * scale, R = target.r * scale * 1.05;
  const bins = Math.ceil(R) + 2;

  // profilo radiale (mediana per anello di 1 px)
  const hist = new Uint32Array(bins * 256);
  const counts = new Uint32Array(bins);
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(w - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(h - 1, Math.ceil(cy + R));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > R) continue;
      const b = Math.round(d);
      hist[b * 256 + Math.max(0, Math.min(255, Math.round(gray[y * w + x])))]++;
      counts[b]++;
    }
  }
  const profile = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    if (!counts[b]) { profile[b] = b ? profile[b - 1] : 128; continue; }
    let acc = 0; const half = counts[b] / 2;
    for (let v = 0; v < 256; v++) { acc += hist[b * 256 + v]; if (acc >= half) { profile[b] = v; break; } }
  }
  // zone di bordo stampato (zona nera, linee): lì il profilo cambia bruscamente e non è affidabile
  // Si cercano i gradini (es. bordo della zona nera), non le linee sottili degli anelli:
  // si confrontano le mediane di due finestre ai lati di ogni raggio.
  const excl = new Uint8Array(bins);
  const guard = Math.round(2 + hr * 0.8);
  const win = (a, b) => {
    const v = [];
    for (let i = Math.max(0, a); i <= Math.min(bins - 1, b); i++) v.push(profile[i]);
    v.sort((p, q) => p - q);
    return v.length ? v[v.length >> 1] : 128;
  };
  for (let b = 0; b < bins; b++) {
    if (Math.abs(win(b + 2, b + 6) - win(b - 6, b - 2)) > 40) {
      // larghezza del gradino: se è netto (centro preciso, foto frontale) basta una fascia stretta
      let width = 0;
      for (let k = -4; k <= 4; k++) {
        const i = b + k;
        if (i > 0 && i < bins && Math.abs(profile[i] - profile[i - 1]) > 8) width++;
      }
      const g = Math.min(guard, 1 + width);
      for (let k = -g; k <= g; k++) if (b + k >= 0 && b + k < bins) excl[b + k] = 1;
    }
  }

  const mask = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > R || d < 2) continue;
      const b = Math.round(d);
      if (excl[b]) continue;
      if (Math.abs(gray[y * w + x] - profile[b]) > sensitivity) mask[y * w + x] = 1;
    }
  }

  // apertura morfologica (erosione + dilatazione di 1 px): elimina le linee sottili degli anelli
  if (hr >= 3) {
    const er = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask[i] && mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w]) er[i] = 1;
    }
    mask.fill(0);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (er[i]) { mask[i] = 1; mask[i - 1] = 1; mask[i + 1] = 1; mask[i - w] = 1; mask[i + w] = 1; }
    }
  }

  // componenti connesse
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const out = [];
  const holeArea = Math.PI * hr * hr;
  const minArea = holeArea * 0.3;
  const maxSingle = holeArea * 2.5;
  const maxCluster = holeArea * 25;
  let label = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    label++;
    let sp = 0; stack[sp++] = start; labels[start] = label;
    const px = [];
    let minX = w, maxX = 0, minY = h, maxY = 0;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i - x) / w;
      px.push(x, y);
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= mask.length) continue;
        if (Math.abs((j % w) - x) > 1) continue;
        if (mask[j] && !labels[j]) { labels[j] = label; stack[sp++] = j; }
      }
    }
    const area = px.length / 2;
    if (area < minArea || area > maxCluster) continue;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = area / (bw * bh);
    if (area <= maxSingle) {
      const aspect = Math.max(bw, bh) / Math.min(bw, bh);
      if (aspect > 1.8 || fill < 0.5) continue; // linea, numero stampato o macchia irregolare
      let sx = 0, sy = 0;
      for (let k = 0; k < px.length; k += 2) { sx += px[k]; sy += px[k + 1]; }
      out.push({ x: sx / area / scale, y: sy / area / scale });
    } else {
      // più fori che si toccano: i centri sono i massimi locali della trasformata distanza
      for (const c of splitCluster(px, minX, minY, bw, bh, hr)) out.push({ x: c.x / scale, y: c.y / scale });
    }
  }
  return out;
}

/** Trova i centri dei fori in un gruppo di fori sovrapposti (picchi della distanza dal bordo). */
function splitCluster(px, minX, minY, bw, bh, hr) {
  const W = bw + 2, H = bh + 2;
  const inside = new Uint8Array(W * H);
  for (let k = 0; k < px.length; k += 2) inside[(px[k + 1] - minY + 1) * W + (px[k] - minX + 1)] = 1;
  // trasformata distanza (chamfer 3-4) in due passate
  const INF = 1e6;
  const dt = new Float32Array(W * H);
  for (let i = 0; i < dt.length; i++) dt[i] = inside[i] ? INF : 0;
  for (let y = 1; y < H; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (!inside[i]) continue;
    dt[i] = Math.min(dt[i], dt[i - 1] + 3, dt[i - W] + 3, dt[i - W - 1] + 4, dt[i - W + 1] + 4);
  }
  for (let y = H - 2; y >= 0; y--) for (let x = W - 2; x >= 1; x--) {
    const i = y * W + x;
    if (!inside[i]) continue;
    dt[i] = Math.min(dt[i], dt[i + 1] + 3, dt[i + W] + 3, dt[i + W - 1] + 4, dt[i + W + 1] + 4);
  }
  const peaks = [];
  const minD = Math.max(2, hr * 0.45) * 3;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const v = dt[i];
    if (v < minD) continue;
    let isMax = true;
    for (let dy = -1; dy <= 1 && isMax; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((dx || dy) && dt[i + dy * W + dx] > v) { isMax = false; break; }
    }
    if (isMax) peaks.push({ x: x - 1 + minX, y: y - 1 + minY, v });
  }
  peaks.sort((a, b) => b.v - a.v);
  const kept = [];
  for (const p of peaks) {
    if (kept.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= hr * 1.3)) kept.push(p);
  }
  if (!kept.length) {
    let sx = 0, sy = 0;
    for (let k = 0; k < px.length; k += 2) { sx += px[k]; sy += px[k + 1]; }
    return [{ x: sx / (px.length / 2), y: sy / (px.length / 2) }];
  }
  // il centro è la media dei pixel del plateau attorno al picco (più stabile del singolo massimo)
  return kept.map((p) => {
    let sx = 0, sy = 0, n = 0;
    const r = Math.max(1, Math.round(hr * 0.5));
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = p.x - minX + 1 + dx, y = p.y - minY + 1 + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (dt[i] >= p.v - 6) { sx += x; sy += y; n++; }
    }
    return { x: sx / n - 1 + minX, y: sy / n - 1 + minY };
  });
}
