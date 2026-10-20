import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, ringDiameter, outerDiameter, extremeSpread, meanRadius, minEnclosingCircle,
  scoreShot, computeStats, mmToMoa, sightCorrection, cep,
} from '../js/stats.js';

test('diametri ISSF', () => {
  assert.equal(outerDiameter(PRESETS.air_rifle), 45.5);
  assert.equal(outerDiameter(PRESETS.air_pistol), 155.5);
  assert.equal(ringDiameter(PRESETS.rifle_50, 10), 10.4);
  assert.ok(Math.abs(outerDiameter(PRESETS.rifle_50) - 154.4) < 1e-9);
  assert.equal(outerDiameter(PRESETS.rapid_25), 500);
});

test('rosata e raggio medio', () => {
  const shots = [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 0, y: 4 }];
  const es = extremeSpread(shots);
  assert.equal(es.value, 5);
  assert.deepEqual([es.a, es.b], [0, 1]);
  assert.ok(Math.abs(meanRadius([{ x: -1, y: 0 }, { x: 1, y: 0 }], { x: 0, y: 0 }) - 1) < 1e-9);
});

test('cerchio minimo', () => {
  const c = minEnclosingCircle([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0.5 }]);
  assert.ok(Math.abs(c.r - 1) < 1e-6);
  assert.ok(Math.abs(c.x - 1) < 1e-6);
  const tri = minEnclosingCircle([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 3 }]);
  for (const p of [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 3 }]) {
    assert.ok(Math.hypot(p.x - tri.x, p.y - tri.y) <= tri.r + 1e-6);
  }
});

test('punteggio con regola del bordo', () => {
  const t = PRESETS.air_pistol; // anello 10 Ø 11,5 → raggio 5,75; passo 8
  assert.equal(scoreShot(0, t, 4.5).ring, 10);
  assert.equal(scoreShot(5.75 + 2.25, t, 4.5).ring, 10); // tocca il 10 con il bordo
  assert.equal(scoreShot(5.75 + 2.25 + 0.01, t, 4.5).ring, 9);
  assert.equal(scoreShot(5.75 + 8 + 2.25 + 0.01, t, 4.5).ring, 8);
  assert.equal(scoreShot(200, t, 4.5).ring, 0);
  assert.equal(scoreShot(0, t, 4.5).decimal, 10.9);
  // bersaglio con anelli minimi (celere: solo 5-10)
  assert.equal(scoreShot(260, PRESETS.rapid_25, 5.6).ring, 0);
  assert.equal(scoreShot(240, PRESETS.rapid_25, 5.6).ring, 5);
});

test('MOA e correzione mire', () => {
  assert.ok(Math.abs(mmToMoa(29.0888, 100) - 1) < 1e-6);
  const s = sightCorrection({ x: 10, y: -5 }, 25, 0.25); // gruppo a destra e in alto
  assert.equal(s.horizontal.dir, 'sinistra');
  assert.equal(s.vertical.dir, 'basso');
  assert.equal(s.horizontal.clicks, Math.round(mmToMoa(10, 25) / 0.25));
});

test('statistiche complete', () => {
  const shotsMm = [{ x: 1, y: 1 }, { x: -1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: -1 }, { x: 0, y: 0 }];
  const st = computeStats({ shotsMm, target: PRESETS.air_rifle, caliberMm: 4.5, distanceM: 10, clickMoa: 0.25 });
  assert.equal(st.n, 5);
  assert.ok(Math.abs(st.center.x) < 1e-9 && Math.abs(st.center.y) < 1e-9);
  assert.ok(Math.abs(st.extremeSpread - Math.sqrt(8)) < 1e-9);
  assert.ok(Math.abs(st.minCircleDiameter - 2 * Math.SQRT2) < 1e-6);
  assert.equal(st.maxScore, 50);
  assert.equal(st.score, 50); // tutti dentro il 10 grazie al bordo del foro
  assert.equal(st.worstIdx, 0);
  assert.equal(cep(shotsMm, st.center, 0.5), Math.SQRT2);
});
