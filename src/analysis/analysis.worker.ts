// Worker de análisis con essentia.js: BPM + beats (RhythmExtractor2013), tonalidad (KeyExtractor,
// perfil "edma" para música electrónica), danceability y forma de onda.
import { EssentiaWASM } from 'essentia.js/dist/essentia-wasm.es.js';
import Essentia from 'essentia.js/dist/essentia.js-core.es.js';
import { audioBounds, computeWaveform, energyScore, estimateDownbeat, fitGrid, refinePhase, rmsDb } from './analysis-core';
import { toCamelot } from './camelot';
import { ANALYSIS_VERSION, type Analysis } from '../library';

export interface AnalyzeRequest {
  id: string;
  mono: Float32Array; // 44.1 kHz
  sampleRate: number;
  /** false = sólo forma de onda (el análisis ya estaba en caché). */
  full: boolean;
}

export type AnalyzeResponse =
  | { id: string; ok: true; analysis?: Analysis; waveform: ReturnType<typeof computeWaveform> }
  | { id: string; ok: false; error: string };

let essentia: Essentia | null = null;

function getEssentia(): Essentia {
  essentia ??= new Essentia(EssentiaWASM);
  return essentia;
}

function analyze(req: AnalyzeRequest): AnalyzeResponse {
  const { mono, sampleRate: sr } = req;
  const duration = mono.length / sr;
  const wf = computeWaveform(mono, sr);
  if (!req.full) return { id: req.id, ok: true, waveform: wf };

  const e = getEssentia();
  const bounds = audioBounds(wf);

  const sig = e.arrayToVector(mono);
  const rhythm = e.RhythmExtractor2013(sig, 208, 'degara', 40);
  const ticks = Array.from(e.vectorToArray(rhythm.ticks));
  rhythm.ticks.delete();
  rhythm.estimates.delete();
  rhythm.bpmIntervals.delete();
  const key = e.KeyExtractor(sig, true, 4096, 4096, 12, 3500, 60, 25, 0.2, 'edma', sr);
  sig.delete();

  // Danceability sobre 30 s del medio del tema (es costoso sobre el tema entero).
  const mid = Math.floor(mono.length / 2);
  const half = Math.min(mid, 15 * sr);
  const exVec = e.arrayToVector(mono.subarray(mid - half, mid + half));
  let danceability = 1.2;
  try {
    const d = e.Danceability(exVec, 8800, 310, sr);
    danceability = d.danceability;
    d.dfa?.delete?.();
  } catch {
    /* opcional */
  }
  exVec.delete();

  const grid = fitGrid(ticks, rhythm.bpm);
  grid.firstBeat = refinePhase(mono, sr, grid);
  const downbeat = estimateDownbeat(wf, grid, bounds.start, duration);
  const loudnessDb = rmsDb(mono, Math.floor(bounds.start * sr), Math.floor(bounds.end * sr));

  const analysis: Analysis = {
    bpm: grid.bpm,
    firstBeat: grid.firstBeat,
    downbeat,
    gridFit: grid.fit,
    key: key.key,
    scale: key.scale,
    camelot: toCamelot(key.key, key.scale),
    keyStrength: key.strength,
    energy: energyScore(loudnessDb, danceability, grid.bpm, wf),
    loudnessDb,
    danceability,
    audioStart: bounds.start,
    audioEnd: bounds.end,
    duration,
    version: ANALYSIS_VERSION,
  };
  return { id: req.id, ok: true, analysis, waveform: wf };
}

self.onmessage = (ev: MessageEvent<AnalyzeRequest>) => {
  let res: AnalyzeResponse;
  try {
    res = analyze(ev.data);
  } catch (err) {
    res = { id: ev.data.id, ok: false, error: String((err as Error)?.message ?? err) };
  }
  if (res.ok) {
    const w = res.waveform;
    (self as unknown as Worker).postMessage(res, [w.amp.buffer, w.low.buffer, w.mid.buffer, w.high.buffer] as Transferable[]);
  } else {
    (self as unknown as Worker).postMessage(res);
  }
};
