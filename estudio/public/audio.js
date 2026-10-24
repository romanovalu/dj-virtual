// Mezclador: cada fuente con sonido entra a un canal (volumen, silencio, vúmetro) y todo sale por el master.
import { state, save, emit } from './state.js';
import { sources } from './sources.js';

export const ctx = new AudioContext({ latencyHint: 'playback', sampleRate: 48000 });
export const master = ctx.createGain();
const masterMeter = ctx.createAnalyser();
export const dest = ctx.createMediaStreamDestination();
master.connect(masterMeter);
master.connect(dest);
masterMeter.fftSize = 1024;

/** @type {Map<string, {input: AudioNode, gain: GainNode, meter: AnalyserNode, key: any}>} */
export const channels = new Map();
/** Las fuentes de video de archivo solo pueden conectarse una vez a Web Audio. */
const elementNodes = new WeakMap();

export function resume() {
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
}

export function channelSettings(id) {
  if (!state.audio[id]) {
    const s = sources.get(id);
    // Los celulares arrancan silenciados para evitar acoples; el resto, abierto.
    state.audio[id] = { gain: 1, muted: s?.kind === 'phone', fader: '' };
  }
  return state.audio[id];
}

function audioInputFor(s) {
  if (s.kind === 'video' && s.el) {
    let node = elementNodes.get(s.el);
    if (!node) {
      node = ctx.createMediaElementSource(s.el);
      elementNodes.set(s.el, node);
    }
    return { node, key: s.el };
  }
  const track = s.stream?.getAudioTracks()[0];
  if (!track || track.readyState === 'ended') return null;
  return { node: ctx.createMediaStreamSource(new MediaStream([track])), key: track };
}

/** Crea, rehace o borra canales según las fuentes que hay ahora. */
export function syncChannels() {
  for (const [id, ch] of channels) {
    const s = sources.get(id);
    const track = s?.stream?.getAudioTracks()[0];
    const stillValid = s && (s.kind === 'video' ? ch.key === s.el : ch.key === track && track.readyState !== 'ended');
    if (!stillValid) {
      ch.input.disconnect();
      ch.gain.disconnect();
      channels.delete(id);
    }
  }
  for (const s of sources.values()) {
    if (channels.has(s.id) || !s.online) continue;
    const inp = audioInputFor(s);
    if (!inp) continue;
    const gain = ctx.createGain();
    const meter = ctx.createAnalyser();
    meter.fftSize = 1024;
    inp.node.connect(gain);
    gain.connect(meter);
    gain.connect(master);
    channels.set(s.id, { input: inp.node, gain, meter, key: inp.key });
    applyGain(s.id);
  }
  emit('mixer');
}

export function applyGain(id) {
  const ch = channels.get(id);
  if (!ch) return;
  const st = channelSettings(id);
  ch.gain.gain.setTargetAtTime(st.muted ? 0 : st.gain * st.gain, ctx.currentTime, 0.03);
}

export function setGain(id, v) {
  channelSettings(id).gain = v;
  applyGain(id);
  save();
  emit('mixer-values');
}

export function setMuted(id, muted) {
  channelSettings(id).muted = muted;
  applyGain(id);
  save();
  emit('mixer-values');
}

export function setMaster(v) {
  state.master.gain = v;
  master.gain.setTargetAtTime(v * v, ctx.currentTime, 0.03);
  save();
  emit('mixer-values');
}
setMaster(state.master.gain);

/** Fader del DJ2GO2 (A, B o master) a 0..1. */
export function faderMoved(which, v) {
  if (which === 'M') return setMaster(v);
  for (const [id, st] of Object.entries(state.audio)) if (st.fader === which) setGain(id, v);
}

const buf = new Float32Array(1024);
/** Nivel en 0..1 (escala aproximada en dB, -60 a 0). */
export function level(id) {
  const an = id === 'master' ? masterMeter : channels.get(id)?.meter;
  if (!an) return 0;
  an.getFloatTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const db = 20 * Math.log10(peak || 1e-6);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}
