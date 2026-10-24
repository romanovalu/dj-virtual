// Dibujo de formas de onda: vista con zoom (grilla de beats, compases y frases) y vista general.
import { beatIndex, beatTime, type Analysis, type Waveform } from '../library';

export interface WaveMarks {
  pos: number;
  duration: number;
  cue: number;
  hotcues: (number | null)[];
  loop: { on: boolean; start: number; end: number };
  accent: string;
}

const LOW = [40, 120, 255];
const MID = [255, 165, 40];
const HIGH = [235, 245, 255];
const HOT_COLORS = ['#ff4d6d', '#3ddc84', '#ffcc4d', '#b88cff'];

function fitCanvas(c: HTMLCanvasElement): { w: number; h: number; ctx: CanvasRenderingContext2D } {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return { w, h, ctx: c.getContext('2d')! };
}

/** Colorea una columna según el balance de bandas (graves azules, medios ámbar, agudos blancos). */
function columnColor(lo: number, mi: number, hi: number, bright: number): [number, number, number] {
  const s = lo + mi + hi + 1e-6;
  const r = (LOW[0] * lo + MID[0] * mi + HIGH[0] * hi) / s;
  const g = (LOW[1] * lo + MID[1] * mi + HIGH[1] * hi) / s;
  const b = (LOW[2] * lo + MID[2] * mi + HIGH[2] * hi) / s;
  const k = 0.55 + 0.45 * bright;
  return [r * k, g * k, b * k];
}

function drawColumns(img: ImageData, wf: Waveform, t0: number, secPerPx: number, w: number, h: number, dimBefore: number): void {
  const data = img.data;
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const ta = t0 + x * secPerPx;
    const tb = ta + secPerPx;
    let i0 = Math.floor(ta * wf.rate);
    let i1 = Math.max(i0 + 1, Math.floor(tb * wf.rate));
    if (i1 <= 0 || i0 >= wf.amp.length) continue;
    i0 = Math.max(0, i0);
    i1 = Math.min(wf.amp.length, i1);
    let a = 0;
    let lo = 0;
    let mi = 0;
    let hi = 0;
    for (let i = i0; i < i1; i++) {
      if (wf.amp[i] > a) a = wf.amp[i];
      if (wf.low[i] > lo) lo = wf.low[i];
      if (wf.mid[i] > mi) mi = wf.mid[i];
      if (wf.high[i] > hi) hi = wf.high[i];
    }
    const half = Math.max(1, a * mid * 0.95);
    let [r, g, b] = columnColor(lo, mi, hi, a);
    if (ta < dimBefore) {
      r *= 0.45;
      g *= 0.45;
      b *= 0.45;
    }
    const y0 = Math.max(0, Math.floor(mid - half));
    const y1 = Math.min(h - 1, Math.ceil(mid + half));
    for (let y = y0; y <= y1; y++) {
      const o = (y * w + x) * 4;
      // Núcleo más brillante cerca del centro
      const core = 1 - (Math.abs(y - mid) / half) * 0.35;
      data[o] = r * core;
      data[o + 1] = g * core;
      data[o + 2] = b * core;
      data[o + 3] = 255;
    }
  }
}

export function drawZoom(c: HTMLCanvasElement, wf: Waveform | undefined, a: Analysis | undefined, m: WaveMarks, span = 8): void {
  const { w, h, ctx } = fitCanvas(c);
  ctx.fillStyle = '#0b0d11';
  ctx.fillRect(0, 0, w, h);
  if (!wf || !m.duration) {
    ctx.fillStyle = '#2b303b';
    ctx.fillRect(0, h / 2, w, 1);
    return;
  }
  const secPerPx = span / w;
  const t0 = m.pos - span / 2;
  const t1 = t0 + span;
  const xOf = (t: number) => (t - t0) / secPerPx;

  if (m.loop.on) {
    ctx.fillStyle = 'rgba(61,220,132,0.12)';
    ctx.fillRect(xOf(m.loop.start), 0, xOf(m.loop.end) - xOf(m.loop.start), h);
  }
  const img = ctx.getImageData(0, 0, w, h);
  drawColumns(img, wf, t0, secPerPx, w, h, m.pos);
  ctx.putImageData(img, 0, 0);

  // Beatgrid: beats finos, compases más marcados, frases de 16 compases destacadas.
  if (a) {
    const bStart = Math.ceil(beatIndex(a, t0));
    const bEnd = Math.floor(beatIndex(a, t1));
    for (let b = bStart; b <= bEnd; b++) {
      const x = Math.round(xOf(beatTime(a, b))) + 0.5;
      const rel = b - a.downbeat;
      const isBar = ((rel % 4) + 4) % 4 === 0;
      const isPhrase = ((rel % 64) + 64) % 64 === 0;
      ctx.strokeStyle = isPhrase ? 'rgba(255,90,106,0.95)' : isBar ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.18)';
      ctx.lineWidth = isPhrase ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, isBar ? h : h * 0.15);
      if (!isBar) {
        ctx.moveTo(x, h * 0.85);
        ctx.lineTo(x, h);
      }
      ctx.stroke();
    }
  }
  // Cue y hot cues
  const mark = (t: number, color: string, label: string) => {
    if (t < t0 || t > t1) return;
    const x = xOf(t);
    ctx.fillStyle = color;
    ctx.fillRect(x - 1, 0, 2, h);
    ctx.beginPath();
    ctx.moveTo(x - 6, 0);
    ctx.lineTo(x + 6, 0);
    ctx.lineTo(x, 9);
    ctx.fill();
    ctx.font = `${Math.round(h * 0.13)}px system-ui`;
    ctx.fillText(label, x + 4, h - 4);
  };
  mark(m.cue, '#ffcc4d', 'CUE');
  m.hotcues.forEach((t, i) => t != null && mark(t, HOT_COLORS[i], String(i + 1)));
  // Cabezal
  ctx.fillStyle = m.accent;
  ctx.fillRect(Math.round(w / 2) - 1, 0, 2, h);
}

const overviewCache = new WeakMap<Waveform, HTMLCanvasElement>();

export function drawOverview(c: HTMLCanvasElement, wf: Waveform | undefined, m: WaveMarks): void {
  const { w, h, ctx } = fitCanvas(c);
  ctx.fillStyle = '#0b0d11';
  ctx.fillRect(0, 0, w, h);
  if (!wf || !m.duration) return;
  let img = overviewCache.get(wf);
  if (!img || img.width !== w || img.height !== h) {
    img = document.createElement('canvas');
    img.width = w;
    img.height = h;
    const octx = img.getContext('2d')!;
    const data = octx.createImageData(w, h);
    drawColumns(data, wf, 0, m.duration / w, w, h, -1);
    octx.putImageData(data, 0, 0);
    overviewCache.set(wf, img);
  }
  ctx.drawImage(img, 0, 0);
  const xp = (m.pos / m.duration) * w;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, 0, xp, h);
  if (m.loop.on) {
    ctx.fillStyle = 'rgba(61,220,132,0.35)';
    ctx.fillRect((m.loop.start / m.duration) * w, 0, Math.max(2, ((m.loop.end - m.loop.start) / m.duration) * w), h);
  }
  ctx.fillStyle = '#ffcc4d';
  ctx.fillRect((m.cue / m.duration) * w, 0, 2, h);
  m.hotcues.forEach((t, i) => {
    if (t == null) return;
    ctx.fillStyle = HOT_COLORS[i];
    ctx.fillRect((t / m.duration) * w, 0, 2, h * 0.5);
  });
  ctx.fillStyle = m.accent;
  ctx.fillRect(xp - 1, 0, 2, h);
}
