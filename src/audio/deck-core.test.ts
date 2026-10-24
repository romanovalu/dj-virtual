// Mide el error de la posición reportada vs. el audio real (tren de clicks).
// Uso: node src/audio/deck-core.test.ts [--sweep]
import { DeckCore } from './deck-core.ts';

const sr = 44100;
const N = sr * 40;
const L = new Float32Array(N);
const period = Math.round(sr * 0.5);
for (let c = period; c < N - 1000; c += period) {
  for (let k = 0; k < 220; k++) L[c + k] = Math.sin(k * 0.6) * Math.exp(-k / 60);
}

function measure(tempo: number): { mean: number; sd: number; max: number; n: number } {
  const core = new DeckCore(sr);
  core.load(L, L);
  core.seek(sr * 2.1);
  core.setTempo(tempo);
  core.play();
  const oL = new Float32Array(128);
  const oR = new Float32Array(128);
  let quiet = 10000;
  const errs: number[] = [];
  for (let b = 0; b < (sr * 20) / 128; b++) {
    const ph0 = core.position;
    core.render(oL, oR, 128, b * 128);
    for (let i = 0; i < 128; i++) {
      const a = Math.abs(oL[i]);
      if (a > 0.3 && quiet > 4000) {
        const ph = ph0 + i * core.rate;
        errs.push(((ph - Math.round(ph / period) * period) / sr) * 1000);
      }
      quiet = a > 0.05 ? 0 : quiet + 1;
    }
  }
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  const sd = Math.sqrt(errs.reduce((a, b) => a + (b - mean) ** 2, 0) / errs.length);
  return { mean, sd, max: Math.max(...errs.map(Math.abs)), n: errs.length };
}

for (const tempo of [0.9, 0.94, 0.97, 0.99, 1.0, 1.01, 1.03, 1.06, 1.1]) {
  const r = measure(tempo);
  const f = (x: number) => x.toFixed(2);
  console.log(`tempo ${f(tempo)}  clicks ${r.n}  error medio ${f(r.mean)} ms  desvío ${f(r.sd)}  máx ${f(r.max)}`);
  if (Math.abs(r.mean) > 2 || r.n < 25) process.exitCode = 1;
}

// Beat roll con slip: mientras suena el roll, el playhead sigue avanzando como si nada.
{
  const core = new DeckCore(sr);
  core.load(L, L);
  core.seek(sr * 5);
  core.play();
  const oL = new Float32Array(128);
  const oR = new Float32Array(128);
  core.startRoll(sr * 5, sr * 0.125);
  for (let b = 0; b < (sr * 2) / 128; b++) core.render(oL, oR, 128, b * 128);
  core.stopRoll();
  const slip = core.position / sr;
  console.log(`roll con slip: después de 2 s de roll el playhead está en ${slip.toFixed(3)} s (esperado ≈ 7.000)`);
  if (Math.abs(slip - 7) > 0.01) process.exitCode = 1;
  core.startSpin();
  for (let b = 0; b < (sr * 1.2) / 128; b++) core.render(oL, oR, 128, b * 128);
  console.log(`backspin: quedó en pausa=${!core.playing} en ${(core.position / sr).toFixed(2)} s (retrocedió)`);
  if (core.playing || core.position / sr >= 7) process.exitCode = 1;
}
