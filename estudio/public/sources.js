// Fuentes de video y audio: webcams, micrófonos, pantalla/pestaña, imágenes, videos y celulares por WiFi.
import { state, save, emit, uid } from './state.js';
import { net } from './net.js';

/**
 * @typedef {{ id: string, kind: 'webcam'|'mic'|'screen'|'image'|'video'|'phone', label: string,
 *   el: HTMLVideoElement|HTMLImageElement|null, stream: MediaStream|null, online: boolean, error?: string }} Source
 */

/** @type {Map<string, Source>} */
export const sources = new Map();

const VIDEO_KINDS = new Set(['webcam', 'screen', 'image', 'video', 'phone']);
export const hasVideo = (s) => VIDEO_KINDS.has(s.kind);
export const KIND_LABEL = { webcam: 'Webcam', mic: 'Micrófono', screen: 'Pantalla', image: 'Imagen', video: 'Video', phone: 'Celular' };

function videoEl(stream) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.autoplay = true;
  v.srcObject = stream;
  v.play().catch(() => {});
  return v;
}

function put(src) {
  sources.set(src.id, src);
  emit('sources');
}

function persistDef(def) {
  const i = state.sourceDefs.findIndex((d) => d.id === def.id);
  if (i >= 0) state.sourceDefs[i] = def;
  else state.sourceDefs.push(def);
  save();
}

function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

export function removeSource(id) {
  const s = sources.get(id);
  if (s) {
    if (s.kind !== 'phone') stopStream(s.stream);
    if (s.el instanceof HTMLVideoElement) s.el.srcObject = null;
  }
  sources.delete(id);
  state.sourceDefs = state.sourceDefs.filter((d) => d.id !== id);
  for (const sc of state.scenes) {
    if (sc.a === id) sc.a = null;
    if (sc.b === id) sc.b = null;
  }
  delete state.audio[id];
  save();
  emit('sources');
  emit('scenes');
}

export function renameSource(id, label) {
  const s = sources.get(id);
  if (!s) return;
  s.label = label;
  const d = state.sourceDefs.find((x) => x.id === id);
  if (d) {
    d.label = label;
    d.renamed = true;
  }
  save();
  emit('sources');
}

// ---------- Dispositivos ----------

export async function listDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    cams: all.filter((d) => d.kind === 'videoinput'),
    mics: all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'),
  };
}

/** Pide permiso una vez para que enumerateDevices devuelva nombres. */
export async function ensureDeviceLabels(kind) {
  const { cams, mics } = await listDevices();
  const list = kind === 'video' ? cams : mics;
  if (list.length && list.every((d) => !d.label)) {
    const s = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { video: true } : { audio: true });
    stopStream(s);
  }
}

async function openWebcam(def) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: def.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  return stream;
}

async function openMic(def) {
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: def.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
    video: false,
  });
}

export async function addWebcam(deviceId, label) {
  const def = { id: `cam:${deviceId}`, kind: 'webcam', deviceId, label: label || 'Webcam' };
  const stream = await openWebcam(def);
  persistDef(def);
  put({ id: def.id, kind: 'webcam', label: def.label, el: videoEl(stream), stream, online: true });
}

export async function addMic(deviceId, label) {
  const def = { id: `mic:${deviceId}`, kind: 'mic', deviceId, label: label || 'Micrófono' };
  const stream = await openMic(def);
  persistDef(def);
  put({ id: def.id, kind: 'mic', label: def.label, el: null, stream, online: true });
}

export async function addScreen() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30 } },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
  });
  const track = stream.getVideoTracks()[0];
  const id = `screen:${uid()}`;
  const label = track?.label?.slice(0, 40) || 'Pantalla';
  put({ id, kind: 'screen', label, el: videoEl(stream), stream, online: true });
  track?.addEventListener('ended', () => {
    const s = sources.get(id);
    if (s) {
      s.online = false;
      s.stream = null;
      emit('sources');
    }
  });
  return id;
}

export function addImage(dataUrl, label) {
  const def = { id: `img:${uid()}`, kind: 'image', dataUrl, label: label || 'Imagen' };
  persistDef(def);
  openImage(def);
  return def.id;
}

function openImage(def) {
  const img = new Image();
  img.src = def.dataUrl;
  put({ id: def.id, kind: 'image', label: def.label, el: img, stream: null, online: true });
}

export function addVideoFile(file) {
  const v = document.createElement('video');
  v.src = URL.createObjectURL(file);
  v.loop = true;
  v.playsInline = true;
  // El audio sale por el mezclador (createMediaElementSource), no por los parlantes.
  v.play().catch(() => {});
  const id = `vid:${uid()}`;
  put({ id, kind: 'video', label: file.name.replace(/\.[^.]+$/, '').slice(0, 40), el: v, stream: null, online: true });
  return id;
}

/** Vuelve a abrir las fuentes guardadas (los permisos ya dados no se piden de nuevo). */
export async function restoreSources() {
  for (const def of state.sourceDefs) {
    if (def.kind === 'image') {
      openImage(def);
      continue;
    }
    if (def.kind === 'phone') {
      put({ id: def.id, kind: 'phone', label: def.label, el: videoEl(null), stream: null, online: false });
      continue;
    }
    const src = { id: def.id, kind: def.kind, label: def.label, el: null, stream: null, online: false };
    put(src);
    reopen(def.id);
  }
}

export async function reopen(id) {
  const def = state.sourceDefs.find((d) => d.id === id);
  const src = sources.get(id);
  if (!def || !src) return;
  try {
    const stream = def.kind === 'webcam' ? await openWebcam(def) : await openMic(def);
    stopStream(src.stream);
    src.stream = stream;
    if (def.kind === 'webcam') src.el = videoEl(stream);
    src.online = true;
    src.error = undefined;
  } catch (e) {
    src.online = false;
    src.error = e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? 'No está conectada' : e.message;
  }
  emit('sources');
}

// ---------- Celulares (WebRTC) ----------

/** @type {Map<string, RTCPeerConnection>} */
const peers = new Map();

function phoneSource(camId, name) {
  const id = `phone:${camId}`;
  let src = sources.get(id);
  if (!src) {
    src = { id, kind: 'phone', label: name, el: videoEl(null), stream: null, online: false };
    persistDef({ id, kind: 'phone', label: name });
    put(src);
  }
  return src;
}

function closePeer(camId) {
  peers.get(camId)?.close();
  peers.delete(camId);
}

net.on('cams', (msg) => msg.list.forEach((c) => phoneSource(c.id, c.name)));
net.on('cam-join', (msg) => {
  const src = phoneSource(msg.id, msg.name);
  if (src.label !== msg.name && !state.sourceDefs.find((d) => d.id === src.id)?.renamed) src.label = msg.name;
  src.tally = undefined;
  emit('sources');
});
net.on('cam-leave', (msg) => {
  closePeer(msg.id);
  const src = sources.get(`phone:${msg.id}`);
  if (src) {
    src.online = false;
    emit('sources');
  }
});

net.on('signal', async ({ from, data }) => {
  if (data.sdp?.type === 'offer') {
    closePeer(from);
    const pc = new RTCPeerConnection({ iceServers: [] });
    peers.set(from, pc);
    pc.onicecandidate = (e) => e.candidate && net.send({ t: 'signal', to: from, data: { candidate: e.candidate.toJSON() } });
    pc.ontrack = (e) => {
      const src = phoneSource(from, 'Celular');
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      if (src.stream !== stream) {
        src.stream = stream;
        src.el.srcObject = stream;
        src.el.play().catch(() => {});
      }
      src.online = true;
      emit('sources');
    };
    pc.onconnectionstatechange = () => {
      const src = sources.get(`phone:${from}`);
      if (src && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) {
        src.online = false;
        emit('sources');
      }
    };
    await pc.setRemoteDescription(data.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    net.send({ t: 'signal', to: from, data: { sdp: pc.localDescription } });
  } else if (data.candidate) {
    await peers.get(from)?.addIceCandidate(data.candidate).catch(() => {});
  }
});

/** Avisa a cada celular si está al aire (rojo), en vista previa (verde) o libre. */
export function sendTally(programIds, previewIds) {
  for (const s of sources.values()) {
    if (s.kind !== 'phone') continue;
    const camId = s.id.slice('phone:'.length);
    const st = programIds.has(s.id) ? 'program' : previewIds.has(s.id) ? 'preview' : 'off';
    if (s.tally !== st) {
      s.tally = st;
      net.send({ t: 'tally', to: camId, state: st });
    }
  }
}
