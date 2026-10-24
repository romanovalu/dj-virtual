// DSP puro del análisis (sin essentia): forma de onda por bandas, ajuste de beatgrid, downbeat
// y energía. Se usa en el worker y en tests de Node.

export const WF_RATE = 120; // bins por segundo

export interface WaveformData {
  rate: number;
  amp: Float32Array;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
}

/** Forma de onda en 3 bandas (filtros de un polo): graves < ~200 Hz, agudos > ~2.5 kHz. */
export function computeWaveform(x: Float32Array, sr: number): WaveformData {
  const hop = sr / WF_RATE;
  const n = Math.ceil(x.length / hop);
  const amp = new Float32Array(n);
  const low = new Float32Array(n);
  const mid = new Float32Array(n);
  const high = new Float32Array(n);
  const aL = 1 - Math.exp((-2 * Math.PI * 200) / sr);
  const aH = 1 - Math.exp((-2 * Math.PI * 2500) / sr);
  let lp1 = 0;
  let lp2 = 0;
  let bin = 0;
  let next = hop;
  let pk = 0;
  let sl = 0;
  let sm = 0;
  let sh = 0;
  let cnt = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    lp1 += aL * (v - lp1);
    lp2 += aH * (v - lp2);
    const lo = lp1;
    const hi = v - lp2;
    const mi = lp2 - lp1;
    const a = Math.abs(v);
    if (a > pk) pk = a;
    sl += lo * lo;
    sm += mi * mi;
    sh += hi * hi;
    cnt++;
    if (i + 1 >= next || i === x.length - 1) {
      amp[bin] = pk;
      low[bin] = Math.sqrt(sl / cnt);
      mid[bin] = Math.sqrt(sm / cnt);
      high[bin] = Math.sqrt(sh / cnt);
      bin++;
      next += hop;
      pk = sl = sm = sh = 0;
      cnt = 0;
    }
  }
  const norm = (arr: Float32Array) => {
    let m = 1e-9;
    for (const v of arr) if (v > m) m = v;
    for (let i = 0; i < arr.length; i++) arr[i] /= m;
  };
  norm(amp);
  // Las bandas se normalizan juntas para conservar el balance tonal.
  let mb = 1e-9;
  for (let i = 0; i < n; i++) mb = Math.max(mb, low[i], mid[i] * 1.6, high[i] * 3);
  for (let i = 0; i < n; i++) {
    low[i] /= mb;
    mid[i] = (mid[i] * 1.6) / mb;
    high[i] = (high[i] * 3) / mb;
  }
  return { rate: WF_RATE, amp: amp.subarray(0, bin), low: low.subarray(0, bin), mid: mid.subarray(0, bin), high: high.subarray(0, bin) };
}

/** Primer/último instante en que la señal supera el umbral (en dB respecto del pico). */
export function audioBounds(wf: WaveformData, thresholdDb = -36): { start: number; end: number } {
  const th = Math.pow(10, thresholdDb / 20);
  let s = 0;
  while (s < wf.amp.length && wf.amp[s] < th) s++;
  let e = wf.amp.length - 1;
  while (e > s && wf.amp[e] < th) e--;
  return { start: s / wf.rate, end: (e + 1) / wf.rate };
}

/** Lleva el BPM al rango típico de pista (75..180) duplicando o dividiendo. */
export function normalizeBpm(bpm: number): number {
  if (!(bpm > 0)) return 120;
  while (bpm < 75) bpm *= 2;
  while (bpm >= 180) bpm /= 2;
  return bpm;
}

export interface Grid {
  bpm: number;
  firstBeat: number;
  fit: number;
}

function circularPhase(ticks: number[], T: number): number {
  let sx = 0;
  let sy = 0;
  for (const t of ticks) {
    const a = (2 * Math.PI * t) / T;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  let ph = (Math.atan2(sy, sx) / (2 * Math.PI)) * T;
  if (ph < 0) ph += T;
  return ph;
}

/**
 * Ajusta una grilla de tempo constante a los beats detectados:
 * fase por media circular → regresión lineal sobre los beats que caen cerca → redondeo a BPM
 * entero si está a menos de 0.05.
 */
export function fitGrid(ticks: number[], bpmEstimate: number): Grid {
  const bpm0 = normalizeBpm(bpmEstimate);
  if (ticks.length < 8) return { bpm: Math.round(bpm0 * 100) / 100, firstBeat: 0, fit: 0 };
  let T = 60 / bpm0;
  let phase = circularPhase(ticks, T);
  for (let iter = 0; iter < 3; iter++) {
    let n = 0;
    let sk = 0;
    let st = 0;
    let skk = 0;
    let skt = 0;
    for (const t of ticks) {
      const k = Math.round((t - phase) / T);
      if (Math.abs(t - (phase + k * T)) > 0.2 * T) continue;
      n++;
      sk += k;
      st += t;
      skk += k * k;
      skt += k * t;
    }
    if (n < 8) break;
    const den = n * skk - sk * sk;
    if (Math.abs(den) < 1e-9) break;
    const b = (n * skt - sk * st) / den;
    const a = (st - b * sk) / n;
    if (!(b > 0)) break;
    T = b;
    phase = ((a % T) + T) % T;
  }
  let bpm = 60 / T;
  if (Math.abs(bpm - Math.round(bpm)) < 0.05) {
    bpm = Math.round(bpm);
    T = 60 / bpm;
    phase = circularPhase(ticks, T);
  } else {
    bpm = Math.round(bpm * 100) / 100;
    T = 60 / bpm;
    phase = circularPhase(ticks, T);
  }
  let hits = 0;
  for (const t of ticks) {
    const k = Math.round((t - phase) / T);
    if (Math.abs(t - (phase + k * T)) < 0.07 * T) hits++;
  }
  return { bpm, firstBeat: phase, fit: hits / ticks.length };
}

/**
 * Afina la fase de la grilla con resolución de 1 ms: los beats de essentia vienen cuantizados a
 * frames de ~11 ms. Buscamos el corrimiento (±40 ms) donde los golpes "arrancan": salto en log de
 * un seguidor de picos (ataque instantáneo, liberación de 150 ms para no confundir el rizado de un
 * bombo de 50 Hz con ataques nuevos). Con temas sintéticos el error queda < 2 ms.
 */
export function refinePhase(x: Float32Array, sr: number, grid: Grid): number {
  const hop = Math.max(1, Math.round(sr / 1000));
  const n = Math.floor(x.length / hop);
  const env = new Float32Array(n);
  const dec = Math.exp(-1 / (0.15 * sr));
  let e = 0;
  for (let k = 0; k < n; k++) {
    for (let i = k * hop; i < (k + 1) * hop; i++) {
      const a = Math.abs(x[i]);
      e = a > e ? a : e * dec;
    }
    env[k] = e;
  }
  const onset = new Float32Array(n);
  for (let k = 2; k < n; k++) onset[k] = Math.max(0, Math.log10(env[k] + 1e-6) - Math.log10(env[k - 2] + 1e-6));
  const T = 60 / grid.bpm;
  const nBeats = Math.floor((x.length / sr - grid.firstBeat) / T);
  let best = 0;
  let bestScore = -1;
  for (let d = -40; d <= 40; d++) {
    let score = 0;
    for (let i = 0; i < nBeats; i++) {
      const k = Math.round((grid.firstBeat + i * T) * 1000) + d;
      if (k > 1 && k < n) score += onset[k];
    }
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  let fb = grid.firstBeat + best / 1000;
  if (fb < 0) fb += T;
  return fb;
}

/**
 * Estima qué beat (mod 4) es el primer tiempo del compás. Los cambios de sección (entra/sale el
 * bajo, breaks) caen sobre downbeats, así que buscamos la fase con mayor "novedad" de energía
 * entre los 2 compases anteriores y los 2 siguientes, más un empujón al primer golpe del tema.
 */
export function estimateDownbeat(wf: WaveformData, grid: Grid, audioStart: number, duration: number): number {
  const T = 60 / grid.bpm;
  const nBeats = Math.floor((duration - grid.firstBeat) / T);
  if (nBeats < 16) return 0;
  const beatE = new Float64Array(nBeats);
  const beatLow = new Float64Array(nBeats);
  for (let i = 0; i < nBeats; i++) {
    const s = Math.floor((grid.firstBeat + i * T) * wf.rate);
    const e = Math.min(wf.amp.length, Math.floor((grid.firstBeat + (i + 1) * T) * wf.rate));
    let acc = 0;
    let lo = 0;
    for (let j = s; j < e; j++) {
      acc += wf.low[j] + wf.mid[j] + wf.high[j];
      lo += wf.low[j];
    }
    beatE[i] = acc / Math.max(1, e - s);
    // Golpe de graves en la primera mitad del beat
    let l0 = 0;
    for (let j = s; j < Math.min(e, s + Math.floor((e - s) / 3)); j++) l0 = Math.max(l0, wf.low[j]);
    beatLow[i] = l0;
  }
  const W = 8;
  const score = [0, 0, 0, 0];
  for (let i = W; i < nBeats - W; i++) {
    let before = 0;
    let after = 0;
    for (let k = 1; k <= W; k++) {
      before += beatE[i - k];
      after += beatE[i + k - 1];
    }
    score[i % 4] += Math.abs(after - before) / W;
  }
  let max = Math.max(...score);
  const startBeat = Math.round((audioStart - grid.firstBeat) / T);
  if (startBeat >= 0) score[((startBeat % 4) + 4) % 4] += 0.15 * max;
  max = -1;
  let best = 0;
  for (let p = 0; p < 4; p++) {
    if (score[p] > max) {
      max = score[p];
      best = p;
    }
  }
  return best;
}

export function rmsDb(x: Float32Array, start: number, end: number): number {
  let s = 0;
  let n = 0;
  for (let i = Math.max(0, start); i < Math.min(x.length, end); i += 4) {
    s += x[i] * x[i];
    n++;
  }
  return 10 * Math.log10(s / Math.max(1, n) + 1e-12);
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Energía 1..10 a partir de loudness, danceability, densidad de agudos y BPM. */
export function energyScore(loudnessDb: number, danceability: number, bpm: number, wf: WaveformData): number {
  let hi = 0;
  let tot = 0;
  for (let i = 0; i < wf.amp.length; i++) {
    hi += wf.high[i];
    tot += wf.low[i] + wf.mid[i] + wf.high[i];
  }
  const brightness = tot > 0 ? hi / tot : 0;
  const e =
    0.45 * clamp01((loudnessDb + 22) / 15) +
    0.25 * clamp01((danceability - 0.8) / 1.4) +
    0.15 * clamp01((bpm - 85) / 55) +
    0.15 * clamp01((brightness - 0.08) / 0.25);
  return Math.round((1 + 9 * e) * 10) / 10;
}
