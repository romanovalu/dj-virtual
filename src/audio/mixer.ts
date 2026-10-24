// Estado global del mixer: crossfader, master y auriculares. También aplica el volumen a los decks de YouTube.
import { crossfaderGains, type AudioEngine } from './engine';
import type { Deck, Owner } from './deck';

export class Mixer {
  crossfader = 0;
  master = 0.8;
  cueMix = 0;
  phonesVolume = 0.8;
  /** Si tocás el crossfader con el Auto-DJ activo, la IA deja de moverlo. */
  xfOwner: Owner = 'user';
  private listeners = new Set<() => void>();
  private engine: AudioEngine;
  private decks: { A: Deck; B: Deck };

  constructor(engine: AudioEngine, decks: { A: Deck; B: Deck }) {
    this.engine = engine;
    this.decks = decks;
    this.apply();
    engine.setMasterVolume(this.master);
    engine.setCueMix(this.cueMix);
    engine.setPhonesVolume(this.phonesVolume);
  }

  onChange(cb: () => void): void {
    this.listeners.add(cb);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  setCrossfader(x: number): void {
    this.crossfader = Math.max(-1, Math.min(1, x));
    this.apply();
    this.emit();
  }

  setMaster(v: number): void {
    this.master = v;
    this.engine.setMasterVolume(v);
    this.apply();
    this.emit();
  }

  setCueMix(v: number): void {
    this.cueMix = v;
    this.engine.setCueMix(v);
    this.emit();
  }

  setPhonesVolume(v: number): void {
    this.phonesVolume = v;
    this.engine.setPhonesVolume(v);
    this.emit();
  }

  setXfOwner(o: Owner): void {
    this.xfOwner = o;
    this.emit();
  }

  private apply(): void {
    const [ga, gb] = crossfaderGains(this.crossfader);
    this.decks.A.strip.setXf(ga);
    this.decks.B.strip.setXf(gb);
    // YouTube no pasa por Web Audio: le aplicamos crossfader y master con setVolume.
    this.decks.A.setYtGain(ga * this.master);
    this.decks.B.setYtGain(gb * this.master);
  }
}
