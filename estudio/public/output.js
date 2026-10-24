// Salidas: grabar en la PC y transmitir (el navegador manda WebM al servidor y ffmpeg lo reparte a cada plataforma).
import { state, live, canvasSize, emit } from './state.js';
import { programCanvas } from './render.js';
import { dest } from './audio.js';
import { net } from './net.js';

let outStream = null;
function outputStream() {
  if (!outStream) {
    outStream = new MediaStream([...programCanvas.captureStream(state.settings.fps).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  }
  return outStream;
}

const pick = (list) => list.find((t) => MediaRecorder.isTypeSupported(t));

// ---------- Grabación ----------

let recorder = null;
let writable = null;
let chunks = [];
let recStart = 0;

export async function startRecording() {
  if (recorder) return;
  const mime = pick(['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm']);
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  const name = `transmision_${stamp}.${ext}`;
  writable = null;
  chunks = [];
  // Si se puede, escribimos directo al disco: una charla de 2 horas no entra en memoria.
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Video', accept: { [mime.split(';')[0]]: [`.${ext}`] } }] });
      writable = await handle.createWritable();
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  recorder = new MediaRecorder(outputStream(), { mimeType: mime, videoBitsPerSecond: state.settings.recKbps * 1000, audioBitsPerSecond: 192000 });
  let pending = Promise.resolve();
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    if (writable) pending = pending.then(() => writable.write(e.data));
    else chunks.push(e.data);
  };
  recorder.onstop = async () => {
    if (writable) {
      await pending;
      await writable.close();
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(chunks, { type: mime }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
    chunks = [];
    emit('toast', `Grabación guardada: ${name}`);
  };
  recorder.start(1000);
  recStart = Date.now();
  live.recording = true;
  emit('output');
}

export function stopRecording() {
  if (!recorder) return;
  recorder.stop();
  recorder = null;
  live.recording = false;
  emit('output');
}

export const recordingSeconds = () => (live.recording ? (Date.now() - recStart) / 1000 : 0);

// ---------- Transmisión ----------

export const PLATFORMS = {
  youtube: { name: 'YouTube', server: 'rtmp://a.rtmp.youtube.com/live2', help: 'YouTube Studio → Crear → Transmitir en vivo → copiá la "Clave de transmisión".' },
  twitch: { name: 'Twitch', server: 'rtmp://live.twitch.tv/app', help: 'Twitch → Panel de control del creador → Configuración → Transmisión → "Clave de transmisión principal".' },
  facebook: { name: 'Facebook', server: 'rtmps://live-api-s.facebook.com:443/rtmp', help: 'Facebook → Video en vivo (Live Producer) → "Usar clave de transmisión" → copiá la clave.' },
  instagram: { name: 'Instagram', server: '', vertical: true, help: 'Instagram en la web → Crear → En vivo: te da "URL de transmisión" y "Clave". Pegá las dos. Instagram es vertical.' },
  tiktok: { name: 'TikTok', server: '', vertical: true, help: 'TikTok LIVE Studio / LIVE Center → "Clave de transmisión": copiá "URL del servidor" y "Clave". Solo para cuentas con acceso a LIVE. Es vertical.' },
  custom: { name: 'Otro (RTMP)', server: '', help: 'Cualquier servidor RTMP o RTMPS: pegá la URL del servidor y la clave.' },
};

export function destinationUrl(d) {
  const server = (d.server || PLATFORMS[d.platform]?.server || '').trim().replace(/\/+$/, '');
  const key = (d.key || '').trim();
  return key ? `${server}/${key}` : server;
}

let streamer = null;
let streamStart = 0;
export const streamStats = { fps: '', kbps: '', speed: '', state: 'off', msg: '', log: [] };

export function startStreaming() {
  if (streamer) return;
  const destinations = state.destinations
    .filter((d) => d.enabled && destinationUrl(d).match(/^rtmps?:\/\/.+\/.+/))
    .map((d) => ({ url: destinationUrl(d), vertical: !!d.vertical }));
  if (!destinations.length) {
    emit('toast', 'Agregá al menos un destino con su clave en la pestaña Transmisión.');
    return false;
  }
  if (!net.connected) {
    emit('toast', 'No hay conexión con el servidor del estudio (¿está abierto "npm start"?).');
    return false;
  }
  const { w, h } = canvasSize();
  net.send({ t: 'stream-start', cfg: { width: w, height: h, fps: state.settings.fps, kbps: state.settings.kbps, destinations } });
  const mime = pick(['video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
  // Al servidor local le mandamos buena calidad: ffmpeg recomprime a lo que pide cada plataforma.
  streamer = new MediaRecorder(outputStream(), { mimeType: mime, videoBitsPerSecond: Math.max(6000, state.settings.kbps * 2) * 1000, audioBitsPerSecond: 192000 });
  streamer.ondataavailable = async (e) => {
    if (e.data.size) net.sendBinary(await e.data.arrayBuffer());
  };
  streamer.start(250);
  streamStart = Date.now();
  live.streaming = true;
  Object.assign(streamStats, { state: 'starting', msg: '', log: [] });
  emit('output');
  return true;
}

export function stopStreaming() {
  if (!streamer) return;
  streamer.stop();
  streamer = null;
  setTimeout(() => net.send({ t: 'stream-stop' }), 400);
  live.streaming = false;
  emit('output');
}

export const streamingSeconds = () => (live.streaming ? (Date.now() - streamStart) / 1000 : 0);

net.on('stream-status', (m) => {
  streamStats.state = m.state;
  streamStats.msg = m.msg ?? '';
  if (m.encoder) streamStats.encoder = m.encoder;
  if (m.state === 'error' && streamer) {
    streamer.stop();
    streamer = null;
    live.streaming = false;
    emit('toast', m.msg);
  }
  emit('output');
});
net.on('stream-stats', (m) => {
  Object.assign(streamStats, { fps: m.fps, kbps: m.kbps, speed: m.speed });
  emit('stream-stats');
});
net.on('stream-log', (m) => {
  streamStats.log = [...streamStats.log.slice(-30), m.line];
  emit('stream-stats');
});
