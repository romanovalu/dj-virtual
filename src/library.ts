// Modelo de temas de la biblioteca (archivos locales y links de YouTube).

export interface Analysis {
  bpm: number;
  /** Primer beat de la grilla (s). */
  firstBeat: number;
  /** Índice (0..3) del beat de la grilla que cae en el primer tiempo del compás. */
  downbeat: number;
  /** Fracción de beats detectados que caen sobre la grilla (0..1). */
  gridFit: number;
  key: string;
  scale: string;
  camelot: string;
  keyStrength: number;
  /** 1..10 */
  energy: number;
  loudnessDb: number;
  danceability: number;
  /** Primer y último instante con audio (s). */
  audioStart: number;
  audioEnd: number;
  duration: number;
  version: number;
}

export const ANALYSIS_VERSION = 4;

export interface Waveform {
  /** Bins por segundo. */
  rate: number;
  amp: Float32Array;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
}

export type TrackStatus = 'pending' | 'analyzing' | 'ready' | 'error';

export interface Track {
  id: string;
  title: string;
  source: 'local' | 'youtube';
  file?: File;
  youtubeId?: string;
  duration: number;
  status: TrackStatus;
  error?: string;
  analysis?: Analysis;
  waveform?: Waveform;
}

let counter = 0;
export function newTrackId(): string {
  return `t${Date.now().toString(36)}${(counter++).toString(36)}`;
}

export function titleFromFile(name: string): string {
  return name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ');
}

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Tiempo (s) del beat i de la grilla. */
export function beatTime(a: Analysis, i: number): number {
  return a.firstBeat + (i * 60) / a.bpm;
}

/** Índice de beat (fraccional) para un tiempo t. */
export function beatIndex(a: Analysis, t: number): number {
  return ((t - a.firstBeat) * a.bpm) / 60;
}

/** Tiempo del primer downbeat (inicio del compás 1) en o después del inicio del audio. */
export function firstDownbeat(a: Analysis): number {
  let i = a.downbeat;
  while (beatTime(a, i) < a.audioStart - 0.05) i += 4;
  return beatTime(a, i);
}

/** Índice de beat del downbeat i-ésimo de compás (bar). */
export function barStartBeat(a: Analysis, bar: number): number {
  let i0 = a.downbeat;
  while (beatTime(a, i0) < a.audioStart - 0.05) i0 += 4;
  return i0 + bar * 4;
}

/** Ajusta una posición al beat más cercano. */
export function quantize(a: Analysis | undefined, t: number): number {
  if (!a) return t;
  return beatTime(a, Math.round(beatIndex(a, t)));
}

/** Busca un archivo de audio soportado. */
export function isAudioFile(f: File): boolean {
  return /^audio\//.test(f.type) || /\.(mp3|wav|flac|ogg|m4a|aac|aiff?|opus)$/i.test(f.name);
}

export function youtubeIdFromUrl(url: string): string | null {
  const s = url.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1, 12) || null;
    if (/(^|\.)youtube\.com$/.test(u.hostname) || /(^|\.)youtube-nocookie\.com$/.test(u.hostname)) {
      const v = u.searchParams.get('v');
      if (v) return v;
      const m = /\/(embed|shorts|live|v)\/([\w-]{11})/.exec(u.pathname);
      if (m) return m[2];
    }
  } catch {
    /* no es URL */
  }
  return null;
}
