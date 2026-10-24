// Estado del estudio. Lo que se guarda (escenas, gráficos, destinos) vive en localStorage;
// lo que es del momento (escena al aire, transición) vive en `live`.
import { newMatch } from './padel.mjs';

const KEY = 'estudio.v1';

export const uid = () => Math.random().toString(36).slice(2, 10);

function defaults() {
  return {
    settings: { res: 720, vertical: false, fps: 30, kbps: 3500, recKbps: 8000, sceneClick: 'fade' },
    sourceDefs: [], // webcam, mic, image, phone
    scenes: [
      { id: uid(), name: 'Cámara 1', layout: 'full', a: null, b: null, corner: 'br', text: '', color: '#1d3557' },
      { id: uid(), name: 'Cámara 2', layout: 'full', a: null, b: null, corner: 'br', text: '', color: '#1d3557' },
      { id: uid(), name: 'Cámara + ventana', layout: 'pip', a: null, b: null, corner: 'br', text: '', color: '#1d3557' },
      { id: uid(), name: 'Ya volvemos', layout: 'slate', a: null, b: null, corner: 'br', text: 'Ya volvemos', color: '#1d3557' },
    ],
    score: { visible: false, match: newMatch(), history: [] },
    lower: { visible: false, title: 'Nombre Apellido', subtitle: 'Cargo o descripción', color: '#e63946', autoHide: 8 },
    logo: { visible: false, dataUrl: '', corner: 'tr', size: 0.12 },
    ticker: { visible: false, text: '' },
    audio: {}, // sourceId -> { gain, muted, fader }
    master: { gain: 1 },
    destinations: [],
  };
}

function load() {
  const base = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      for (const k of Object.keys(base)) if (saved[k] !== undefined) base[k] = k === 'settings' ? { ...base.settings, ...saved.settings } : saved[k];
    }
  } catch {
    /* sin storage: arrancamos con lo de fábrica */
  }
  return base;
}

export const state = load();

export const live = {
  program: state.scenes[0]?.id ?? null,
  preview: state.scenes[1]?.id ?? state.scenes[0]?.id ?? null,
  /** Transición en curso: t va de 0 (programa) a 1 (vista previa). */
  trans: null,
  /** Punta donde quedó apoyada la palanca (0 o 1); null hasta que toque una. */
  tbarParked: null,
  lowerShownAt: 0,
  recording: false,
  streaming: false,
};

let timer = 0;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('No se pudo guardar', e);
    }
  }, 300);
}

const bus = new EventTarget();
export function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}
export function on(name, cb) {
  bus.addEventListener(name, (e) => cb(e.detail));
}

export function canvasSize() {
  const h = state.settings.res;
  const w = Math.round((h * 16) / 9);
  return state.settings.vertical ? { w: h, h: w } : { w, h };
}

export const sceneById = (id) => state.scenes.find((s) => s.id === id);
