import { PRESETS, ringDiameter, outerDiameter, computeStats, fmt, mmToMoa } from './stats.js';
import { detectTarget, detectHoles } from './detect.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const STORAGE_KEY = 'tp_sessions_v1';
const SETTINGS_KEY = 'tp_settings_v1';

// ---------------------------------------------------------------------------
// Stato
// ---------------------------------------------------------------------------
const state = {
  view: 'capture',
  image: null, // canvas con l'immagine normalizzata
  imgW: 0,
  imgH: 0,
  target: null, // {cx, cy, r} in px immagine
  detected: null,
  shots: [], // [{x, y}] in px immagine
  selected: -1,
  settings: {
    preset: 'air_rifle',
    d10: PRESETS.air_rifle.d10,
    step: PRESETS.air_rifle.step,
    minRing: 1,
    circleKind: 'outer',
    circleMm: outerDiameter(PRESETS.air_rifle),
    caliber: PRESETS.air_rifle.caliber,
    distance: PRESETS.air_rifle.distance,
    clickMoa: 0.25,
    showRings: true,
  },
  vt: { s: 1, tx: 0, ty: 0, sFit: 1 }, // trasformazione immagine -> canvas (css px)
  stream: null,
  facing: 'environment',
};

function targetDef() {
  const s = state.settings;
  return { d10: s.d10, step: s.step, minRing: s.minRing };
}
function pxPerMm() {
  if (!state.target || !state.settings.circleMm) return 0;
  return state.target.r / (state.settings.circleMm / 2);
}
function shotsMm() {
  const k = pxPerMm();
  if (!k || !state.target) return [];
  return state.shots.map((p) => ({ x: (p.x - state.target.cx) / k, y: (p.y - state.target.cy) / k }));
}

// ---------------------------------------------------------------------------
// Utilità UI
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function showView(name) {
  state.view = name;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  const stage = $('#stage');
  stage.hidden = !(name === 'target' || name === 'shots') || !state.image;
  if (name === 'capture') startCamera(); else stopCamera();
  if (name === 'results') renderResults();
  if (name === 'history') renderHistory();
  if (!stage.hidden) requestAnimationFrame(() => { resizeCanvas(); draw(); });
  window.scrollTo({ top: 0 });
}

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (b) showView(b.dataset.view);
});

// ---------------------------------------------------------------------------
// Fotocamera
// ---------------------------------------------------------------------------
const video = $('#video');
async function startCamera() {
  if (state.stream) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    $('#camera-status').textContent = 'La fotocamera dal vivo non è disponibile: usa "Carica foto" (puoi scattare da lì).';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: state.facing }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    });
    state.stream = stream;
    video.srcObject = stream;
    $('#camera-status').textContent = '';
  } catch (err) {
    $('#camera-status').textContent = `Fotocamera non disponibile (${err.name}). Usa "Carica foto": sul telefono puoi scattare direttamente da lì.`;
  }
}
function stopCamera() {
  if (!state.stream) return;
  state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  video.srcObject = null;
}
$('#btn-flip').addEventListener('click', async () => {
  state.facing = state.facing === 'environment' ? 'user' : 'environment';
  stopCamera();
  await startCamera();
});
$('#btn-shoot').addEventListener('click', () => {
  if (!state.stream || !video.videoWidth) {
    $('#file-input').click();
    return;
  }
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  loadImageSource(c);
});
$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      bmp = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = URL.createObjectURL(file);
      });
    }
    loadImageSource(bmp);
  } catch (err) {
    toast('Impossibile leggere l\'immagine');
  } finally {
    e.target.value = '';
  }
});

// Normalizza l'immagine in un canvas (max 2000 px) e avvia il rilevamento.
async function loadImageSource(src, { keepShots = false } = {}) {
  const sw = src.width ?? src.naturalWidth, sh = src.height ?? src.naturalHeight;
  const k = Math.min(1, 2000 / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * k); c.height = Math.round(sh * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  state.image = c; state.imgW = c.width; state.imgH = c.height;
  if (!keepShots) { state.shots = []; state.selected = -1; }
  stopCamera();
  showView('target');
  await runDetection();
}

async function runDetection() {
  $('#detect-status').textContent = 'Rilevamento del bersaglio in corso…';
  await new Promise((r) => setTimeout(r, 30));
  const t0 = performance.now();
  const det = detectTarget(state.image);
  state.detected = det;
  state.target = { cx: det.cx, cy: det.cy, r: det.r };
  const ms = Math.round(performance.now() - t0);
  const conf = Math.round(det.confidence * 100);
  $('#detect-status').textContent = det.confidence > 0.3
    ? `Bersaglio trovato (${conf}% di contorno riconosciuto, ${det.rings.length} anelli, ${ms} ms). Controlla che il cerchio coincida con l'anello scelto in "Calibrazione".`
    : `Bersaglio incerto (${conf}%): sistema il cerchio a mano trascinando centro e bordo.`;
  fitView();
  updateScaleInfo();
  draw();
}

$('#btn-redetect').addEventListener('click', () => state.image && runDetection());
$('#btn-center-reset').addEventListener('click', () => {
  if (!state.image) return;
  state.target = { cx: state.imgW / 2, cy: state.imgH / 2, r: Math.min(state.imgW, state.imgH) * 0.35 };
  draw(); updateScaleInfo();
});
$('#btn-fit').addEventListener('click', () => { fitView(); draw(); });
$$('[data-nudge]').forEach((b) => b.addEventListener('click', () => {
  if (!state.target) return;
  const [dx, dy] = b.dataset.nudge.split(',').map(Number);
  const step = 1 / state.vt.s; // un pixel di schermo
  state.target.cx += dx * step; state.target.cy += dy * step;
  draw();
}));
$$('[data-radius]').forEach((b) => b.addEventListener('click', () => {
  if (!state.target) return;
  state.target.r = Math.max(5, state.target.r + Number(b.dataset.radius) / state.vt.s);
  draw(); updateScaleInfo();
}));

// ---------------------------------------------------------------------------
// Bersaglio di prova (immagine sintetica)
// ---------------------------------------------------------------------------
$('#btn-demo').addEventListener('click', () => {
  const W = 1400, H = 1050;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  // sfondo "tavolo" e foglio
  ctx.fillStyle = '#6b5b4a'; ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2, H / 2); ctx.rotate(0.03);
  ctx.fillStyle = '#f3f0e8'; ctx.fillRect(-520, -440, 1040, 880);
  // rumore leggero
  for (let i = 0; i < 6000; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
    ctx.fillRect(-520 + Math.random() * 1040, -440 + Math.random() * 880, 2, 2);
  }
  const preset = PRESETS.air_pistol; // 155,5 mm esterno, zona nera 59,5
  const scale = 780 / outerDiameter(preset); // px per mm
  const cx = 30, cy = -10;
  // zona nera
  ctx.fillStyle = '#111';
  ctx.beginPath(); ctx.arc(cx, cy, (preset.black / 2) * scale, 0, Math.PI * 2); ctx.fill();
  // anelli
  for (let n = 1; n <= 10; n++) {
    const r = (ringDiameter(preset, n) / 2) * scale;
    const inBlack = ringDiameter(preset, n) <= preset.black + 0.01;
    ctx.strokeStyle = inBlack ? '#f3f0e8' : '#222';
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    if (n < 10) {
      ctx.fillStyle = inBlack ? '#f3f0e8' : '#222';
      ctx.font = '22px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const rr = r - (preset.step * scale) / 2;
      for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) ctx.fillText(String(n), cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
  }
  // fori: 10 colpi con dispersione gaussiana e un piccolo spostamento delle mire
  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;
  const holeR = (preset.caliber / 2) * scale;
  const truth = [];
  for (let i = 0; i < 10; i++) {
    const x = cx + (14 + gauss() * 9) * scale, y = cy + (-8 + gauss() * 9) * scale;
    truth.push({ x: W / 2 + x * Math.cos(0.03) - y * Math.sin(0.03), y: H / 2 + x * Math.sin(0.03) + y * Math.cos(0.03) });
    const onBlack = Math.hypot(x - cx, y - cy) < (preset.black / 2) * scale - holeR;
    // sulla zona nera il foro mostra lo sfondo chiaro, sulla carta appare scuro
    const g = ctx.createRadialGradient(x, y, holeR * 0.3, x, y, holeR * 1.2);
    if (onBlack) { g.addColorStop(0, '#9a948c'); g.addColorStop(0.8, '#7a746c'); g.addColorStop(1, 'rgba(60,56,52,0)'); }
    else { g.addColorStop(0, '#2a2622'); g.addColorStop(0.8, '#3a3530'); g.addColorStop(1, 'rgba(120,110,100,0)'); }
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, holeR * 1.2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  state.demoTruth = truth; // usato dai test automatici
  applyPreset('air_pistol');
  loadImageSource(c);
  toast('Bersaglio di prova caricato');
});

// ---------------------------------------------------------------------------
// Calibrazione / impostazioni
// ---------------------------------------------------------------------------
const presetSel = $('#preset');
for (const [k, p] of Object.entries(PRESETS)) {
  const o = document.createElement('option');
  o.value = k; o.textContent = p.name;
  presetSel.appendChild(o);
}

function applyPreset(key) {
  const p = PRESETS[key];
  const s = state.settings;
  s.preset = key;
  if (key !== 'custom') {
    s.d10 = p.d10; s.step = p.step; s.minRing = p.minRing ?? 1;
    s.caliber = p.caliber; s.distance = p.distance;
  }
  s.circleKind = 'outer';
  s.circleMm = circleMmFor('outer');
  syncSettingsUI();
}

function circleMmFor(kind) {
  const s = state.settings;
  const p = PRESETS[s.preset];
  const t = targetDef();
  if (kind === 'outer') return outerDiameter(t);
  if (kind === 'black') return p.black;
  if (kind.startsWith('ring_')) return ringDiameter(t, Number(kind.slice(5)));
  return s.circleMm;
}

function syncSettingsUI() {
  const s = state.settings;
  presetSel.value = s.preset;
  const kindSel = $('#circle-kind');
  kindSel.innerHTML = '';
  const opts = [['outer', `Anello esterno (${fmt(outerDiameter(targetDef()))} mm)`]];
  if (s.preset !== 'custom') opts.push(['black', `Zona nera (${fmt(PRESETS[s.preset].black)} mm)`]);
  for (let n = 9; n >= s.minRing + 1; n--) opts.push([`ring_${n}`, `Anello ${n} (${fmt(ringDiameter(targetDef(), n))} mm)`]);
  opts.push(['custom', 'Altro: inserisco il diametro']);
  for (const [v, l] of opts) {
    const o = document.createElement('option'); o.value = v; o.textContent = l; kindSel.appendChild(o);
  }
  kindSel.value = s.circleKind;
  $('#circle-mm').value = s.circleMm;
  $('#caliber').value = s.caliber;
  $('#distance').value = s.distance;
  $('#click-moa').value = String(s.clickMoa);
  $('#custom-target').hidden = s.preset !== 'custom';
  $('#d10').value = s.d10;
  $('#ring-step').value = s.step;
  $('#show-rings').checked = s.showRings;
  saveSettings();
  updateScaleInfo();
}

presetSel.addEventListener('change', () => { applyPreset(presetSel.value); draw(); });
$('#circle-kind').addEventListener('change', (e) => {
  state.settings.circleKind = e.target.value;
  state.settings.circleMm = circleMmFor(e.target.value);
  syncSettingsUI(); draw();
});
$('#circle-mm').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  if (v > 0) { state.settings.circleMm = v; state.settings.circleKind = 'custom'; $('#circle-kind').value = 'custom'; }
  saveSettings(); updateScaleInfo(); draw();
});
$('#caliber').addEventListener('input', (e) => { state.settings.caliber = Number(e.target.value) || 0; saveSettings(); draw(); });
$('#distance').addEventListener('input', (e) => { state.settings.distance = Number(e.target.value) || 0; saveSettings(); });
$('#click-moa').addEventListener('change', (e) => { state.settings.clickMoa = Number(e.target.value); saveSettings(); });
$('#d10').addEventListener('input', (e) => { state.settings.d10 = Number(e.target.value) || 0.1; state.settings.circleMm = circleMmFor(state.settings.circleKind); syncSettingsUI(); draw(); });
$('#ring-step').addEventListener('input', (e) => { state.settings.step = Number(e.target.value) || 0.1; state.settings.circleMm = circleMmFor(state.settings.circleKind); syncSettingsUI(); draw(); });
$('#show-rings').addEventListener('change', (e) => { state.settings.showRings = e.target.checked; saveSettings(); draw(); });

function updateScaleInfo() {
  const k = pxPerMm();
  $('#scale-info').textContent = k
    ? `Scala: ${fmt(k, 2)} px/mm · il bersaglio intero (${fmt(outerDiameter(targetDef()))} mm) corrisponde a ${Math.round(outerDiameter(targetDef()) * k)} px nell'immagine.`
    : '';
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* ignora */ }
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (s && PRESETS[s.preset]) Object.assign(state.settings, s);
  } catch { /* ignora */ }
}

// ---------------------------------------------------------------------------
// Stage: canvas, trasformazioni, disegno
// ---------------------------------------------------------------------------
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
let cssW = 0, cssH = 0;

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (rect.width === 0) return;
  const changed = cssW !== rect.width || cssH !== rect.height;
  cssW = rect.width; cssH = rect.height;
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (changed) fitView();
}
window.addEventListener('resize', () => { if (!$('#stage').hidden) { resizeCanvas(); draw(); } });

function fitView() {
  if (!state.image || !cssW) return;
  const s = Math.min(cssW / state.imgW, cssH / state.imgH);
  state.vt = { s, tx: (cssW - state.imgW * s) / 2, ty: (cssH - state.imgH * s) / 2, sFit: s };
}
function toCanvas(p) { return { x: p.x * state.vt.s + state.vt.tx, y: p.y * state.vt.s + state.vt.ty }; }
function toImage(p) { return { x: (p.x - state.vt.tx) / state.vt.s, y: (p.y - state.vt.ty) / state.vt.s }; }
function zoomAt(f, px, py) {
  const v = state.vt;
  const s2 = Math.min(v.sFit * 16, Math.max(v.sFit * 0.5, v.s * f));
  const k = s2 / v.s;
  v.tx = px - (px - v.tx) * k; v.ty = py - (py - v.ty) * k; v.s = s2;
  clampPan();
}
function clampPan() {
  const v = state.vt;
  const w = state.imgW * v.s, h = state.imgH * v.s;
  const margin = 40;
  v.tx = Math.min(cssW - margin, Math.max(margin - w, v.tx));
  v.ty = Math.min(cssH - margin, Math.max(margin - h, v.ty));
}

function ringRadiiPx() {
  const k = pxPerMm();
  if (!k) return [];
  const t = targetDef();
  const out = [];
  for (let n = 10; n >= t.minRing; n--) out.push({ n, r: (ringDiameter(t, n) / 2) * k });
  return out;
}

/** Disegna immagine e sovrapposizioni. `vt` mappa immagine->destinazione; `k` scala gli spessori. */
function render(c, vt, k, { mode, showRings, stats, loupe }) {
  const T = (p) => ({ x: p.x * vt.s + vt.tx, y: p.y * vt.s + vt.ty });
  c.save();
  c.fillStyle = '#000';
  c.fillRect(0, 0, c.canvas.width, c.canvas.height);
  c.drawImage(state.image, vt.tx, vt.ty, state.imgW * vt.s, state.imgH * vt.s);
  if (!state.target) { c.restore(); return; }
  const t = state.target;
  const C = T({ x: t.cx, y: t.cy });
  const R = t.r * vt.s;

  // anelli
  if (showRings) {
    c.lineWidth = 1 * k;
    for (const ring of ringRadiiPx()) {
      c.strokeStyle = 'rgba(57,135,229,0.55)';
      c.beginPath(); c.arc(C.x, C.y, ring.r * vt.s, 0, Math.PI * 2); c.stroke();
    }
  }
  // cerchio tracciato
  c.strokeStyle = mode === 'target' ? '#ffcc00' : 'rgba(255,204,0,0.6)';
  c.lineWidth = 2 * k;
  c.beginPath(); c.arc(C.x, C.y, R, 0, Math.PI * 2); c.stroke();
  // croce centrale
  c.strokeStyle = '#ffcc00'; c.lineWidth = 1.5 * k;
  const cr = 10 * k;
  c.beginPath(); c.moveTo(C.x - cr, C.y); c.lineTo(C.x + cr, C.y); c.moveTo(C.x, C.y - cr); c.lineTo(C.x, C.y + cr); c.stroke();
  if (mode === 'target') {
    c.fillStyle = '#ffcc00';
    for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      c.beginPath(); c.arc(C.x + Math.cos(a) * R, C.y + Math.sin(a) * R, 7 * k, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#000'; c.lineWidth = 1 * k; c.stroke();
    }
    c.beginPath(); c.arc(C.x, C.y, 7 * k, 0, Math.PI * 2); c.fill(); c.stroke();
  }

  // colpi
  const kmm = pxPerMm();
  const holeR = Math.max(5 * k, kmm ? (state.settings.caliber / 2) * kmm * vt.s : 6 * k);
  state.shots.forEach((p, i) => {
    const P = T(p);
    c.beginPath(); c.arc(P.x, P.y, holeR, 0, Math.PI * 2);
    c.fillStyle = i === state.selected ? 'rgba(255,204,0,0.5)' : 'rgba(217,89,38,0.45)';
    c.fill();
    c.lineWidth = 1.5 * k; c.strokeStyle = i === state.selected ? '#ffcc00' : '#fff'; c.stroke();
    c.fillStyle = '#fff'; c.font = `${11 * k}px sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.shadowColor = '#000'; c.shadowBlur = 3 * k;
    c.fillText(String(i + 1), P.x, P.y - holeR - 7 * k);
    c.shadowBlur = 0;
  });

  // statistiche sovrapposte
  if (stats && stats.n >= 2 && kmm) {
    const G = T({ x: t.cx + stats.center.x * kmm, y: t.cy + stats.center.y * kmm });
    // cerchio minimo
    c.setLineDash([4 * k, 4 * k]); c.strokeStyle = 'rgba(255,255,255,0.8)'; c.lineWidth = 1 * k;
    const M = T({ x: t.cx + stats.minCircle.x * kmm, y: t.cy + stats.minCircle.y * kmm });
    c.beginPath(); c.arc(M.x, M.y, stats.minCircle.r * kmm * vt.s, 0, Math.PI * 2); c.stroke();
    // raggio medio
    c.strokeStyle = 'rgba(57,135,229,0.9)';
    c.beginPath(); c.arc(G.x, G.y, stats.meanRadius * kmm * vt.s, 0, Math.PI * 2); c.stroke();
    // rosata
    const [a, b] = stats.extremeSpreadPair;
    const A = T(state.shots[a]), B = T(state.shots[b]);
    c.strokeStyle = 'rgba(217,89,38,0.9)'; c.lineWidth = 1.5 * k;
    c.beginPath(); c.moveTo(A.x, A.y); c.lineTo(B.x, B.y); c.stroke();
    c.setLineDash([]);
    // centro del gruppo
    c.strokeStyle = '#3987e5'; c.lineWidth = 2 * k;
    c.beginPath(); c.moveTo(G.x - 8 * k, G.y - 8 * k); c.lineTo(G.x + 8 * k, G.y + 8 * k);
    c.moveTo(G.x + 8 * k, G.y - 8 * k); c.lineTo(G.x - 8 * k, G.y + 8 * k); c.stroke();
  }

  // lente d'ingrandimento
  if (loupe) {
    const Z = 3, LR = 60 * k;
    const src = loupe.img;
    const lx = loupe.x, ly = loupe.y - 95 * k < LR ? loupe.y + 95 * k : loupe.y - 95 * k;
    c.save();
    c.beginPath(); c.arc(lx, ly, LR, 0, Math.PI * 2); c.clip();
    const sw = (LR * 2) / (vt.s * Z);
    c.drawImage(state.image, src.x - sw / 2, src.y - sw / 2, sw, sw, lx - LR, ly - LR, LR * 2, LR * 2);
    c.strokeStyle = 'rgba(255,204,0,0.9)'; c.lineWidth = 1 * k;
    c.beginPath(); c.moveTo(lx - LR, ly); c.lineTo(lx + LR, ly); c.moveTo(lx, ly - LR); c.lineTo(lx, ly + LR); c.stroke();
    if (loupe.r) { c.beginPath(); c.arc(lx, ly, loupe.r * Z, 0, Math.PI * 2); c.stroke(); }
    c.restore();
    c.strokeStyle = '#fff'; c.lineWidth = 2 * k;
    c.beginPath(); c.arc(lx, ly, LR, 0, Math.PI * 2); c.stroke();
  }
  c.restore();
}

let loupe = null;
function currentStats() {
  const sm = shotsMm();
  if (sm.length < 1) return null;
  return computeStats({ shotsMm: sm, target: targetDef(), caliberMm: state.settings.caliber, distanceM: state.settings.distance, clickMoa: state.settings.clickMoa });
}
function draw() {
  if (!state.image || $('#stage').hidden) return;
  if (!cssW) resizeCanvas();
  const mode = state.view === 'target' ? 'target' : 'shots';
  render(ctx, state.vt, 1, { mode, showRings: state.settings.showRings, stats: mode === 'shots' ? currentStats() : null, loupe });
  const ov = $('#stage-overlay');
  const zoom = Math.round((state.vt.s / state.vt.sFit) * 100);
  ov.innerHTML = `<span>${mode === 'target' ? 'Sistema il cerchio' : `${state.shots.length} colpi`}</span><span>zoom ${zoom}%</span>`;
  $('#shot-count').textContent = `${state.shots.length} ${state.shots.length === 1 ? 'colpo' : 'colpi'}`;
  $('#btn-delete-sel').disabled = state.selected < 0;
}

// ---------------------------------------------------------------------------
// Interazione (puntatore / tocco)
// ---------------------------------------------------------------------------
const pointers = new Map();
let gesture = null; // {type, start, moved, idx, pinch}
const HIT = 22;

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function hitShot(p) {
  let best = -1, bd = HIT;
  state.shots.forEach((s, i) => {
    const c = toCanvas(s);
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

canvas.addEventListener('pointerdown', (e) => {
  if (!state.image) return;
  canvas.setPointerCapture(e.pointerId);
  const p = canvasPos(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, vt0: { ...state.vt } };
    loupe = null; draw();
    return;
  }
  if (pointers.size > 2) return;
  const mode = state.view === 'target' ? 'target' : 'shots';
  gesture = { type: 'pan', start: p, last: p, moved: false };
  if (mode === 'target' && state.target) {
    const C = toCanvas({ x: state.target.cx, y: state.target.cy });
    const R = state.target.r * state.vt.s;
    const dC = Math.hypot(p.x - C.x, p.y - C.y);
    if (dC < HIT) gesture.type = 'center';
    else if (Math.abs(dC - R) < HIT) gesture.type = 'radius';
  } else if (mode === 'shots') {
    const idx = hitShot(p);
    if (idx >= 0) { gesture.type = 'shot'; gesture.idx = idx; gesture.orig = { ...state.shots[idx] }; }
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!gesture || !pointers.has(e.pointerId)) return;
  const p = canvasPos(e);
  pointers.set(e.pointerId, p);
  if (gesture.type === 'pinch') {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const v0 = gesture.vt0;
    const f = Math.min(v0.sFit * 16, Math.max(v0.sFit * 0.5, v0.s * (d / gesture.d0))) / v0.s;
    state.vt.s = v0.s * f;
    state.vt.tx = mid.x - (gesture.mid0.x - v0.tx) * f;
    state.vt.ty = mid.y - (gesture.mid0.y - v0.ty) * f;
    clampPan(); draw();
    return;
  }
  const dx = p.x - gesture.last.x, dy = p.y - gesture.last.y;
  if (Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) > 6) gesture.moved = true;
  gesture.last = p;
  const ip = toImage(p);
  if (gesture.type === 'pan') {
    state.vt.tx += dx; state.vt.ty += dy; clampPan();
  } else if (gesture.type === 'center') {
    state.target.cx = ip.x; state.target.cy = ip.y;
    loupe = { x: p.x, y: p.y, img: ip };
  } else if (gesture.type === 'radius') {
    state.target.r = Math.max(5, Math.hypot(ip.x - state.target.cx, ip.y - state.target.cy));
    loupe = { x: p.x, y: p.y, img: ip };
    updateScaleInfo();
  } else if (gesture.type === 'shot') {
    // trascinamento relativo: il colpo non "salta" sotto il dito
    const s = state.shots[gesture.idx];
    s.x += dx / state.vt.s; s.y += dy / state.vt.s;
    const kmm = pxPerMm();
    loupe = { x: p.x, y: p.y, img: s, r: Math.max(5, kmm ? (state.settings.caliber / 2) * kmm * state.vt.s : 6) };
  }
  draw();
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (!gesture) return;
  if (gesture.type === 'pinch') { if (pointers.size < 2) gesture = null; loupe = null; draw(); return; }
  const mode = state.view === 'target' ? 'target' : 'shots';
  if (!gesture.moved && e.type !== 'pointercancel') {
    if (mode === 'shots') {
      if (gesture.type === 'shot') {
        state.selected = state.selected === gesture.idx ? -1 : gesture.idx;
      } else if (gesture.type === 'pan') {
        state.shots.push(toImage(p));
        state.selected = -1;
      }
    }
  } else if (gesture.type === 'shot') {
    state.selected = gesture.idx;
  }
  gesture = null; loupe = null;
  draw();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => {
  if (!state.image) return;
  e.preventDefault();
  const p = canvasPos(e);
  zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
  draw();
}, { passive: false });
canvas.addEventListener('dblclick', (e) => {
  if (!state.image) return;
  const p = canvasPos(e);
  if (state.vt.s > state.vt.sFit * 1.05) fitView(); else zoomAt(3, p.x, p.y);
  draw();
});

// ---------------------------------------------------------------------------
// Colpi
// ---------------------------------------------------------------------------
$('#btn-to-shots').addEventListener('click', () => {
  if (!state.image) { toast('Prima scatta o carica una foto'); return; }
  showView('shots');
});
$('#btn-back-target').addEventListener('click', () => showView('target'));
$('#btn-to-results').addEventListener('click', () => showView('results'));
$('#btn-undo').addEventListener('click', () => { state.shots.pop(); state.selected = -1; draw(); });
$('#btn-delete-sel').addEventListener('click', () => {
  if (state.selected < 0) return;
  state.shots.splice(state.selected, 1); state.selected = -1; draw();
});
$('#btn-clear').addEventListener('click', () => {
  if (!state.shots.length || confirm('Cancellare tutti i colpi segnati?')) { state.shots = []; state.selected = -1; draw(); }
});
$('#btn-detect-holes').addEventListener('click', async () => {
  if (!state.target) return;
  const kmm = pxPerMm();
  if (!kmm) { toast('Imposta prima la calibrazione'); return; }
  toast('Cerco i fori…', 1200);
  await new Promise((r) => setTimeout(r, 30));
  const holes = detectHoles(state.image, state.target, (state.settings.caliber / 2) * kmm);
  const minSep = Math.max(3, state.settings.caliber * 0.6 * kmm);
  let added = 0;
  for (const h of holes) {
    if (state.shots.some((s) => Math.hypot(s.x - h.x, s.y - h.y) < minSep)) continue;
    state.shots.push(h); added++;
  }
  state.selected = -1;
  draw();
  toast(added ? `${added} fori trovati: controlla ed elimina gli errori` : 'Nessun foro riconosciuto: segnali a mano');
});

// ---------------------------------------------------------------------------
// Risultati
// ---------------------------------------------------------------------------
function moaStr(mm) {
  const d = state.settings.distance;
  return d ? `${fmt(mmToMoa(mm, d), 2)} MOA` : '';
}
function card(v, l, s = '') {
  return `<div class="card"><div class="v">${v}</div><div class="l">${l}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
}

function renderResults() {
  const st = currentStats();
  const empty = !st || st.n === 0 || !pxPerMm();
  $('#results-empty').hidden = !empty;
  $('#results-body').hidden = empty;
  if (empty) {
    $('#results-empty').innerHTML = `<p class="note">${!state.image ? 'Scatta o carica una foto del bersaglio.' : !pxPerMm() ? 'Calibrazione mancante: imposta il diametro del cerchio.' : 'Nessun colpo segnato.'}</p>`;
    return;
  }
  const s = state.settings;
  $('#res-preset').textContent = `${PRESETS[s.preset].name} · ${fmt(s.distance, 0)} m · cal. ${fmt(s.caliber)} mm`;
  $('#res-es').textContent = st.n >= 2 ? `${fmt(st.extremeSpread)} mm` : '–';
  $('#res-es-sub').textContent = st.n >= 2 ? `${moaStr(st.extremeSpread)} · bordo-bordo ${fmt(st.extremeSpreadEdge)} mm` : 'Servono almeno 2 colpi';
  $('#res-score').textContent = `${st.score} / ${st.maxScore}`;
  $('#res-score-sub').textContent = `${fmt(st.accuracy * 100, 0)}% · decimale ${fmt(st.scoreDecimal)} · media ${fmt(st.avgScore, 2)}`;

  const cards = [
    card(`${fmt(st.meanRadius)} mm`, 'Raggio medio', moaStr(st.meanRadius)),
    card(`${fmt(st.radialStdDev)} mm`, 'Dev. standard radiale', moaStr(st.radialStdDev)),
    card(`${fmt(st.minCircleDiameter)} mm`, 'Cerchio minimo (Ø)', moaStr(st.minCircleDiameter)),
    card(`${fmt(st.cep50)} mm`, 'CEP 50%', `90%: ${fmt(st.cep90)} mm`),
    card(`${fmt(st.bbox.w)} × ${fmt(st.bbox.h)} mm`, 'Larghezza × altezza'),
    card(`${fmt(st.offsetDist)} mm`, 'Scarto dal centro', moaStr(st.offsetDist)),
    card(`${st.inTarget} / ${st.n}`, 'Colpi nel bersaglio'),
    card(`#${st.worstIdx + 1}`, 'Colpo più lontano dal gruppo', `${fmt(st.scores[st.worstIdx].distFromGroup)} mm`),
  ];
  $('#res-cards').innerHTML = cards.join('');

  const sg = st.sight;
  const arrowH = sg.horizontal.dir === 'sinistra' ? '←' : '→';
  const arrowV = sg.vertical.dir === 'alto' ? '↑' : '↓';
  const clickLabel = $('#click-moa').selectedOptions[0]?.textContent || '';
  $('#res-sight').innerHTML = `
    <div class="card"><div class="v"><span class="arrow">${arrowH}</span> ${sg.horizontal.clicks} click a ${sg.horizontal.dir}</div>
      <div class="l">Orizzontale (deriva)</div><div class="s">gruppo ${fmt(sg.horizontal.mm)} mm a ${sg.horizontal.dir === 'sinistra' ? 'destra' : 'sinistra'} · ${fmt(sg.horizontal.moa, 2)} MOA</div></div>
    <div class="card"><div class="v"><span class="arrow">${arrowV}</span> ${sg.vertical.clicks} click in ${sg.vertical.dir}</div>
      <div class="l">Verticale (alzo)</div><div class="s">gruppo ${fmt(sg.vertical.mm)} mm in ${sg.vertical.dir === 'alto' ? 'basso' : 'alto'} · ${fmt(sg.vertical.moa, 2)} MOA</div></div>
    <p class="note small" style="grid-column: 1 / -1">Click da ${clickLabel}. Le frecce indicano in che direzione spostare il punto d'impatto.</p>`;

  const sm = shotsMm();
  $('#res-table tbody').innerHTML = st.scores.map((sc, i) => `
    <tr class="${i === st.worstIdx ? 'worst' : ''}"><td>${i + 1}</td><td>${fmt(sm[i].x)}</td><td>${fmt(-sm[i].y)}</td>
    <td>${fmt(sc.dist)} mm</td><td>${fmt(sc.distFromGroup)} mm</td><td>${sc.ring}</td><td>${fmt(sc.decimal)}</td></tr>`).join('');
}

// ---------------------------------------------------------------------------
// Esportazioni
// ---------------------------------------------------------------------------
function download(name, blobOrUrl) {
  const a = document.createElement('a');
  a.href = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function stamp() { return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'); }

function annotatedImage() {
  const st = currentStats();
  const W = state.imgW, H = state.imgH, pad = Math.round(W * 0.04);
  const footer = st ? Math.round(W * 0.09) : 0;
  const c = document.createElement('canvas');
  c.width = W; c.height = H + footer;
  const cx = c.getContext('2d');
  const k = Math.max(1, W / 700);
  render(cx, { s: 1, tx: 0, ty: 0, sFit: 1 }, k, { mode: 'shots', showRings: state.settings.showRings, stats: st, loupe: null });
  if (st) {
    cx.fillStyle = '#101418'; cx.fillRect(0, H, W, footer);
    cx.fillStyle = '#fff'; cx.textBaseline = 'middle'; cx.textAlign = 'left';
    cx.font = `bold ${Math.round(14 * k)}px sans-serif`;
    const s = state.settings;
    const line1 = `${st.n} colpi · ${PRESETS[s.preset].name} · ${fmt(s.distance, 0)} m · cal. ${fmt(s.caliber)} mm`;
    const line2 = st.n >= 2
      ? `Rosata ${fmt(st.extremeSpread)} mm (${moaStr(st.extremeSpread)}) · raggio medio ${fmt(st.meanRadius)} mm · punteggio ${st.score}/${st.maxScore} (${fmt(st.scoreDecimal)})`
      : `Punteggio ${st.score}/${st.maxScore}`;
    cx.fillText(line1, pad, H + footer * 0.33);
    cx.font = `${Math.round(13 * k)}px sans-serif`;
    cx.fillText(line2, pad, H + footer * 0.7);
  }
  return c;
}
$('#btn-export-png').addEventListener('click', () => {
  annotatedImage().toBlob((b) => download(`bersaglio-${stamp()}.png`, b), 'image/png');
});
$('#btn-export-csv').addEventListener('click', () => {
  const st = currentStats(); if (!st) return;
  const sm = shotsMm();
  const rows = [['n', 'x_mm', 'y_mm', 'dist_centro_mm', 'dist_gruppo_mm', 'anello', 'decimale']];
  st.scores.forEach((sc, i) => rows.push([i + 1, sm[i].x.toFixed(2), (-sm[i].y).toFixed(2), sc.dist.toFixed(2), sc.distFromGroup.toFixed(2), sc.ring, sc.decimal.toFixed(1)]));
  rows.push([]);
  rows.push(['rosata_mm', st.extremeSpread.toFixed(2)], ['raggio_medio_mm', st.meanRadius.toFixed(2)], ['dev_std_radiale_mm', st.radialStdDev.toFixed(2)],
    ['cerchio_minimo_mm', st.minCircleDiameter.toFixed(2)], ['cep50_mm', st.cep50.toFixed(2)], ['punteggio', st.score], ['punteggio_decimale', st.scoreDecimal],
    ['offset_x_mm', st.center.x.toFixed(2)], ['offset_y_mm', (-st.center.y).toFixed(2)], ['distanza_m', state.settings.distance], ['calibro_mm', state.settings.caliber]);
  download(`colpi-${stamp()}.csv`, new Blob([rows.map((r) => r.join(';')).join('\n')], { type: 'text/csv' }));
});
$('#btn-export-json').addEventListener('click', () => {
  const st = currentStats(); if (!st) return;
  download(`sessione-${stamp()}.json`, new Blob([JSON.stringify(sessionRecord(), null, 2)], { type: 'application/json' }));
});

// ---------------------------------------------------------------------------
// Storico (localStorage)
// ---------------------------------------------------------------------------
function loadSessions() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}
function saveSessions(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}
function thumbnail() {
  const t = state.target;
  const size = 120;
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const cx = c.getContext('2d');
  const r = t.r * 1.15;
  cx.drawImage(state.image, t.cx - r, t.cy - r, r * 2, r * 2, 0, 0, size, size);
  const k = size / (r * 2);
  cx.fillStyle = 'rgba(217,89,38,0.9)';
  for (const s of state.shots) {
    cx.beginPath(); cx.arc((s.x - (t.cx - r)) * k, (s.y - (t.cy - r)) * k, Math.max(2, (state.settings.caliber / 2) * pxPerMm() * k), 0, Math.PI * 2); cx.fill();
  }
  return c.toDataURL('image/jpeg', 0.6);
}
function sessionRecord() {
  const st = currentStats();
  const s = state.settings;
  return {
    id: `s${Date.now()}`,
    date: new Date().toISOString(),
    name: $('#session-name').value.trim(),
    notes: $('#session-notes').value.trim(),
    preset: s.preset, presetName: PRESETS[s.preset].name,
    target: targetDef(), distance: s.distance, caliber: s.caliber,
    n: st.n, extremeSpread: st.extremeSpread, meanRadius: st.meanRadius, radialStdDev: st.radialStdDev,
    minCircleDiameter: st.minCircleDiameter, cep50: st.cep50,
    score: st.score, scoreDecimal: st.scoreDecimal, avgScore: st.avgScore, accuracy: st.accuracy,
    offset: st.center,
    shotsMm: shotsMm().map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 })),
    thumb: thumbnail(),
  };
}
$('#btn-save').addEventListener('click', () => {
  const st = currentStats();
  if (!st) return;
  const list = loadSessions();
  list.push(sessionRecord());
  try {
    saveSessions(list);
    $('#save-status').textContent = `Salvata (${list.length} sessioni nello storico).`;
    toast('Sessione salvata');
  } catch {
    toast('Memoria piena: esporta ed elimina qualche sessione');
  }
});

function renderHistory() {
  const list = loadSessions().sort((a, b) => a.date.localeCompare(b.date));
  const wrap = $('#history-list');
  if (!list.length) {
    wrap.innerHTML = '<div class="panel"><p class="note">Nessuna sessione salvata. Analizza un bersaglio e premi "Salva nello storico".</p></div>';
  } else {
    wrap.innerHTML = list.slice().reverse().map((s) => `
      <div class="panel session" data-id="${s.id}">
        <img src="${s.thumb}" alt="">
        <div>
          <div class="title">${escapeHtml(s.name) || s.presetName}</div>
          <div class="meta">${new Date(s.date).toLocaleString('it-IT')} · ${s.presetName} · ${fmt(s.distance, 0)} m · ${s.n} colpi${s.notes ? ' · ' + escapeHtml(s.notes) : ''}</div>
          <div class="stats"><span>rosata <b>${fmt(s.extremeSpread)} mm</b></span><span>raggio medio <b>${fmt(s.meanRadius)} mm</b></span><span>punteggio <b>${s.score}/${s.n * 10}</b></span><span>media <b>${fmt(s.avgScore, 2)}</b></span></div>
        </div>
        <button class="btn sm danger" data-del="${s.id}" title="Elimina">🗑</button>
      </div>`).join('');
  }
  drawChart($('#chart-radius'), list, (s) => s.meanRadius, 'mm', getCss('--series-1'));
  drawChart($('#chart-score'), list, (s) => s.avgScore, '', getCss('--series-2'));
}
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function getCss(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

$('#history-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  if (!confirm('Eliminare questa sessione?')) return;
  saveSessions(loadSessions().filter((s) => s.id !== b.dataset.del));
  renderHistory();
});
$('#btn-history-export').addEventListener('click', () => {
  download(`storico-tiro-${stamp()}.json`, new Blob([JSON.stringify(loadSessions(), null, 2)], { type: 'application/json' }));
});
$('#history-import').addEventListener('change', async (e) => {
  const f = e.target.files?.[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const incoming = Array.isArray(data) ? data : [data];
    const list = loadSessions();
    const ids = new Set(list.map((s) => s.id));
    let added = 0;
    for (const s of incoming) if (s && s.id && s.shotsMm && !ids.has(s.id)) { list.push(s); added++; }
    saveSessions(list);
    toast(`${added} sessioni importate`);
    renderHistory();
  } catch { toast('File non valido'); }
  e.target.value = '';
});

// Grafico a linea singola (una serie, un asse) con tooltip al passaggio.
const chartState = new WeakMap();
function drawChart(cv, list, getter, unit, color) {
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  const W = rect.width || 300, H = 160;
  cv.width = W * dpr; cv.height = H * dpr;
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  const text2 = getCss('--text-2'), border = getCss('--border');
  const pts = list.map((s) => ({ v: getter(s), s })).filter((p) => Number.isFinite(p.v));
  const padL = 36, padR = 12, padT = 10, padB = 22;
  c.font = '11px sans-serif'; c.fillStyle = text2;
  if (pts.length < 1) { c.fillText('Nessun dato', padL, H / 2); chartState.set(cv, null); return; }
  const vmax = Math.max(...pts.map((p) => p.v)) * 1.15 || 1;
  const x = (i) => padL + (pts.length === 1 ? (W - padL - padR) / 2 : (i / (pts.length - 1)) * (W - padL - padR));
  const y = (v) => padT + (1 - v / vmax) * (H - padT - padB);
  // griglia leggera
  c.strokeStyle = border; c.lineWidth = 1;
  for (let g = 0; g <= 3; g++) {
    const v = (vmax * g) / 3;
    c.beginPath(); c.moveTo(padL, y(v)); c.lineTo(W - padR, y(v)); c.stroke();
    c.fillStyle = text2; c.textAlign = 'right'; c.textBaseline = 'middle';
    c.fillText(fmt(v, unit === 'mm' ? 0 : 1), padL - 6, y(v));
  }
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.fillText(new Date(pts[0].s.date).toLocaleDateString('it-IT'), padL, H - 6);
  c.textAlign = 'right';
  if (pts.length > 1) c.fillText(new Date(pts[pts.length - 1].s.date).toLocaleDateString('it-IT'), W - padR, H - 6);
  // linea
  c.strokeStyle = color; c.lineWidth = 2; c.lineJoin = 'round';
  c.beginPath();
  pts.forEach((p, i) => (i ? c.lineTo(x(i), y(p.v)) : c.moveTo(x(i), y(p.v))));
  c.stroke();
  const surface = getCss('--surface');
  pts.forEach((p, i) => {
    c.beginPath(); c.arc(x(i), y(p.v), 4, 0, Math.PI * 2);
    c.fillStyle = color; c.fill(); c.strokeStyle = surface; c.lineWidth = 2; c.stroke();
  });
  chartState.set(cv, { pts, x, y, unit, color });
  if (!cv.dataset.bound) {
    cv.dataset.bound = '1';
    const tip = $('#chart-tip');
    cv.addEventListener('pointermove', (e) => {
      const st = chartState.get(cv); if (!st) return;
      const r = cv.getBoundingClientRect();
      const mx = e.clientX - r.left;
      let bi = 0;
      st.pts.forEach((p, i) => { if (Math.abs(st.x(i) - mx) < Math.abs(st.x(bi) - mx)) bi = i; });
      const p = st.pts[bi];
      tip.innerHTML = `<b>${fmt(p.v, 2)} ${st.unit}</b><br>${escapeHtml(p.s.name) || p.s.presetName}<br>${new Date(p.s.date).toLocaleDateString('it-IT')} · ${p.s.n} colpi`;
      tip.hidden = false;
      tip.style.left = `${Math.min(window.innerWidth - 170, e.clientX + 12)}px`;
      tip.style.top = `${e.clientY - 56}px`;
    });
    cv.addEventListener('pointerleave', () => { $('#chart-tip').hidden = true; });
  }
}

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------
window.__tp = state; // per test e debug
loadSettings();
syncSettingsUI();
showView('capture');
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
