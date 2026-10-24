// Deck en el hilo principal: transporte, cue CDJ, hot cues, loops, FX, sync y modo YouTube.
import type { AudioEngine, ChannelStrip } from './engine';
import type { DeckCommand, DeckReport } from './deck-processor';
import { YouTubeDeck } from './youtube';
import { decodeFile } from '../analysis/analyzer';
import { beatIndex, beatTime, firstDownbeat, quantize, type Track } from '../library';
import type { DeckId } from '../midi/mapping';

export type Owner = 'ai' | 'user';
export type DeckMode = 'empty' | 'loading' | 'local' | 'youtube';

export interface LoopInfo {
  on: boolean;
  start: number;
  end: number;
  beats: number;
}

export const PITCH_RANGES = [0.08, 0.16, 0.5];

export class Deck {
  readonly id: DeckId;
  readonly engine: AudioEngine;
  readonly strip: ChannelStrip;
  node: AudioWorkletNode | null = null;
  readonly yt: YouTubeDeck;

  track: Track | null = null;
  mode: DeckMode = 'empty';
  error = '';
  duration = 0;

  playing = false;
  tempo = 1;
  pitchRange = 0.08;
  keylock = true;
  cuePoint = 0;
  hotcues: (number | null)[] = [null, null, null, null];
  loop: LoopInfo = { on: false, start: 0, end: 0, beats: 4 };
  loopInPending: number | null = null;
  synced = false;
  pfl = false;
  volume = 1;
  eq = { low: 0, mid: 0, high: 0 };
  filter = 0;
  fx = { echo: false, reverb: false, flanger: false, gate: false, roll: 0, hp: false, lp: false, brake: false, spin: false };
  /** Veces que se usó el beat roll (lecciones). */
  rollCount = 0;
  owner: Owner = 'user';
  /** Momento (reloj de audio) del último Play; para medir la entrada en las lecciones. */
  lastPlayAt = 0;
  /** Veces que se escuchó el cue manteniendo CUE (lecciones). */
  cuePreviewCount = 0;
  /** Ganancia externa (crossfader × master) para el modo YouTube. */
  ytGain = 1;

  private rep = { pos: 0, time: 0, rate: 1 };
  private bendAmt = 0;
  private bendTimer = 0;
  private cuePreview = false;
  private loadSeq = 0;
  private listeners = new Set<() => void>();
  private endedListeners = new Set<() => void>();

  constructor(id: DeckId, engine: AudioEngine, ytHost: HTMLElement) {
    this.id = id;
    this.engine = engine;
    this.strip = engine.strips[id];
    this.yt = new YouTubeDeck(ytHost);
    this.yt.onState = () => {
      if (this.mode === 'youtube') {
        this.playing = this.yt.playing;
        this.duration = this.yt.duration;
        if (this.track && this.yt.title) this.track.title = this.yt.title;
        if (this.yt.error) this.error = this.yt.error;
        this.emit();
        if (this.yt.ended) this.endedListeners.forEach((l) => l());
      }
    };
  }

  async init(): Promise<void> {
    this.node = await this.engine.createDeckNode();
    this.node.connect(this.strip.input);
    this.node.port.onmessage = (e: MessageEvent<DeckReport>) => {
      const m = e.data;
      if (m.type === 'state') {
        this.rep = { pos: m.pos, time: m.time, rate: m.playing ? m.rate : 0 };
        if (this.mode === 'local' && m.playing !== this.playing && !this.pendingStart) {
          this.playing = m.playing;
          if (!m.playing && this.fx.brake) this.fx.brake = false;
          if (!m.playing && this.fx.spin) this.fx.spin = false;
          this.emit();
        }
        if (m.playing) this.pendingStart = false;
      } else if (m.type === 'ended') {
        this.playing = false;
        this.emit();
        this.endedListeners.forEach((l) => l());
      }
    };
  }

  /** Un play programado todavía no arrancó en el worklet. */
  private pendingStart = false;

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onEnded(cb: () => void): void {
    this.endedListeners.add(cb);
  }

  emit(): void {
    this.listeners.forEach((l) => l());
  }

  private send(cmd: DeckCommand, transfer: Transferable[] = []): void {
    this.node?.port.postMessage(cmd, transfer);
  }

  get loaded(): boolean {
    return this.mode === 'local' || (this.mode === 'youtube' && this.yt.ready);
  }

  get analysis() {
    return this.mode === 'local' ? this.track?.analysis : undefined;
  }

  /** BPM efectivo (con el pitch aplicado), o 0 si no hay análisis. */
  get bpm(): number {
    const a = this.analysis;
    return a ? a.bpm * this.tempo : 0;
  }

  /** Posición actual estimada (s), extrapolando el último reporte del worklet. */
  position(at = this.engine.ctx.currentTime): number {
    if (this.mode === 'youtube') return this.yt.position;
    const p = this.rep.pos + Math.max(0, at - this.rep.time) * this.rep.rate;
    return Math.min(p, this.duration);
  }

  /** Índice de beat fraccional en la posición actual. */
  beatPos(at?: number): number {
    const a = this.analysis;
    return a ? beatIndex(a, this.position(at)) : 0;
  }

  // ---------------------------------------------------------------- carga

  async loadTrack(track: Track): Promise<void> {
    const seq = ++this.loadSeq;
    this.resetForLoad();
    this.track = track;
    if (track.source === 'youtube' && track.youtubeId) {
      this.mode = 'youtube';
      this.send({ type: 'unload' });
      this.emit();
      try {
        await this.yt.load(track.youtubeId);
      } catch (e) {
        this.error = String((e as Error).message ?? e);
      }
      if (seq !== this.loadSeq) return;
      this.duration = this.yt.duration;
      this.applyYtVolume();
      this.emit();
      return;
    }
    if (!track.file) return;
    this.mode = 'loading';
    this.yt.destroy();
    this.emit();
    try {
      const buf = await decodeFile(this.engine.ctx, track.file);
      if (seq !== this.loadSeq) return;
      const left = buf.getChannelData(0).slice();
      const right = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : left.slice();
      this.duration = buf.duration;
      track.duration = buf.duration;
      this.send({ type: 'load', left, right }, [left.buffer, right.buffer]);
      this.send({ type: 'tempo', value: this.tempo });
      this.send({ type: 'keylock', on: this.keylock });
      this.mode = 'local';
      this.rep = { pos: 0, time: this.engine.ctx.currentTime, rate: 0 };
      this.cuePoint = track.analysis ? firstDownbeat(track.analysis) : 0;
      this.seek(this.cuePoint);
    } catch (e) {
      this.mode = 'empty';
      this.error = String((e as Error).message ?? e);
    }
    this.emit();
  }

  /** Cuando el análisis termina después de cargar el tema, ubicamos el cue en el primer downbeat. */
  analysisArrived(): void {
    const a = this.analysis;
    if (a && !this.playing && this.position() < 0.05) {
      this.cuePoint = firstDownbeat(a);
      this.seek(this.cuePoint);
    }
    this.emit();
  }

  private resetForLoad(): void {
    this.playing = false;
    this.pendingStart = false;
    this.error = '';
    this.duration = 0;
    this.hotcues = [null, null, null, null];
    this.loop = { on: false, start: 0, end: 0, beats: this.loop.beats };
    this.loopInPending = null;
    this.synced = false;
    this.cuePreview = false;
    this.send({ type: 'pause' });
    this.send({ type: 'loop', on: false, start: 0, end: 0 });
    this.yt.pause();
  }

  // ---------------------------------------------------------------- transporte

  play(at?: number): void {
    if (!this.loaded) return;
    this.lastPlayAt = at !== undefined && at > this.engine.ctx.currentTime ? at : this.engine.ctx.currentTime;
    if (this.mode === 'youtube') {
      this.yt.play();
      this.playing = true;
    } else {
      this.send({ type: 'play', at });
      this.playing = true;
      this.pendingStart = at !== undefined && at > this.engine.ctx.currentTime;
      if (this.pendingStart) {
        // Fijamos el reporte para que la posición extrapolada sea correcta desde "at".
        this.rep = { pos: this.position(), time: at!, rate: this.tempo };
      }
    }
    this.emit();
  }

  pause(): void {
    if (this.mode === 'youtube') this.yt.pause();
    else this.send({ type: 'pause' });
    this.playing = false;
    this.pendingStart = false;
    this.rep = { pos: this.position(), time: this.engine.ctx.currentTime, rate: 0 };
    this.emit();
  }

  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(sec: number): void {
    const s = Math.max(0, Math.min(sec, Math.max(0, this.duration - 0.01)));
    if (this.mode === 'youtube') this.yt.seek(s);
    else this.send({ type: 'seek', sec: s });
    this.rep = { pos: s, time: this.engine.ctx.currentTime, rate: this.playing ? this.rep.rate || this.tempo : 0 };
    this.emit();
  }

  /** Cue estilo CDJ: sonando → vuelve al cue y pausa; pausado fuera del cue → fija cue; en el cue → preescucha mientras se mantiene. */
  cueDown(): void {
    if (!this.loaded) return;
    if (this.playing) {
      this.pause();
      this.seek(this.cuePoint);
      return;
    }
    const pos = this.position();
    if (Math.abs(pos - this.cuePoint) > 0.02) {
      this.cuePoint = quantize(this.analysis, pos);
      this.seek(this.cuePoint);
    } else {
      this.cuePreview = true;
      this.cuePreviewCount++;
      this.play();
    }
    this.emit();
  }

  cueUp(): void {
    if (this.cuePreview) {
      this.cuePreview = false;
      this.pause();
      this.seek(this.cuePoint);
    }
  }

  // ---------------------------------------------------------------- tempo

  /** Pitch fader normalizado (-1..1). */
  setPitchNorm(x: number): void {
    this.setTempo(1 + x * this.pitchRange);
  }

  setTempo(t: number): void {
    this.tempo = Math.max(0.5, Math.min(2, t));
    if (this.mode === 'youtube') this.tempo = this.yt.setTempo(this.tempo);
    else this.send({ type: 'tempo', value: this.tempo });
    if (this.playing) this.rep = { pos: this.position(), time: this.engine.ctx.currentTime, rate: this.tempo };
    if (this.fx.echo) this.applyEcho();
    if (this.fx.flanger) this.strip.setFlanger(true, this.barSec() * 2);
    if (this.fx.gate) this.applyGate();
    this.emit();
  }

  setKeylock(on: boolean): void {
    this.keylock = on;
    this.send({ type: 'keylock', on });
    this.emit();
  }

  /** Pitch bend temporal (nudge), en fracción: 0.02 = +2 %. */
  bend(amount: number): void {
    this.bendAmt = Math.max(-0.3, Math.min(0.3, amount));
    this.send({ type: 'bend', value: 1 + this.bendAmt });
  }

  /** Jog: sonando hace pitch bend; pausado mueve la posición. */
  /** DJ2GO2 Touch: mano sobre el jog = modo scratch; al soltar sigue como estaba. */
  jogTouch(on: boolean): void {
    if (this.mode !== 'local') return;
    this.touching = on;
    this.scratchTicks = 0;
    this.send({ type: 'scratch', on, rate: 0 });
    clearInterval(this.scratchTimer);
    this.scratchTimer = 0;
    if (on) {
      this.lastScratchAt = performance.now();
      // Cada 20 ms convertimos los "ticks" del jog en velocidad; sin movimiento, el disco se frena.
      this.scratchTimer = window.setInterval(() => {
        const now = performance.now();
        const dt = Math.max(1, now - this.lastScratchAt) / 1000;
        this.lastScratchAt = now;
        const rate = (this.scratchTicks / dt) / Deck.scratchTicksPerSecond;
        this.scratchTicks = 0;
        this.send({ type: 'scratch', on: true, rate: Math.max(-6, Math.min(6, rate)) });
      }, 20);
    } else {
      // Al soltar, re-sincronizamos la posición que ve la interfaz.
      this.rep = { pos: this.rep.pos, time: this.engine.ctx.currentTime, rate: this.playing ? this.tempo : 0 };
    }
    this.emit();
  }

  /** Ticks del jog por segundo que equivalen a velocidad normal (se ajusta en MIDI Learn). */
  static scratchTicksPerSecond = 220;
  touching = false;
  private scratchTicks = 0;
  private scratchTimer = 0;
  private lastScratchAt = 0;

  jog(delta: number): void {
    if (!this.loaded) return;
    if (this.touching && this.mode === 'local') {
      this.scratchTicks += delta;
      return;
    }
    if (this.mode === 'youtube') {
      if (!this.playing) this.seek(this.position() + delta * 0.05);
      return;
    }
    if (!this.playing) {
      this.seek(this.position() + delta * 0.015);
      return;
    }
    this.bend(this.bendAmt + delta * 0.008);
    if (!this.bendTimer) {
      this.bendTimer = window.setInterval(() => {
        this.bendAmt *= 0.55;
        if (Math.abs(this.bendAmt) < 0.0015) {
          this.bendAmt = 0;
          clearInterval(this.bendTimer);
          this.bendTimer = 0;
        }
        this.send({ type: 'bend', value: 1 + this.bendAmt });
      }, 30);
    }
  }

  // ---------------------------------------------------------------- hot cues y loops

  hotcue(i: number): void {
    if (!this.loaded) return;
    const h = this.hotcues[i];
    if (h === null || h === undefined) {
      this.hotcues[i] = quantize(this.analysis, this.position());
    } else {
      this.seek(h);
    }
    this.emit();
  }

  clearHotcue(i: number): void {
    this.hotcues[i] = null;
    this.emit();
  }

  private beatLen(): number {
    const a = this.analysis;
    return a ? 60 / a.bpm : 0.5;
  }

  private sendLoop(): void {
    this.send({ type: 'loop', on: this.loop.on, start: this.loop.start, end: this.loop.end });
    this.emit();
  }

  loopIn(): void {
    if (!this.loaded || this.mode !== 'local') return;
    this.loopInPending = quantize(this.analysis, this.position());
    this.emit();
  }

  loopOut(): void {
    if (!this.loaded || this.mode !== 'local') return;
    if (this.loop.on) {
      this.loop.on = false;
      this.sendLoop();
      return;
    }
    if (this.loopInPending !== null) {
      const end = quantize(this.analysis, this.position());
      if (end > this.loopInPending + 0.05) {
        this.loop = { on: true, start: this.loopInPending, end, beats: Math.max(1 / 8, Math.round((end - this.loopInPending) / this.beatLen())) };
      }
      this.loopInPending = null;
      this.sendLoop();
      return;
    }
    this.autoLoop(this.loop.beats);
  }

  autoLoop(beats: number): void {
    if (!this.loaded || this.mode !== 'local') return;
    const a = this.analysis;
    const pos = this.position();
    const start = a ? beatTime(a, Math.floor(beatIndex(a, pos) + 0.02)) : pos;
    this.loop = { on: true, start, end: start + beats * this.beatLen(), beats };
    this.sendLoop();
  }

  resizeLoop(factor: number): void {
    const beats = Math.max(1 / 8, Math.min(64, this.loop.beats * factor));
    this.loop.beats = beats;
    if (this.loop.on) {
      this.loop.end = this.loop.start + beats * this.beatLen();
      this.sendLoop();
    } else {
      this.emit();
    }
  }

  beatjump(dir: number): void {
    if (!this.loaded) return;
    const jump = dir * Math.max(1, this.loop.beats) * this.beatLen();
    if (this.loop.on) {
      this.loop.start += jump;
      this.loop.end += jump;
      this.sendLoop();
    }
    this.seek(this.position() + jump);
  }

  // ---------------------------------------------------------------- mixer / FX

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.strip.setFader(this.volume);
    this.applyYtVolume();
    this.emit();
  }

  setEq(band: 'low' | 'mid' | 'high', db: number): void {
    this.eq[band] = db;
    this.strip.setEq(band, db);
    this.emit();
  }

  setFilter(x: number): void {
    this.filter = x;
    this.strip.setFilter(x);
    this.fx.hp = x > 0.02;
    this.fx.lp = x < -0.02;
    this.emit();
  }

  setPfl(on: boolean): void {
    this.pfl = on;
    this.strip.setPfl(on);
    this.emit();
  }

  private applyEcho(): void {
    const bpm = this.bpm || 120;
    this.strip.setEcho(this.fx.echo, (60 / bpm) * 0.75);
  }

  /** Duración real de un compás (s) con el tempo actual. */
  private barSec(): number {
    return (4 * 60) / (this.bpm || 120);
  }

  private applyGate(): void {
    const a = this.analysis;
    const step = 60 / (this.bpm || 120) / 2; // corcheas
    let startAt = this.engine.ctx.currentTime;
    if (a && this.playing) {
      // Alineamos el gate a la próxima corchea de la grilla.
      const pos = this.position();
      const half = beatIndex(a, pos) * 2;
      startAt += ((Math.ceil(half) - half) * step) / 1;
    }
    this.strip.setGate(this.fx.gate, step, startAt);
  }

  setFx(name: 'echo' | 'reverb' | 'flanger' | 'gate', on: boolean): void {
    if (this.mode !== 'local') return;
    this.fx[name] = on;
    if (name === 'echo') this.applyEcho();
    else if (name === 'reverb') this.strip.setReverb(on);
    else if (name === 'flanger') this.strip.setFlanger(on, this.barSec() * 2);
    else this.applyGate();
    this.emit();
  }

  /** Beat roll: repite `beats` de tiempo (½, ¼, ⅛…) mientras se mantiene; el tema sigue corriendo debajo. */
  rollStart(beats: number): void {
    if (this.mode !== 'local' || !this.playing) return;
    const a = this.analysis;
    const beatLen = a ? 60 / a.bpm : 0.5;
    const len = beats * beatLen;
    const pos = this.position();
    const start = a ? beatTime(a, Math.floor(beatIndex(a, pos) / beats) * beats) : pos;
    this.fx.roll = beats;
    this.rollCount++;
    this.send({ type: 'roll', on: true, start, len });
    this.emit();
  }

  rollStop(): void {
    if (!this.fx.roll) return;
    this.fx.roll = 0;
    this.send({ type: 'roll', on: false, start: 0, len: 0 });
    this.emit();
  }

  brake(): void {
    if (this.mode !== 'local' || !this.playing) return;
    this.fx.brake = true;
    this.send({ type: 'brake' });
    this.emit();
  }

  backspin(): void {
    if (this.mode !== 'local' || !this.playing) return;
    this.rollStop();
    this.fx.spin = true;
    this.send({ type: 'spin' });
    this.emit();
  }

  /** Apaga todos los efectos (lo usa la IA al terminar una mezcla). */
  clearFx(): void {
    for (const k of ['echo', 'reverb', 'flanger', 'gate'] as const) if (this.fx[k]) this.setFx(k, false);
    this.rollStop();
  }

  /** Pads de FX del DJ2GO2: 1 eco, 2 reverb, 3 roll (se maneja aparte, mantener), 4 flanger. */
  toggleFx(n: 1 | 2 | 3 | 4): void {
    if (n === 1) this.setFx('echo', !this.fx.echo);
    else if (n === 2) this.setFx('reverb', !this.fx.reverb);
    else if (n === 3) {
      if (this.fx.roll) this.rollStop();
      else this.rollStart(0.25);
    } else this.setFx('flanger', !this.fx.flanger);
  }

  setYtGain(g: number): void {
    this.ytGain = g;
    this.applyYtVolume();
  }

  private applyYtVolume(): void {
    if (this.mode === 'youtube') this.yt.setVolume(this.volume * this.volume * this.ytGain);
  }

  // ---------------------------------------------------------------- sync

  /** Multiplicador (0.5, 1, 2) que deja los BPM más cerca (half/double time). */
  static bpmMultiplier(from: number, to: number): number {
    let best = 1;
    for (const m of [0.5, 1, 2]) if (Math.abs(Math.log((from * m) / to)) < Math.abs(Math.log((from * best) / to))) best = m;
    return best;
  }

  /** Iguala el tempo y la fase (beat) con el otro deck. */
  syncTo(master: Deck): boolean {
    const a = this.analysis;
    const b = master.analysis;
    if (!a || !b) return false;
    const target = master.bpm;
    const m = Deck.bpmMultiplier(a.bpm, target);
    this.setTempo(target / (a.bpm * m));
    if (this.playing && master.playing) {
      // Fase: llevar nuestra fracción de beat a la del master.
      const now = this.engine.ctx.currentTime;
      const phM = master.beatPos(now) * m;
      const phS = this.beatPos(now);
      let d = (phM - phS) % 1;
      if (d > 0.5) d -= 1;
      if (d < -0.5) d += 1;
      this.seek(this.position(now) + (d * 60) / a.bpm);
    }
    this.synced = true;
    this.emit();
    return true;
  }

  unsync(): void {
    this.synced = false;
    this.emit();
  }

  setOwner(o: Owner): void {
    if (this.owner !== o) {
      this.owner = o;
      this.emit();
    }
  }

  /** Para la UI: la grilla se movió (corrección manual del downbeat). */
  shiftDownbeat(dir: number): void {
    const a = this.track?.analysis;
    if (!a) return;
    a.downbeat = (((a.downbeat + dir) % 4) + 4) % 4;
    this.emit();
  }
}
