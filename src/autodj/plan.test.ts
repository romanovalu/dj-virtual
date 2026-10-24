// Tests del planificador de mezclas y del orden del set. Uso: node src/autodj/plan.test.ts
import assert from 'node:assert/strict';
import { phaseError, planMix } from './plan.ts';
import { orderSet, transitionCost } from './ordering.ts';
import { fitGrid } from '../analysis/analysis-core.ts';
import { beatIndex, type Analysis } from '../library.ts';

function an(bpm: number, firstBeat: number, downbeat: number, end: number, camelot = '8A', energy = 5): Analysis {
  return { bpm, firstBeat, downbeat, gridFit: 1, key: 'A', scale: 'minor', camelot, keyStrength: 1, energy, loudnessDb: -10, danceability: 1.2, audioStart: firstBeat, audioEnd: end, duration: end + 1, version: 2 };
}

let ok = 0;
function test(name: string, fn: () => void): void {
  fn();
  ok++;
  console.log(`✔ ${name}`);
}

test('la mezcla arranca en una frase de 16 compases y termina antes del final', () => {
  const out = an(124, 0.3, 0, 0.3 + 48 * 4 * (60 / 124));
  const inc = an(126, 0.75, 0, 200);
  const p = planMix(out, 1, 10, inc, 16);
  const bar = (beatIndex(out, p.outStart) - out.downbeat) / 4;
  assert.equal(p.bars, 16);
  assert.ok(Math.abs(bar - Math.round(bar)) < 1e-6, 'empieza en un compás');
  assert.equal(Math.round(bar) % 16, 0, 'empieza en frase de 16');
  assert.ok(p.outStart + 16 * 4 * (60 / 124) <= out.audioEnd + 60 / 124);
  assert.ok(Math.abs(p.tempoIn - 124 / 126) < 1e-9);
  assert.ok(p.beatmatch);
});

test('si no entran 32 compases, usa 16', () => {
  const out = an(128, 0, 0, 40 * 4 * (60 / 128));
  const p = planMix(out, 1, 0, an(128, 0, 0, 100), 32);
  assert.equal(p.bars, 32);
  const p2 = planMix(out, 1, 20, an(128, 0, 0, 100), 32);
  assert.ok(p2.bars <= 16);
});

test('half time: 70 BPM contra 140 se beatmatchea con multiplicador 2', () => {
  const p = planMix(an(140, 0, 0, 300), 1, 0, an(70, 0, 0, 300), 16);
  assert.equal(p.mult, 2);
  assert.ok(Math.abs(p.tempoIn - 1) < 1e-9);
});

test('BPM muy distintos → sin beatmatching', () => {
  const p = planMix(an(100, 0, 0, 300), 1, 0, an(128, 0, 0, 300), 16);
  assert.equal(p.beatmatch, false);
  assert.equal(p.tempoIn, 1);
});

test('error de fase', () => {
  assert.ok(Math.abs(phaseError(10.0, 4.1, 1) - 0.1) < 1e-9);
  assert.ok(Math.abs(phaseError(10.95, 4.0, 1) - 0.05) < 1e-9);
  assert.ok(Math.abs(phaseError(10.0, 2.05, 2) - 0.1) < 1e-9);
});

test('fitGrid recupera BPM y fase con beats ruidosos', () => {
  const T = 60 / 126;
  const ticks: number[] = [];
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let i = 0; i < 300; i++) if (i % 17 !== 5) ticks.push(0.42 + i * T + rnd() * 0.012);
  const g = fitGrid(ticks, 125.7);
  assert.equal(g.bpm, 126);
  assert.ok(Math.abs(g.firstBeat - 0.42) < 0.005, `fase ${g.firstBeat}`);
  assert.ok(g.fit > 0.9);
});

test('el orden del set agrupa BPM y tonalidades compatibles', () => {
  const items = [
    { id: 'a', bpm: 128, camelot: '8A', energy: 7 },
    { id: 'b', bpm: 122, camelot: '8A', energy: 4 },
    { id: 'c', bpm: 124, camelot: '9A', energy: 5 },
    { id: 'd', bpm: 126, camelot: '9A', energy: 6 },
    { id: 'e', bpm: 174, camelot: '3B', energy: 9 },
  ];
  const o = orderSet(items).map((x) => x.id);
  assert.equal(o[0], 'b', 'arranca con la menor energía');
  assert.deepEqual(o.slice(0, 4), ['b', 'c', 'd', 'a']);
  assert.ok(transitionCost(items[1], items[2]) < transitionCost(items[1], items[4]));
});

console.log(`\n${ok} tests OK`);
