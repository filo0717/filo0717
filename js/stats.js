// Statistiche di raggruppamento e punteggio.
// Modulo puro: nessuna dipendenza dal DOM, usabile anche in Node per i test.

export const MM_PER_MOA_PER_M = 0.290888; // 1 MOA = 2,90888 cm a 100 m

export const PRESETS = {
  air_rifle: { name: 'Carabina 10 m (ISSF)', d10: 0.5, step: 2.5, black: 30.5, caliber: 4.5, distance: 10, minRing: 1 },
  air_pistol: { name: 'Pistola 10 m (ISSF)', d10: 11.5, step: 8, black: 59.5, caliber: 4.5, distance: 10, minRing: 1 },
  rifle_50: { name: 'Carabina 50 m (ISSF)', d10: 10.4, step: 8, black: 112.4, caliber: 5.6, distance: 50, minRing: 1 },
  pistol_25: { name: 'Pistola 25/50 m precisione (ISSF)', d10: 50, step: 25, black: 200, caliber: 5.6, distance: 25, minRing: 1 },
  rapid_25: { name: 'Pistola 25 m celere (ISSF)', d10: 100, step: 40, black: 500, caliber: 5.6, distance: 25, minRing: 5 },
  custom: { name: 'Personalizzato', d10: 10, step: 10, black: 100, caliber: 9, distance: 25, minRing: 1 },
};

/** Diametro (mm) dell'anello n (1..10) per un bersaglio dato. */
export function ringDiameter(target, n) {
  return target.d10 + 2 * target.step * (10 - n);
}

/** Diametro esterno (anello più basso valido). */
export function outerDiameter(target) {
  return ringDiameter(target, target.minRing ?? 1);
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function groupCenter(shots) {
  if (!shots.length) return null;
  let sx = 0, sy = 0;
  for (const s of shots) { sx += s.x; sy += s.y; }
  return { x: sx / shots.length, y: sy / shots.length };
}

/** Rosata: distanza massima centro-centro fra due colpi. Ritorna {value, a, b}. */
export function extremeSpread(shots) {
  if (shots.length < 2) return { value: 0, a: 0, b: 0 };
  let best = { value: 0, a: 0, b: 1 };
  for (let i = 0; i < shots.length; i++) {
    for (let j = i + 1; j < shots.length; j++) {
      const d = dist(shots[i], shots[j]);
      if (d > best.value) best = { value: d, a: i, b: j };
    }
  }
  return best;
}

export function meanRadius(shots, center) {
  if (!shots.length) return 0;
  return shots.reduce((acc, s) => acc + dist(s, center), 0) / shots.length;
}

/** Deviazione standard radiale (RSD): sqrt(mean(d^2)) dal centro del gruppo. */
export function radialStdDev(shots, center) {
  if (!shots.length) return 0;
  return Math.sqrt(shots.reduce((acc, s) => acc + dist(s, center) ** 2, 0) / shots.length);
}

export function boundingBox(shots) {
  if (!shots.length) return { w: 0, h: 0 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of shots) {
    minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
    minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
  }
  return { w: maxX - minX, h: maxY - minY, minX, maxX, minY, maxY };
}

/** Raggio che contiene la frazione p dei colpi (CEP) attorno al centro del gruppo. */
export function cep(shots, center, p = 0.5) {
  if (!shots.length) return 0;
  const d = shots.map((s) => dist(s, center)).sort((a, b) => a - b);
  const idx = Math.min(d.length - 1, Math.ceil(p * d.length) - 1);
  return d[Math.max(0, idx)];
}

/** Cerchio minimo che racchiude tutti i punti (algoritmo di Welzl, versione iterativa). */
export function minEnclosingCircle(points) {
  if (!points.length) return { x: 0, y: 0, r: 0 };
  const pts = points.slice();
  // mescola in modo deterministico per evitare casi patologici
  for (let i = pts.length - 1; i > 0; i--) {
    const j = (i * 7919 + 13) % (i + 1);
    [pts[i], pts[j]] = [pts[j], pts[i]];
  }
  const inside = (c, p) => dist(c, p) <= c.r + 1e-7;
  const from2 = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, r: dist(a, b) / 2 });
  const from3 = (a, b, c) => {
    const ax = a.x, ay = a.y, bx = b.x, by = b.y, cx = c.x, cy = c.y;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-9) {
      // collineari: prendi la coppia più lontana
      const cands = [from2(a, b), from2(a, c), from2(b, c)];
      return cands.reduce((m, k) => (k.r > m.r ? k : m));
    }
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    const c0 = { x: ux, y: uy };
    return { ...c0, r: dist(c0, a) };
  };
  let c = { x: pts[0].x, y: pts[0].y, r: 0 };
  for (let i = 1; i < pts.length; i++) {
    if (inside(c, pts[i])) continue;
    c = { x: pts[i].x, y: pts[i].y, r: 0 };
    for (let j = 0; j < i; j++) {
      if (inside(c, pts[j])) continue;
      c = from2(pts[i], pts[j]);
      for (let k = 0; k < j; k++) {
        if (inside(c, pts[k])) continue;
        c = from3(pts[i], pts[j], pts[k]);
      }
    }
  }
  return c;
}

export function mmToMoa(mm, distanceM) {
  if (!distanceM) return 0;
  return mm / (distanceM * MM_PER_MOA_PER_M);
}

export function mmToMil(mm, distanceM) {
  if (!distanceM) return 0;
  return mm / distanceM; // 1 mrad = 1 mm per metro
}

/**
 * Punteggio di un colpo.
 * @param distMm distanza centro colpo - centro bersaglio
 * @param target {d10, step, minRing}
 * @param caliberMm diametro del proiettile (regola "tocca l'anello": si usa il bordo del foro)
 * @returns {ring, decimal}
 */
export function scoreShot(distMm, target, caliberMm = 0, bestEdge = true) {
  const edge = Math.max(0, distMm - (bestEdge ? caliberMm / 2 : 0));
  const r10 = target.d10 / 2;
  const minRing = target.minRing ?? 1;
  for (let n = 10; n >= minRing; n--) {
    const Rn = r10 + (10 - n) * target.step; // raggio esterno dell'anello n
    if (edge <= Rn + 1e-9) {
      const Rinner = n === 10 ? 0 : r10 + (10 - n - 1) * target.step;
      const frac = (Rn - edge) / (Rn - Rinner); // 0 = sul bordo esterno, 1 = sul bordo interno
      const tenth = Math.min(9, Math.floor(frac * 10));
      return { ring: n, decimal: n + tenth / 10 };
    }
  }
  return { ring: 0, decimal: 0 };
}

/**
 * Suggerimento di correzione delle mire.
 * offset = centro del gruppo rispetto al centro del bersaglio, in mm (x: destra positiva, y: giù positiva).
 */
export function sightCorrection(offsetMm, distanceM, clickMoa) {
  const moaX = mmToMoa(Math.abs(offsetMm.x), distanceM);
  const moaY = mmToMoa(Math.abs(offsetMm.y), distanceM);
  const clicksX = clickMoa ? Math.round(moaX / clickMoa) : 0;
  const clicksY = clickMoa ? Math.round(moaY / clickMoa) : 0;
  return {
    horizontal: { dir: offsetMm.x > 0 ? 'sinistra' : 'destra', mm: Math.abs(offsetMm.x), moa: moaX, clicks: clicksX },
    vertical: { dir: offsetMm.y > 0 ? 'alto' : 'basso', mm: Math.abs(offsetMm.y), moa: moaY, clicks: clicksY },
  };
}

/**
 * Calcola tutte le statistiche.
 * @param shotsMm colpi in mm, relativi al centro del bersaglio (x destra, y giù)
 */
export function computeStats({ shotsMm, target, caliberMm = 0, distanceM = 0, clickMoa = 0.25 }) {
  const n = shotsMm.length;
  const origin = { x: 0, y: 0 };
  if (!n) return { n: 0 };
  const center = groupCenter(shotsMm);
  const es = extremeSpread(shotsMm);
  const mec = minEnclosingCircle(shotsMm);
  const bb = boundingBox(shotsMm);
  const scores = shotsMm.map((s) => {
    const d = dist(s, origin);
    const sc = scoreShot(d, target, caliberMm);
    return { ...sc, dist: d, distFromGroup: dist(s, center) };
  });
  const total = scores.reduce((a, s) => a + s.ring, 0);
  const totalDecimal = scores.reduce((a, s) => a + s.decimal, 0);
  const worstIdx = scores.reduce((w, s, i) => (s.distFromGroup > scores[w].distFromGroup ? i : w), 0);
  const maxRing = 10;
  return {
    n,
    center,
    offset: center, // il centro del bersaglio è l'origine
    offsetMoa: { x: mmToMoa(center.x, distanceM), y: mmToMoa(center.y, distanceM) },
    offsetDist: dist(center, origin),
    extremeSpread: es.value,
    extremeSpreadEdge: es.value + caliberMm,
    extremeSpreadPair: [es.a, es.b],
    extremeSpreadMoa: mmToMoa(es.value, distanceM),
    meanRadius: meanRadius(shotsMm, center),
    meanRadiusMoa: mmToMoa(meanRadius(shotsMm, center), distanceM),
    radialStdDev: radialStdDev(shotsMm, center),
    cep50: cep(shotsMm, center, 0.5),
    cep90: cep(shotsMm, center, 0.9),
    minCircle: mec,
    minCircleDiameter: mec.r * 2,
    bbox: bb,
    scores,
    score: total,
    scoreDecimal: Math.round(totalDecimal * 10) / 10,
    maxScore: maxRing * n,
    accuracy: total / (maxRing * n),
    avgScore: total / n,
    worstIdx,
    inTarget: scores.filter((s) => s.ring > 0).length,
    sight: sightCorrection(center, distanceM, clickMoa),
  };
}

export function fmt(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  return Number(v).toFixed(digits).replace('.', ',');
}
