// Contexto compartido entre las pantallas (Pro, Fácil, Aprender).
import type { AudioEngine } from './audio/engine';
import type { Deck } from './audio/deck';
import type { Mixer } from './audio/mixer';
import type { AutoDJ } from './autodj/autodj';
import type { Controller } from './midi/controller';
import type { Guide } from './guide/guide';
import type { Track } from './library';
import type { Sampler } from './audio/sampler';

export type AppMode = 'easy' | 'learn' | 'pro';

export interface App {
  engine: AudioEngine;
  decks: { A: Deck; B: Deck };
  mixer: Mixer;
  autodj: AutoDJ;
  controller: Controller;
  guide: Guide;
  sampler: Sampler;
  tracks: Track[];
  addFiles(files: Iterable<File>): void;
  toast(msg: string): void;
  resumeAudio(): void;
  /** Llena la cola con todos los temas utilizables que no estén sonando ni preparados. */
  fillQueue(onlyAnalyzed?: boolean): number;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
