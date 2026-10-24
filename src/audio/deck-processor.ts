// AudioWorkletProcessor de un deck: envuelve DeckCore y reporta la posición al hilo principal.
import { DeckCore } from './deck-core';

declare const sampleRate: number;
declare const currentFrame: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

export type DeckCommand =
  | { type: 'load'; left: Float32Array; right: Float32Array }
  | { type: 'unload' }
  | { type: 'play'; at?: number }
  | { type: 'pause' }
  | { type: 'seek'; sec: number }
  | { type: 'tempo'; value: number }
  | { type: 'bend'; value: number }
  | { type: 'keylock'; on: boolean }
  | { type: 'loop'; on: boolean; start: number; end: number }
  | { type: 'brake' }
  | { type: 'spin' }
  | { type: 'roll'; on: boolean; start: number; len: number }
  | { type: 'scratch'; on: boolean; rate: number };

export type DeckReport =
  | { type: 'state'; pos: number; time: number; rate: number; playing: boolean }
  | { type: 'ended' };

const REPORT_EVERY = 4; // bloques de 128 (~12 ms)

class DeckProcessor extends AudioWorkletProcessor {
  private core = new DeckCore(sampleRate);
  private blocks = 0;
  private lastPlaying = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<DeckCommand>) => this.handle(e.data);
  }

  private handle(cmd: DeckCommand): void {
    const c = this.core;
    switch (cmd.type) {
      case 'load':
        c.load(cmd.left, cmd.right);
        break;
      case 'unload':
        c.load(new Float32Array(0), new Float32Array(0));
        break;
      case 'play':
        c.play(cmd.at !== undefined && cmd.at > currentTime ? Math.round(cmd.at * sampleRate) : -1);
        break;
      case 'pause':
        c.pause();
        break;
      case 'seek':
        c.seek(cmd.sec * sampleRate);
        break;
      case 'tempo':
        c.setTempo(cmd.value);
        break;
      case 'bend':
        c.bend = cmd.value;
        break;
      case 'keylock':
        c.keylock = cmd.on;
        break;
      case 'loop':
        c.loop = { on: cmd.on, start: cmd.start * sampleRate, end: cmd.end * sampleRate };
        break;
      case 'brake':
        c.startBrake();
        break;
      case 'spin':
        c.startSpin();
        break;
      case 'scratch':
        c.setScratch(cmd.on, cmd.rate);
        break;
      case 'roll':
        if (cmd.on) c.startRoll(cmd.start * sampleRate, cmd.len * sampleRate);
        else c.stopRoll();
        break;
    }
    this.report();
  }

  private report(): void {
    const c = this.core;
    const msg: DeckReport = { type: 'state', pos: c.position / sampleRate, time: currentTime, rate: c.rate, playing: c.playing && c.startAtFrame < 0 };
    this.port.postMessage(msg);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] ?? out[0];
    // Reportamos la posición al inicio del bloque, junto con su currentTime.
    if (++this.blocks % REPORT_EVERY === 0 || this.core.playing !== this.lastPlaying) this.report();
    this.lastPlaying = this.core.playing;
    const ended = this.core.render(L, R, L.length, currentFrame);
    if (ended) {
      this.port.postMessage({ type: 'ended' } satisfies DeckReport);
      this.report();
    }
    return true;
  }
}

registerProcessor('deck-processor', DeckProcessor);
