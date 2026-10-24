// Núcleo de reproducción de un deck. Corre dentro del AudioWorklet (y en Node para tests).
// - Keylock (time-stretch con SoundTouch / WSOLA) cuando el tempo != 1.
// - Lectura directa con interpolación lineal cuando el tempo es 1 o el keylock está apagado
//   (en ese caso el pitch cambia como en un vinilo).
// La posición "audible" se calcula compensando la latencia del WSOLA, para que el beatmatching
// del Auto-DJ compare fases reales.
import { SoundTouch } from 'soundtouchjs';

const FEED = 1024;

export interface LoopState {
  on: boolean;
  start: number; // frames
  end: number; // frames
}

export class DeckCore {
  sampleRate: number;
  left: Float32Array = new Float32Array(0);
  right: Float32Array = new Float32Array(0);
  length = 0;

  playing = false;
  /** Frame del contexto en el que arranca un play programado (-1 = inmediato). */
  startAtFrame = -1;
  /** Posición audible en frames del tema. */
  playhead = 0;
  tempo = 1;
  bend = 1;
  keylock = true;
  loop: LoopState = { on: false, start: 0, end: 0 };
  ended = false;

  /** Beat roll con "slip": suena un pedacito en loop mientras el playhead sigue avanzando. */
  roll = { on: false, start: 0, len: 0, pos: 0 };
  private brake = 0; // factor de freno (0 = sin freno)
  private spinT = -1; // frames transcurridos del backspin (-1 = apagado)
  /** Scratch: con la mano sobre el jog, la velocidad sigue a la mano (puede ser negativa o 0). */
  scratch = { on: false, target: 0, rate: 0 };
  private st: SoundTouch;
  private stretching = false;
  private readPos = 0; // frames ya entregados a SoundTouch
  private stLead = 0; // adelanto de la salida del WSOLA respecto del playhead nominal
  private feedBuf = new Float32Array(FEED * 2);
  private outBuf = new Float32Array(256 * 2);

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.st = new SoundTouch();
    this.st.stretch.setParameters(sampleRate, 0, 0, 8);
  }

  load(left: Float32Array, right: Float32Array): void {
    this.left = left;
    this.right = right;
    this.length = left.length;
    this.playing = false;
    this.startAtFrame = -1;
    this.loop = { on: false, start: 0, end: 0 };
    this.ended = false;
    this.brake = 0;
    this.spinT = -1;
    this.roll.on = false;
    this.seek(0);
  }

  seek(frame: number): void {
    this.playhead = Math.max(0, Math.min(frame, Math.max(0, this.length - 1)));
    this.ended = false;
    this.resetStretch();
  }

  play(atFrame = -1): void {
    if (!this.length) return;
    if (this.ended) this.seek(0);
    this.playing = true;
    this.startAtFrame = atFrame;
    this.brake = 0;
  }

  pause(): void {
    this.playing = false;
    this.startAtFrame = -1;
    this.brake = 0;
  }

  startBrake(): void {
    if (this.playing) this.brake = 1;
  }

  /** Backspin: el tema "rebobina" rápido, frena y queda en pausa. */
  startSpin(): void {
    if (this.playing) {
      this.spinT = 0;
      this.roll.on = false;
    }
  }

  startRoll(startFrame: number, lenFrames: number): void {
    this.roll = { on: true, start: Math.max(0, startFrame), len: Math.max(64, lenFrames), pos: 0 };
  }

  stopRoll(): void {
    this.roll.on = false;
  }

  setScratch(on: boolean, target = 0): void {
    if (on && !this.scratch.on) this.scratch.rate = this.playing ? this.rate : 0;
    this.scratch.on = on;
    this.scratch.target = target;
  }

  setTempo(t: number): void {
    this.tempo = t;
  }

  /** Velocidad efectiva respecto del original (incluye el bend del jog). */
  get rate(): number {
    return this.tempo * this.bend * (this.brake > 0 ? this.brake : 1);
  }

  /**
   * Posición audible (frames). Dentro de cada secuencia WSOLA la salida avanza 1:1, así que el
   * contenido se desfasa en promedio (tempo - 1) * secuencia / 2 respecto del playhead nominal.
   * Medido con deck-core.test.ts: error residual < 1 ms de media.
   */
  get position(): number {
    if (!this.stretching) return this.playhead;
    return this.playhead - (this.st.tempo - 1) * this.st.stretch.seekWindowLength * 0.5;
  }

  private wantsStretch(): boolean {
    return this.keylock && this.brake === 0 && this.spinT < 0 && Math.abs(this.tempo - 1) > 1e-6;
  }

  private resetStretch(): void {
    this.st.clear();
    this.st.stretch.clearMidBuffer();
    this.st.inputBuffer.clear();
    this.st.outputBuffer.clear();
    this.readPos = this.playhead;
    this.stretching = false;
  }

  /**
   * Renderiza n frames. currentFrame = frame del contexto al inicio del bloque.
   * Devuelve true si el tema terminó en este bloque.
   */
  render(outL: Float32Array, outR: Float32Array, n: number, currentFrame: number): boolean {
    outL.fill(0, 0, n);
    outR.fill(0, 0, n);
    if (!this.length) return false;
    if (this.scratch.on) {
      // El scratch suena aunque el deck esté en pausa (como un vinilo).
      this.stretching = false;
      this.renderScratch(outL, outR, n);
      return false;
    }
    if (!this.playing) return false;

    let offset = 0;
    if (this.startAtFrame >= 0) {
      if (currentFrame + n <= this.startAtFrame) return false;
      offset = Math.max(0, Math.round(this.startAtFrame - currentFrame));
      this.startAtFrame = -1;
    }
    const count = n - offset;

    if (this.roll.on) {
      this.stretching = false; // al soltar, el keylock retoma desde el playhead
      this.renderRoll(outL, outR, offset, count);
    } else if (this.spinT >= 0) {
      this.stretching = false;
      this.renderSpin(outL, outR, offset, count);
    } else if (this.wantsStretch()) {
      if (!this.stretching) this.enterStretch();
      this.renderStretch(outL, outR, offset, count);
    } else {
      if (this.stretching) this.stretching = false;
      this.renderDirect(outL, outR, offset, count);
    }

    if (this.brake > 0) {
      this.brake *= Math.pow(0.04, n / this.sampleRate); // ~1 s hasta parar
      if (this.brake < 0.03) {
        this.brake = 0;
        this.playing = false;
      }
    }

    if (this.playhead >= this.length - 1) {
      this.playhead = this.length - 1;
      this.playing = false;
      this.ended = true;
      return true;
    }
    return false;
  }

  private renderRoll(outL: Float32Array, outR: Float32Array, offset: number, count: number): void {
    const rate = this.tempo * this.bend;
    const r = this.roll;
    const fade = Math.min(128, r.len / 4);
    const last = this.length - 2;
    for (let i = 0; i < count; i++) {
      const p = r.pos % r.len;
      const x = Math.min(last, r.start + p);
      const i0 = Math.floor(x);
      const fr = x - i0;
      // Envolvente corta en los bordes del pedacito para que no haga "click"
      const env = Math.min(1, p / fade, (r.len - p) / fade);
      outL[offset + i] = (this.left[i0] + (this.left[i0 + 1] - this.left[i0]) * fr) * env;
      outR[offset + i] = (this.right[i0] + (this.right[i0 + 1] - this.right[i0]) * fr) * env;
      r.pos += rate;
    }
    this.advance(count * rate);
  }

  private renderScratch(outL: Float32Array, outR: Float32Array, n: number): void {
    const s = this.scratch;
    // La velocidad se acerca al objetivo con ~8 ms de inercia (suena a disco, no a escalones).
    const k = 1 - Math.exp(-1 / (0.008 * this.sampleRate));
    let pos = this.playhead;
    const last = this.length - 2;
    for (let i = 0; i < n; i++) {
      s.rate += (s.target - s.rate) * k;
      if (pos < 0) pos = 0;
      if (pos > last) pos = last;
      const i0 = Math.floor(pos);
      const fr = pos - i0;
      outL[i] = this.left[i0] + (this.left[i0 + 1] - this.left[i0]) * fr;
      outR[i] = this.right[i0] + (this.right[i0 + 1] - this.right[i0]) * fr;
      pos += s.rate;
    }
    this.playhead = Math.max(0, Math.min(last, pos));
  }

  private renderSpin(outL: Float32Array, outR: Float32Array, offset: number, count: number): void {
    const T = 0.9 * this.sampleRate;
    let pos = this.playhead;
    for (let i = 0; i < count; i++) {
      const t = Math.min(1, this.spinT / T);
      const rate = -3.2 * this.tempo * Math.pow(1 - t, 1.5);
      if (pos < 1) pos = 1;
      const i0 = Math.floor(pos);
      const fr = pos - i0;
      const env = 1 - t * t;
      outL[offset + i] = (this.left[i0] + (this.left[i0 + 1] - this.left[i0]) * fr) * env;
      outR[offset + i] = (this.right[i0] + (this.right[i0 + 1] - this.right[i0]) * fr) * env;
      pos += rate;
      this.spinT++;
    }
    this.playhead = Math.max(0, pos);
    if (this.spinT >= T) {
      this.spinT = -1;
      this.playing = false;
    }
  }

  private enterStretch(): void {
    this.st.clear();
    this.st.stretch.clearMidBuffer();
    this.st.inputBuffer.clear();
    this.st.outputBuffer.clear();
    const s = this.st.stretch;
    // La salida del WSOLA arranca adelantada en un overlap (el primer midBuffer).
    this.stLead = s.overlapLength;
    this.readPos = this.playhead - this.stLead;
    this.stretching = true;
  }

  private renderStretch(outL: Float32Array, outR: Float32Array, offset: number, count: number): void {
    const rate = this.tempo * this.bend;
    if (Math.abs(this.st.tempo - rate) > 1e-9) this.st.tempo = rate;
    let guard = 0;
    while (this.st.outputBuffer.frameCount < count && guard++ < 64) {
      this.fillFeed();
      this.st.inputBuffer.putSamples(this.feedBuf, 0, FEED);
      this.st.process();
    }
    const got = Math.min(count, this.st.outputBuffer.frameCount);
    if (this.outBuf.length < got * 2) this.outBuf = new Float32Array(got * 2);
    this.st.outputBuffer.receiveSamples(this.outBuf, got);
    for (let i = 0; i < got; i++) {
      outL[offset + i] = this.outBuf[i * 2];
      outR[offset + i] = this.outBuf[i * 2 + 1];
    }
    this.advance(count * rate);
  }

  /** Copia FEED frames desde readPos al buffer intercalado, respetando loops. */
  private fillFeed(): void {
    const f = this.feedBuf;
    let pos = this.readPos;
    for (let i = 0; i < FEED; i++) {
      if (this.loop.on && pos >= this.loop.end) pos -= this.loop.end - this.loop.start;
      const idx = Math.floor(pos);
      if (idx >= 0 && idx < this.length) {
        f[i * 2] = this.left[idx];
        f[i * 2 + 1] = this.right[idx];
      } else {
        f[i * 2] = 0;
        f[i * 2 + 1] = 0;
      }
      pos += 1;
    }
    this.readPos = pos;
  }

  private renderDirect(outL: Float32Array, outR: Float32Array, offset: number, count: number): void {
    const rate = this.rate;
    let pos = this.playhead;
    const L = this.left;
    const R = this.right;
    const last = this.length - 1;
    for (let i = 0; i < count; i++) {
      if (this.loop.on && pos >= this.loop.end) pos -= this.loop.end - this.loop.start;
      if (pos >= last) break;
      const i0 = Math.floor(pos);
      const fr = pos - i0;
      outL[offset + i] = L[i0] + (L[i0 + 1] - L[i0]) * fr;
      outR[offset + i] = R[i0] + (R[i0 + 1] - R[i0]) * fr;
      pos += rate;
    }
    this.playhead = Math.min(pos, last);
  }

  private advance(frames: number): void {
    let p = this.playhead + frames;
    if (this.loop.on && p >= this.loop.end) p -= this.loop.end - this.loop.start;
    this.playhead = p;
  }
}
