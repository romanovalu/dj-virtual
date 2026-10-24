// Motor de audio: AudioContext, mixer de 2 canales, master y salida de auriculares (preescucha).
import processorUrl from './deck-processor.ts?worker&url';

export type OutputMode = 'stereo' | 'quad';

export interface AudioSettings {
  mode: OutputMode;
  masterDevice: string; // '' = predeterminado
  phonesDevice: string; // '' = sin salida de auriculares separada
}

const SETTINGS_KEY = 'djv.audio.v1';

export function loadAudioSettings(): AudioSettings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (s) return { mode: s.mode === 'quad' ? 'quad' : 'stereo', masterDevice: s.masterDevice ?? '', phonesDevice: s.phonesDevice ?? '' };
  } catch {
    /* ignorar */
  }
  return { mode: 'stereo', masterDevice: '', phonesDevice: '' };
}

function saveAudioSettings(s: AudioSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignorar */
  }
}

const EQ_MIN_DB = -40;
const EQ_MAX_DB = 6;

/** Canal del mixer: EQ de 3 bandas → filtro → eco → fader → crossfader. PFL post-EQ, pre-fader. */
export class ChannelStrip {
  readonly input: GainNode;
  readonly low: BiquadFilterNode;
  readonly mid: BiquadFilterNode;
  readonly high: BiquadFilterNode;
  readonly hp: BiquadFilterNode;
  readonly lp: BiquadFilterNode;
  readonly post: GainNode;
  readonly fader: GainNode;
  readonly xf: GainNode;
  readonly pfl: GainNode;
  readonly analyser: AnalyserNode;
  private readonly echoDelay: DelayNode;
  private readonly echoFb: GainNode;
  private readonly echoWet: GainNode;
  private readonly revWet: GainNode;
  private readonly flDelay: DelayNode;
  private readonly flWet: GainNode;
  private readonly flDepth: GainNode;
  private flLfo: OscillatorNode | null = null;
  readonly gate: GainNode;
  private gateLfo: OscillatorNode | null = null;
  private gateAmt: GainNode | null = null;
  private readonly ctx: AudioContext;

  constructor(ctx: AudioContext, master: AudioNode, cue: AudioNode) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.low = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 220 });
    this.mid = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1100, Q: 0.7 });
    this.high = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 3800 });
    this.hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 10, Q: 0.9 });
    this.lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 22000, Q: 0.9 });
    this.post = ctx.createGain();
    this.echoDelay = new DelayNode(ctx, { maxDelayTime: 4, delayTime: 0.375 });
    this.echoFb = new GainNode(ctx, { gain: 0.45 });
    this.echoWet = new GainNode(ctx, { gain: 0 });
    this.revWet = new GainNode(ctx, { gain: 0 });
    this.flDelay = new DelayNode(ctx, { maxDelayTime: 0.02, delayTime: 0.003 });
    this.flWet = new GainNode(ctx, { gain: 0 });
    this.flDepth = new GainNode(ctx, { gain: 0.0022 });
    this.gate = new GainNode(ctx, { gain: 1 });
    this.fader = ctx.createGain();
    this.xf = ctx.createGain();
    this.pfl = new GainNode(ctx, { gain: 0 });
    this.analyser = new AnalyserNode(ctx, { fftSize: 512, smoothingTimeConstant: 0.5 });

    this.input.connect(this.low).connect(this.mid).connect(this.high).connect(this.hp).connect(this.lp).connect(this.post);
    // Eco: envío post-filtro con realimentación, vuelve al bus post.
    this.lp.connect(this.echoWet).connect(this.echoDelay);
    this.echoDelay.connect(this.echoFb).connect(this.echoDelay);
    this.echoDelay.connect(this.post);
    // Reverb: envío post-filtro a un convolver con una respuesta generada (sala grande).
    const conv = new ConvolverNode(ctx, { buffer: makeImpulse(ctx, 2.8), disableNormalization: false });
    this.lp.connect(this.revWet).connect(conv).connect(this.post);
    // Flanger: retardo muy corto modulado por un LFO al tempo, mezclado con el original.
    this.lp.connect(this.flDelay).connect(this.flWet).connect(this.post);
    const flFb = new GainNode(ctx, { gain: 0.55 });
    this.flDelay.connect(flFb).connect(this.flDelay);
    // Gate (trance gate) entre el canal y el fader.
    this.post.connect(this.gate).connect(this.fader).connect(this.xf).connect(master);
    this.xf.connect(this.analyser);
    this.post.connect(this.pfl).connect(cue);
  }

  private set(param: AudioParam, value: number, tc = 0.015): void {
    param.setTargetAtTime(value, this.ctx.currentTime, tc);
  }

  /** dB de EQ en el rango [-40, +6]; -40 equivale a "kill". */
  setEq(band: 'low' | 'mid' | 'high', db: number): void {
    const v = Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, db));
    this.set(this[band].gain, v);
  }

  /** Filtro bipolar: -1 = pasa bajos cerrado, 0 = sin filtro, +1 = pasa altos abierto al máximo. */
  setFilter(x: number): void {
    const v = Math.max(-1, Math.min(1, x));
    const lpHz = v < -0.02 ? 20000 * Math.pow(150 / 20000, -v) : 22000;
    const hpHz = v > 0.02 ? 15 * Math.pow(6000 / 15, v) : 10;
    this.set(this.lp.frequency, lpHz, 0.03);
    this.set(this.hp.frequency, hpHz, 0.03);
  }

  setEcho(on: boolean, delaySec: number): void {
    this.set(this.echoDelay.delayTime, Math.min(3.9, delaySec), 0.005);
    this.set(this.echoWet.gain, on ? 0.6 : 0, 0.02);
  }

  setReverb(on: boolean): void {
    this.set(this.revWet.gain, on ? 0.55 : 0, on ? 0.02 : 0.4);
  }

  /** Flanger con un ciclo de LFO de `cycleSec` (p. ej. 2 compases). */
  setFlanger(on: boolean, cycleSec: number): void {
    const t = this.ctx.currentTime;
    if (on) {
      if (!this.flLfo) {
        this.flLfo = new OscillatorNode(this.ctx, { type: 'triangle', frequency: 1 / cycleSec });
        this.flLfo.connect(this.flDepth).connect(this.flDelay.delayTime);
        this.flLfo.start();
      } else this.flLfo.frequency.setValueAtTime(1 / cycleSec, t);
    } else if (this.flLfo) {
      const lfo = this.flLfo;
      this.flLfo = null;
      lfo.stop(t + 0.3);
    }
    this.set(this.flWet.gain, on ? 0.8 : 0, 0.05);
  }

  /** Trance gate: corta y abre el sonido cada `stepSec`; arranca alineado en `startAt`. */
  setGate(on: boolean, stepSec: number, startAt: number): void {
    this.gateLfo?.stop();
    this.gateLfo?.disconnect();
    this.gateAmt?.disconnect();
    this.gateLfo = null;
    this.gateAmt = null;
    const t = this.ctx.currentTime;
    this.gate.gain.cancelScheduledValues(t);
    if (!on) {
      this.gate.gain.setTargetAtTime(1, t, 0.005);
      return;
    }
    // Onda cuadrada (−1..1) × 0.5 + 0.5 → 0..1, con el flanco alineado al beat.
    this.gate.gain.setValueAtTime(0.5, Math.max(t, startAt));
    this.gateLfo = new OscillatorNode(this.ctx, { type: 'square', frequency: 1 / (2 * stepSec) });
    this.gateAmt = new GainNode(this.ctx, { gain: 0.5 });
    this.gateLfo.connect(this.gateAmt).connect(this.gate.gain);
    this.gateLfo.start(Math.max(t, startAt));
  }

  setFader(v: number): void {
    // Curva cuadrática, más natural al oído que lineal.
    this.set(this.fader.gain, v * v);
  }

  setXf(g: number): void {
    this.set(this.xf.gain, g, 0.008);
  }

  setPfl(on: boolean): void {
    this.set(this.pfl.gain, on ? 1 : 0);
  }

  /** Nivel pico post-fader (0..1) para el vúmetro. */
  level(buf: Float32Array<ArrayBuffer>): number {
    this.analyser.getFloatTimeDomainData(buf);
    let m = 0;
    for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
    return m;
  }
}

/** Respuesta al impulso sintética para la reverb: ruido estéreo con caída exponencial. */
function makeImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3.2);
  }
  return buf;
}

/** Ganancias del crossfader con curva de potencia constante. x = -1 (todo A) .. +1 (todo B). */
export function crossfaderGains(x: number): [number, number] {
  const t = (Math.max(-1, Math.min(1, x)) + 1) / 2;
  return [Math.cos((t * Math.PI) / 2), Math.sin((t * Math.PI) / 2)];
}

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly masterBus: GainNode;
  readonly cueBus: GainNode;
  readonly masterGain: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly masterAnalyser: AnalyserNode;
  readonly phonesCue: GainNode;
  readonly phonesMaster: GainNode;
  readonly phones: GainNode;
  readonly strips: { A: ChannelStrip; B: ChannelStrip };
  /** Bus del sampler: va al master (después del crossfader). */
  readonly samplerBus: GainNode;
  settings: AudioSettings;
  phonesStatus = '';
  private ready: Promise<void>;
  private phonesStream: MediaStreamAudioDestinationNode | null = null;
  private phonesEl: HTMLAudioElement | null = null;
  private merger: ChannelMergerNode | null = null;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.settings = loadAudioSettings();
    this.masterBus = this.ctx.createGain();
    this.cueBus = this.ctx.createGain();
    this.masterGain = new GainNode(this.ctx, { gain: 0.8 });
    this.limiter = new DynamicsCompressorNode(this.ctx, { threshold: -1.5, knee: 0, ratio: 20, attack: 0.002, release: 0.12 });
    this.masterAnalyser = new AnalyserNode(this.ctx, { fftSize: 512 });
    this.phonesCue = new GainNode(this.ctx, { gain: 1 });
    this.phonesMaster = new GainNode(this.ctx, { gain: 0 });
    this.phones = new GainNode(this.ctx, { gain: 0.8 });

    this.masterBus.connect(this.masterGain).connect(this.limiter).connect(this.masterAnalyser);
    this.cueBus.connect(this.phonesCue).connect(this.phones);
    this.limiter.connect(this.phonesMaster).connect(this.phones);

    this.strips = {
      A: new ChannelStrip(this.ctx, this.masterBus, this.cueBus),
      B: new ChannelStrip(this.ctx, this.masterBus, this.cueBus),
    };
    this.samplerBus = new GainNode(this.ctx, { gain: 0.7 });
    this.samplerBus.connect(this.masterBus);
    this.ready = this.ctx.audioWorklet.addModule(processorUrl);
    this.ctx.addEventListener('statechange', () => this.listeners.forEach((l) => l()));
  }

  private listeners = new Set<() => void>();
  onChange(cb: () => void): void {
    this.listeners.add(cb);
  }

  async whenReady(): Promise<void> {
    await this.ready;
    await this.applyOutputs();
  }

  /** El navegador exige un gesto del usuario para arrancar el audio. */
  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  async createDeckNode(): Promise<AudioWorkletNode> {
    await this.ready;
    return new AudioWorkletNode(this.ctx, 'deck-processor', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  }

  setMasterVolume(v: number): void {
    this.masterGain.gain.setTargetAtTime(v * v * 1.2, this.ctx.currentTime, 0.015);
  }

  /** 0 = sólo cue, 1 = sólo master. */
  setCueMix(v: number): void {
    const t = this.ctx.currentTime;
    this.phonesCue.gain.setTargetAtTime(Math.cos((v * Math.PI) / 2), t, 0.015);
    this.phonesMaster.gain.setTargetAtTime(Math.sin((v * Math.PI) / 2), t, 0.015);
  }

  setPhonesVolume(v: number): void {
    this.phones.gain.setTargetAtTime(v * v * 1.2, this.ctx.currentTime, 0.015);
  }

  get maxChannels(): number {
    return this.ctx.destination.maxChannelCount;
  }

  get canChooseMasterDevice(): boolean {
    return 'setSinkId' in AudioContext.prototype;
  }

  async updateSettings(patch: Partial<AudioSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    saveAudioSettings(this.settings);
    await this.applyOutputs();
  }

  private async applyOutputs(): Promise<void> {
    const ctx = this.ctx;
    const s = this.settings;
    // Dispositivo master
    if (this.canChooseMasterDevice) {
      try {
        const sink = (ctx as AudioContext & { sinkId?: string }).sinkId ?? '';
        if (sink !== s.masterDevice) await (ctx as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(s.masterDevice);
      } catch (e) {
        console.warn('setSinkId master falló', e);
      }
    }
    // Desconectar ruteo anterior
    try {
      this.limiter.disconnect(ctx.destination);
    } catch {
      /* no estaba conectado */
    }
    this.merger?.disconnect();
    this.merger = null;
    try {
      this.phones.disconnect();
    } catch {
      /* ignorar */
    }
    if (this.phonesEl) {
      this.phonesEl.pause();
      this.phonesEl.srcObject = null;
      this.phonesEl = null;
    }

    if (s.mode === 'quad' && ctx.destination.maxChannelCount >= 4) {
      // Interfaz de 4 canales (p. ej. la placa del DJ2GO2): master en 1-2, auriculares en 3-4.
      ctx.destination.channelCount = 4;
      ctx.destination.channelCountMode = 'explicit';
      ctx.destination.channelInterpretation = 'discrete';
      const merger = new ChannelMergerNode(ctx, { numberOfInputs: 4 });
      const splitM = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
      const splitP = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
      this.limiter.connect(splitM);
      this.phones.connect(splitP);
      splitM.connect(merger, 0, 0);
      splitM.connect(merger, 1, 1);
      splitP.connect(merger, 0, 2);
      splitP.connect(merger, 1, 3);
      merger.connect(ctx.destination);
      this.merger = merger;
      this.phonesStatus = 'Auriculares en las salidas 3-4 de la placa.';
      return;
    }

    ctx.destination.channelCount = Math.min(2, ctx.destination.maxChannelCount);
    ctx.destination.channelInterpretation = 'speakers';
    this.limiter.connect(ctx.destination);
    if (s.mode === 'quad') this.phonesStatus = `La salida elegida tiene ${ctx.destination.maxChannelCount} canales: el modo 4 canales no está disponible.`;
    else this.phonesStatus = '';

    if (s.phonesDevice) {
      // Preescucha en otro dispositivo vía <audio>.setSinkId (Chrome / Edge).
      this.phonesStream ??= ctx.createMediaStreamDestination();
      this.phones.connect(this.phonesStream);
      const el = new Audio();
      el.srcObject = this.phonesStream.stream;
      try {
        await (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(s.phonesDevice);
        await el.play();
        this.phonesEl = el;
        this.phonesStatus ||= 'Preescucha activa en el dispositivo elegido.';
      } catch (e) {
        this.phonesStatus = `No pude usar ese dispositivo para auriculares: ${String(e)}`;
      }
    } else if (!this.phonesStatus) {
      this.phonesStatus = 'Sin salida de auriculares: elegí un dispositivo para la preescucha.';
    }
  }

  async listOutputDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audiooutput');
  }

  /** Chrome oculta los nombres de los dispositivos hasta que se da permiso de micrófono. */
  async unlockDeviceLabels(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  }

  /** Estima la posición de un reporte del worklet al tiempo actual del contexto. */
  now(): number {
    return this.ctx.currentTime;
  }
}
