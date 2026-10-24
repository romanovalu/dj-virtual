// Genera temas sintéticos de prueba (WAV 44.1 kHz) en test-audio/: bombo en negras, hi-hats,
// bajo y acordes en una tonalidad conocida, con secciones cada 8 compases.
// Uso: node scripts/make-test-tracks.mjs
import { mkdirSync, writeFileSync } from 'node:fs';

const SR = 44100;

const NOTE = { C: 0, 'C#': 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

function makeTrack({ name, bpm, root, minor, bars, lead = 0.3 }) {
  const beat = 60 / bpm;
  const len = Math.ceil((lead + bars * 4 * beat + 2) * SR);
  const L = new Float32Array(len);
  let seed = 1234 + bpm;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const add = (t, fn, dur) => {
    const s = Math.floor(t * SR);
    const n = Math.floor(dur * SR);
    for (let i = 0; i < n && s + i < len; i++) L[s + i] += fn(i / SR);
  };
  const r = NOTE[root] + 36; // bajo en octava 2
  const third = minor ? 3 : 4;
  const chord = [r + 24, r + 24 + third, r + 24 + 7, r + 36];
  for (let bar = 0; bar < bars; bar++) {
    const section = Math.floor(bar / 8); // 0 intro, 1 groove, 2 full, 3 break, 4 full, 5 outro...
    const breakdown = section === 3;
    const outro = bar >= bars - 8;
    for (let b = 0; b < 4; b++) {
      const t = lead + (bar * 4 + b) * beat;
      if (!breakdown) {
        // Bombo: barrido 150 → 45 Hz
        add(t, (x) => Math.sin(2 * Math.PI * (45 * x + (105 / 30) * (1 - Math.exp(-30 * x)))) * Math.exp(-x * 9) * 0.9, 0.35);
      }
      if (section >= 1 && !outro) {
        // Hi-hat abierto en el contratiempo
        add(t + beat / 2, (x) => rnd() * Math.exp(-x * 40) * 0.18, 0.12);
        // Bajo en corcheas del contratiempo
        const f = hz(r + (bar % 4 === 3 && b === 3 ? 7 : 0));
        add(t + beat / 2, (x) => Math.tanh(3 * Math.sin(2 * Math.PI * f * x)) * Math.exp(-x * 6) * 0.35, beat / 2);
      }
      if ((section === 2 || section === 4) && (b === 1 || b === 3)) {
        // Clap
        add(t, (x) => rnd() * Math.exp(-x * 25) * 0.3, 0.15);
      }
    }
    if (section >= 2 || breakdown) {
      // Acorde sostenido (para la detección de tonalidad)
      const t = lead + bar * 4 * beat;
      for (const m of chord) {
        const f = hz(m);
        add(t, (x) => Math.sin(2 * Math.PI * f * x) * 0.06 * Math.min(1, x * 20) * Math.min(1, (4 * beat - x) * 20), 4 * beat);
      }
    }
    if (bar % 8 === 0) {
      // Crash al comienzo de cada sección (marca el downbeat)
      add(lead + bar * 4 * beat, (x) => rnd() * Math.exp(-x * 3) * 0.2, 1.5);
    }
  }
  let peak = 0;
  for (const v of L) peak = Math.max(peak, Math.abs(v));
  const g = 0.89 / peak;
  const data = Buffer.alloc(44 + len * 4);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + len * 4, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(SR, 24);
  data.writeUInt32LE(SR * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(len * 4, 40);
  for (let i = 0; i < len; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(L[i] * g * 32767)));
    data.writeInt16LE(v, 44 + i * 4);
    data.writeInt16LE(v, 46 + i * 4);
  }
  mkdirSync('test-audio', { recursive: true });
  writeFileSync(`test-audio/${name}.wav`, data);
  console.log(`test-audio/${name}.wav  ${bpm} BPM  ${root}${minor ? 'm' : ''}  ${bars} compases`);
}

makeTrack({ name: 'prueba-124-Am', bpm: 124, root: 'A', minor: true, bars: 48, lead: 0.3 });
makeTrack({ name: 'prueba-126-Em', bpm: 126, root: 'E', minor: true, bars: 48, lead: 0.75 });
makeTrack({ name: 'prueba-128-C', bpm: 128, root: 'C', minor: false, bars: 48, lead: 0.1 });
