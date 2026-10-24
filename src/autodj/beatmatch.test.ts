// Simula una mezcla con beatmatching: dos DeckCore (124 y 128 BPM), el entrante con keylock al
// tempo del saliente y el mismo lazo de corrección de fase que usa el Auto-DJ. Mide la diferencia
// real entre los golpes a la salida. Uso: node src/autodj/beatmatch.test.ts
import { DeckCore } from '../audio/deck-core.ts';
import { phaseError, bendForPhaseError } from './plan.ts';

const sr = 48000;
const BLOCK = 128;

function clickTrack(bpm: number, lead: number, secs: number): Float32Array {
  const x = new Float32Array(Math.round(secs * sr));
  const T = 60 / bpm;
  for (let t = lead; t < secs - 0.1; t += T) {
    const s = Math.round(t * sr);
    for (let k = 0; k < 400; k++) x[s + k] += Math.sin(2 * Math.PI * (45 * (k / sr) + 3.5 * (1 - Math.exp((-30 * k) / sr)))) * Math.exp((-9 * k) / sr);
  }
  return x;
}

function onsets(x: Float32Array): number[] {
  const out: number[] = [];
  let last = -1;
  for (let i = 1; i < x.length; i++) {
    if (Math.abs(x[i]) > 0.25 && i - last > sr * 0.3) {
      out.push(i / sr);
      last = i;
    }
  }
  return out;
}

function run(outTempo: number, correct: boolean): { mean: number; sd: number; max: number; n: number } {
  const bpmOut = 124;
  const bpmIn = 128;
  const outTrack = clickTrack(bpmOut, 0.3, 80);
  const inTrack = clickTrack(bpmIn, 0.1, 80);
  const out = new DeckCore(sr);
  const inc = new DeckCore(sr);
  out.load(outTrack, outTrack);
  inc.load(inTrack, inTrack);
  out.setTempo(outTempo);
  const tempoIn = (bpmOut * outTempo) / bpmIn;
  inc.setTempo(tempoIn);
  // El saliente arranca en el beat 8; el entrante en su beat 0, alineados.
  out.seek((0.3 + (8 * 60) / bpmOut) * sr);
  inc.seek(0.1 * sr);
  out.play();
  inc.play();
  const secs = 30;
  const nBlocks = Math.floor((secs * sr) / BLOCK);
  const oO = new Float32Array(nBlocks * BLOCK);
  const oI = new Float32Array(nBlocks * BLOCK);
  const tmpR = new Float32Array(BLOCK);
  const beatOut = (p: number) => ((p / sr - 0.3) * bpmOut) / 60;
  const beatIn = (p: number) => ((p / sr - 0.1) * bpmIn) / 60;
  for (let b = 0; b < nBlocks; b++) {
    // El Auto-DJ corrige cada ~40 ms con las posiciones reportadas
    if (correct && b % 15 === 0) {
      const err = phaseError(beatOut(out.position), beatIn(inc.position), 1);
      inc.bend = 1 + bendForPhaseError(err, 60 / (bpmIn * tempoIn));
    }
    out.render(oO.subarray(b * BLOCK, (b + 1) * BLOCK), tmpR, BLOCK, b * BLOCK);
    inc.render(oI.subarray(b * BLOCK, (b + 1) * BLOCK), tmpR, BLOCK, b * BLOCK);
  }
  const A = onsets(oO);
  const B = onsets(oI);
  const d: number[] = [];
  for (const t of B) {
    let best = Infinity;
    for (const a of A) if (Math.abs(a - t) < Math.abs(best)) best = a - t;
    if (Math.abs(best) < 0.2) d.push(-best * 1000);
  }
  const mean = d.reduce((s, v) => s + v, 0) / d.length;
  const sd = Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length);
  return { mean, sd, max: Math.max(...d.map(Math.abs)), n: d.length };
}

let fail = false;
for (const outTempo of [1, 0.99, 1.012]) {
  for (const correct of [false, true]) {
    const r = run(outTempo, correct);
    const f = (x: number) => x.toFixed(2);
    console.log(`saliente ×${outTempo} ${correct ? 'con' : 'sin'} corrección: golpes ${r.n} · media ${f(r.mean)} ms · desvío ${f(r.sd)} · máx ${f(r.max)}`);
    if (correct && (Math.abs(r.mean) > 3 || r.max > 8)) fail = true;
  }
}
if (fail) {
  console.log('FALLÓ: la alineación con corrección supera 3 ms de media o 8 ms de máximo');
  process.exitCode = 1;
}
