// Sampler de 8 pads. Los sonidos de fábrica se sintetizan acá (sin audios con derechos); los pads
// libres aceptan tus propios archivos (se guardan en IndexedDB). Todo se dispara cuantizado al
// tempo del tema que suena: en el próximo beat, o el riser para que termine en el compás 1.
import type { AudioEngine } from './engine';
import type { Deck } from './deck';
import { barStartBeat, beatIndex, beatTime } from '../library';

export type Quantize = 'beat' | 'riser' | 'none';

export interface Pad {
  name: string;
  emoji: string;
  buffer: AudioBuffer | null;
  quantize: Quantize;
  custom: boolean;
  playing: boolean;
}

type Synth = (ctx: OfflineAudioContext, dur: number) => void;

function noise(ctx: BaseAudioContext, dur: number): AudioBufferSourceNode {
  const b = ctx.createBuffer(1, Math.ceil(dur * ctx.sampleRate), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return new AudioBufferSourceNode(ctx, { buffer: b });
}

const SYNTHS: Record<string, { emoji: string; dur: number; q: Quantize; make: Synth }> = {
  Sirena: {
    emoji: '🚨',
    dur: 2.4,
    q: 'beat',
    make: (ctx, dur) => {
      // Sirena de cumbia: sube y baja, con vibrato.
      const o = new OscillatorNode(ctx, { type: 'sawtooth' });
      const f = o.frequency;
      f.setValueAtTime(520, 0);
      for (let k = 0; k < 3; k++) {
        f.linearRampToValueAtTime(1350, k * 0.8 + 0.4);
        f.linearRampToValueAtTime(520, k * 0.8 + 0.8);
      }
      const vib = new OscillatorNode(ctx, { frequency: 7 });
      vib.connect(new GainNode(ctx, { gain: 18 })).connect(f);
      const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3000 });
      const g = new GainNode(ctx, { gain: 0 });
      g.gain.linearRampToValueAtTime(0.35, 0.05);
      g.gain.setValueAtTime(0.35, dur - 0.3);
      g.gain.linearRampToValueAtTime(0, dur);
      o.connect(lp).connect(g).connect(ctx.destination);
      o.start();
      vib.start();
    },
  },
  Bocina: {
    emoji: '📯',
    dur: 1.6,
    q: 'beat',
    make: (ctx) => {
      // "Air horn": tres golpes cortos + uno largo, sierras desafinadas.
      const hits: [number, number][] = [
        [0, 0.12],
        [0.18, 0.12],
        [0.36, 0.12],
        [0.54, 0.9],
      ];
      for (const [t, len] of hits) {
        for (const freq of [470, 476, 590, 596]) {
          const o = new OscillatorNode(ctx, { type: 'sawtooth', frequency: freq * 0.92 });
          o.frequency.setValueAtTime(freq * 0.92, t);
          o.frequency.exponentialRampToValueAtTime(freq, t + 0.04);
          const g = new GainNode(ctx, { gain: 0 });
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.09, t + 0.01);
          g.gain.setValueAtTime(0.09, t + len - 0.03);
          g.gain.linearRampToValueAtTime(0, t + len);
          o.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2600 })).connect(g).connect(ctx.destination);
          o.start(t);
          o.stop(t + len + 0.01);
        }
      }
    },
  },
  Riser: {
    emoji: '🚀',
    dur: 4,
    q: 'riser',
    make: (ctx, dur) => {
      // Ruido con filtro que sube + tono que sube: termina justo en el compás 1.
      const n = noise(ctx, dur);
      const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 300, Q: 2 });
      bp.frequency.exponentialRampToValueAtTime(9000, dur);
      const g = new GainNode(ctx, { gain: 0.02 });
      g.gain.exponentialRampToValueAtTime(0.5, dur - 0.02);
      g.gain.linearRampToValueAtTime(0, dur);
      n.connect(bp).connect(g).connect(ctx.destination);
      n.start();
      const o = new OscillatorNode(ctx, { type: 'sawtooth', frequency: 110 });
      o.frequency.exponentialRampToValueAtTime(880, dur);
      const og = new GainNode(ctx, { gain: 0.001 });
      og.gain.exponentialRampToValueAtTime(0.12, dur - 0.02);
      og.gain.linearRampToValueAtTime(0, dur);
      o.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2500 })).connect(og).connect(ctx.destination);
      o.start();
    },
  },
  Impacto: {
    emoji: '💣',
    dur: 2.5,
    q: 'beat',
    make: (ctx, dur) => {
      const o = new OscillatorNode(ctx, { type: 'sine', frequency: 90 });
      o.frequency.exponentialRampToValueAtTime(32, 1.2);
      const g = new GainNode(ctx, { gain: 0.9 });
      g.gain.exponentialRampToValueAtTime(0.001, dur);
      o.connect(g).connect(ctx.destination);
      o.start();
      const n = noise(ctx, 1.5);
      const ng = new GainNode(ctx, { gain: 0.4 });
      ng.gain.exponentialRampToValueAtTime(0.001, 1.4);
      n.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1800 })).connect(ng).connect(ctx.destination);
      n.start();
    },
  },
  Láser: {
    emoji: '⚡',
    dur: 0.9,
    q: 'beat',
    make: (ctx) => {
      for (let k = 0; k < 3; k++) {
        const t = k * 0.13;
        const o = new OscillatorNode(ctx, { type: 'square', frequency: 2400 });
        o.frequency.setValueAtTime(2400, t);
        o.frequency.exponentialRampToValueAtTime(140, t + 0.12);
        const g = new GainNode(ctx, { gain: 0 });
        g.gain.setValueAtTime(0.12, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        o.connect(g).connect(ctx.destination);
        o.start(t);
        o.stop(t + 0.13);
      }
    },
  },
  Platillo: {
    emoji: '🥁',
    dur: 2.5,
    q: 'beat',
    make: (ctx, dur) => {
      const n = noise(ctx, dur);
      const g = new GainNode(ctx, { gain: 0.45 });
      g.gain.exponentialRampToValueAtTime(0.001, dur);
      n.connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 5000 })).connect(g).connect(ctx.destination);
      n.start();
    },
  },
};

const FACTORY = ['Sirena', 'Bocina', 'Riser', 'Impacto', 'Láser', 'Platillo'];
const PADS = 8;
const DB = 'djv-sampler';

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('pads');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idbPut(i: number, v: { name: string; data: ArrayBuffer } | null): Promise<void> {
  const db = await idb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction('pads', 'readwrite');
    if (v) tx.objectStore('pads').put(v, i);
    else tx.objectStore('pads').delete(i);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function idbAll(): Promise<Map<number, { name: string; data: ArrayBuffer }>> {
  const db = await idb();
  return new Promise((res, rej) => {
    const out = new Map<number, { name: string; data: ArrayBuffer }>();
    const tx = db.transaction('pads', 'readonly');
    const cur = tx.objectStore('pads').openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        out.set(Number(c.key), c.value);
        c.continue();
      } else res(out);
    };
    cur.onerror = () => rej(cur.error);
  });
}

export class Sampler {
  pads: Pad[] = [];
  /** Veces que se disparó un pad (lecciones). */
  hits = 0;
  quantizeOn = true;
  private engine: AudioEngine;
  private voices = new Map<number, AudioBufferSourceNode>();
  private listeners = new Set<() => void>();
  /** Devuelve el deck que marca el tempo (el que suena). */
  clock: () => Deck | null = () => null;

  constructor(engine: AudioEngine) {
    this.engine = engine;
    for (let i = 0; i < PADS; i++) {
      const name = FACTORY[i];
      this.pads.push(name ? { name, emoji: SYNTHS[name].emoji, buffer: null, quantize: SYNTHS[name].q, custom: false, playing: false } : { name: 'Libre', emoji: '➕', buffer: null, quantize: 'beat', custom: false, playing: false });
    }
  }

  onChange(cb: () => void): void {
    this.listeners.add(cb);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  async init(): Promise<void> {
    const sr = this.engine.ctx.sampleRate;
    await Promise.all(
      this.pads.map(async (p) => {
        const s = SYNTHS[p.name];
        if (!s) return;
        const off = new OfflineAudioContext(2, Math.ceil(s.dur * sr), sr);
        s.make(off, s.dur);
        p.buffer = await off.startRendering();
      }),
    );
    try {
      const saved = await idbAll();
      for (const [i, v] of saved) await this.applyCustom(i, v.name, v.data.slice(0));
    } catch {
      /* sin IndexedDB: sólo los de fábrica */
    }
    this.emit();
  }

  private async applyCustom(i: number, name: string, data: ArrayBuffer): Promise<void> {
    const buffer = await this.engine.ctx.decodeAudioData(data);
    this.pads[i] = { name: name.replace(/\.[a-z0-9]+$/i, '').slice(0, 18), emoji: '🎤', buffer, quantize: 'beat', custom: true, playing: false };
  }

  /** Carga un archivo propio en un pad (queda guardado en este navegador). */
  async loadFile(i: number, file: File): Promise<void> {
    const data = await file.arrayBuffer();
    await this.applyCustom(i, file.name, data.slice(0));
    try {
      await idbPut(i, { name: file.name, data });
    } catch {
      /* ignorar */
    }
    this.emit();
  }

  /** Vuelve el pad a su sonido de fábrica (o lo deja libre). */
  async reset(i: number): Promise<void> {
    const name = FACTORY[i];
    const sr = this.engine.ctx.sampleRate;
    if (name) {
      const s = SYNTHS[name];
      const off = new OfflineAudioContext(2, Math.ceil(s.dur * sr), sr);
      s.make(off, s.dur);
      this.pads[i] = { name, emoji: s.emoji, buffer: await off.startRendering(), quantize: s.q, custom: false, playing: false };
    } else this.pads[i] = { name: 'Libre', emoji: '➕', buffer: null, quantize: 'beat', custom: false, playing: false };
    try {
      await idbPut(i, null);
    } catch {
      /* ignorar */
    }
    this.emit();
  }

  /** Cuándo (reloj de audio) disparar: próximo beat, o para que un riser termine en el compás 1. */
  private when(p: Pad): { at: number; rate: number } {
    const ctx = this.engine.ctx;
    const now = ctx.currentTime + 0.01;
    const d = this.clock();
    const a = d?.analysis;
    if (!this.quantizeOn || !d || !a || !d.playing || p.quantize === 'none') return { at: now, rate: 1 };
    // Posición del tema en el instante "now" (con el margen de 10 ms incluido).
    const pos = d.position(now);
    const beatSec = 60 / (a.bpm * d.tempo);
    if (p.quantize === 'riser' && p.buffer) {
      // Elegimos el próximo compás 1 de frase (cada 4 compases) al que llegue entero el riser.
      const d0 = barStartBeat(a, 0);
      const dur = p.buffer.duration;
      let bar = Math.ceil((beatIndex(a, pos) - d0) / 4);
      for (let k = 0; k < 64; k++, bar++) {
        if (bar % 4 !== 0) continue;
        const target = now + (beatTime(a, d0 + bar * 4) - pos) / d.tempo;
        if (target - dur >= now) return { at: target - dur, rate: 1 };
      }
      return { at: now, rate: 1 };
    }
    const b = beatIndex(a, pos);
    const next = Math.ceil(b - 0.05);
    return { at: now + Math.max(0, next - b) * beatSec, rate: 1 };
  }

  trigger(i: number): void {
    const p = this.pads[i];
    if (!p?.buffer) return;
    const ctx = this.engine.ctx;
    // Choke: si el pad ya estaba sonando, lo cortamos.
    const prev = this.voices.get(i);
    if (prev) {
      try {
        prev.stop();
      } catch {
        /* ya terminó */
      }
    }
    const { at } = this.when(p);
    const src = new AudioBufferSourceNode(ctx, { buffer: p.buffer });
    src.connect(this.engine.samplerBus);
    src.start(at);
    this.voices.set(i, src);
    this.hits++;
    p.playing = true;
    src.onended = () => {
      if (this.voices.get(i) === src) {
        this.voices.delete(i);
        p.playing = false;
        this.emit();
      }
    };
    this.emit();
  }

  setVolume(v: number): void {
    this.engine.samplerBus.gain.setTargetAtTime(v * v, this.engine.ctx.currentTime, 0.015);
  }
}
