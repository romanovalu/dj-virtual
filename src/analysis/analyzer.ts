// Cola de análisis en el hilo principal: decodifica, baja a mono 44.1 kHz y manda al worker.
// El resultado (sin la forma de onda) se guarda en localStorage por nombre + tamaño + fecha.
import type { AnalyzeRequest, AnalyzeResponse } from './analysis.worker';
import { ANALYSIS_VERSION, type Analysis, type Track } from '../library';

const CACHE_KEY = 'djv.analysis.v1';
const ANALYSIS_SR = 44100;

function cacheKey(f: File): string {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

function readCache(): Record<string, Analysis> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as Record<string, Analysis>;
  } catch {
    return {};
  }
}

function writeCache(key: string, a: Analysis): void {
  try {
    const c = readCache();
    c[key] = a;
    const keys = Object.keys(c);
    // Límite simple para no llenar el localStorage
    for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete c[k];
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* ignorar */
  }
}

export function updateCachedAnalysis(track: Track): void {
  if (track.file && track.analysis) writeCache(cacheKey(track.file), track.analysis);
}

export class Analyzer {
  private worker: Worker;
  private queue: Track[] = [];
  private busy = false;
  private pending = new Map<string, (r: AnalyzeResponse) => void>();
  private ctx: BaseAudioContext;
  onUpdate: (t: Track) => void = () => {};

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<AnalyzeResponse>) => {
      this.pending.get(e.data.id)?.(e.data);
      this.pending.delete(e.data.id);
    };
  }

  enqueue(t: Track): void {
    this.queue.push(t);
    void this.pump();
  }

  get queued(): number {
    return this.queue.length + (this.busy ? 1 : 0);
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    const t = this.queue.shift();
    if (!t) return;
    this.busy = true;
    try {
      await this.run(t);
    } catch (e) {
      t.status = 'error';
      t.error = String((e as Error)?.message ?? e);
      this.onUpdate(t);
    }
    this.busy = false;
    void this.pump();
  }

  private async run(t: Track): Promise<void> {
    if (!t.file) return;
    t.status = 'analyzing';
    this.onUpdate(t);
    const key = cacheKey(t.file);
    const cached = readCache()[key];
    const useCache = cached && cached.version === ANALYSIS_VERSION;

    const buf = await decodeFile(this.ctx, t.file);
    t.duration = buf.duration;
    const mono = await toMono44k(buf);
    const res = await new Promise<AnalyzeResponse>((resolve) => {
      this.pending.set(t.id, resolve);
      const req: AnalyzeRequest = { id: t.id, mono, sampleRate: ANALYSIS_SR, full: !useCache };
      this.worker.postMessage(req, [mono.buffer]);
    });
    if (!res.ok) throw new Error(res.error);
    t.waveform = res.waveform;
    t.analysis = useCache ? cached : res.analysis;
    if (!useCache && res.analysis) writeCache(key, res.analysis);
    t.status = 'ready';
    this.onUpdate(t);
  }
}

export async function decodeFile(ctx: BaseAudioContext, file: File): Promise<AudioBuffer> {
  const data = await file.arrayBuffer();
  try {
    return await ctx.decodeAudioData(data);
  } catch {
    throw new Error(`No pude decodificar "${file.name}" (formato no soportado o archivo dañado).`);
  }
}

/** Mezcla a mono y remuestrea a 44.1 kHz con un OfflineAudioContext (rápido y nativo). */
async function toMono44k(buf: AudioBuffer): Promise<Float32Array> {
  const len = Math.ceil(buf.duration * ANALYSIS_SR);
  const off = new OfflineAudioContext(1, len, ANALYSIS_SR);
  const src = new AudioBufferSourceNode(off, { buffer: buf });
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  // Copia: el buffer interno de un AudioBuffer no siempre se puede transferir.
  return out.getChannelData(0).slice();
}
