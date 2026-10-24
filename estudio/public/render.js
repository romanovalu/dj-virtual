// Compositor: dibuja la escena al aire (programa) y la vista previa en canvas, con transiciones y gráficos encima.
import { state, live, canvasSize, sceneById, emit } from './state.js';
import { sources, sendTally } from './sources.js';
import { pointLabels, setsWon } from './padel.mjs';

const program = /** @type {HTMLCanvasElement} */ (document.createElement('canvas'));
const preview = /** @type {HTMLCanvasElement} */ (document.createElement('canvas'));
const scratch = document.createElement('canvas');
export const programCanvas = program;
export const previewCanvas = preview;

const pctx = program.getContext('2d', { alpha: false });
const vctx = preview.getContext('2d', { alpha: false });
const sctx = scratch.getContext('2d', { alpha: false });

export function resize() {
  const { w, h } = canvasSize();
  program.width = scratch.width = w;
  program.height = scratch.height = h;
  preview.width = Math.round(w / 2);
  preview.height = Math.round(h / 2);
}
resize();

// ---------- Fuentes ----------

function mediaSize(el) {
  if (el instanceof HTMLVideoElement) return [el.videoWidth, el.videoHeight];
  if (el instanceof HTMLImageElement) return [el.naturalWidth, el.naturalHeight];
  return [0, 0];
}

function drawSource(ctx, id, x, y, w, h, fit = 'cover') {
  const s = id ? sources.get(id) : null;
  const el = s?.el;
  const [mw, mh] = el ? mediaSize(el) : [0, 0];
  const ready = s && s.online && mw > 0 && (!(el instanceof HTMLVideoElement) || el.readyState >= 2);
  if (!ready) {
    ctx.fillStyle = '#16181d';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#6b7280';
    ctx.font = `600 ${Math.max(12, Math.round(h / 16))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s ? `Sin señal · ${s.label}` : 'Elegí una fuente', x + w / 2, y + h / 2);
    return;
  }
  const scale = fit === 'cover' ? Math.max(w / mw, h / mh) : Math.min(w / mw, h / mh);
  const dw = mw * scale;
  const dh = mh * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  if (fit !== 'cover') {
    ctx.fillStyle = '#000';
    ctx.fillRect(x, y, w, h);
  }
  ctx.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawScene(ctx, scene, W, H) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!scene) return;
  const u = Math.min(W, H) / 720;
  switch (scene.layout) {
    case 'full':
      drawSource(ctx, scene.a, 0, 0, W, H, scene.fit ?? 'cover');
      break;
    case 'side':
      if (W >= H) {
        drawSource(ctx, scene.a, 0, 0, W / 2, H);
        drawSource(ctx, scene.b, W / 2, 0, W / 2, H);
      } else {
        drawSource(ctx, scene.a, 0, 0, W, H / 2);
        drawSource(ctx, scene.b, 0, H / 2, W, H / 2);
      }
      ctx.fillStyle = '#000';
      if (W >= H) ctx.fillRect(W / 2 - 2 * u, 0, 4 * u, H);
      else ctx.fillRect(0, H / 2 - 2 * u, W, 4 * u);
      break;
    case 'pip': {
      drawSource(ctx, scene.a, 0, 0, W, H);
      const pw = Math.round((W >= H ? 0.3 : 0.45) * W);
      const ph = Math.round((pw * 9) / 16);
      const m = 28 * u;
      const c = scene.corner ?? 'br';
      const px = c.includes('l') ? m : W - pw - m;
      const py = c.includes('t') ? m : H - ph - m;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.5)';
      ctx.shadowBlur = 20 * u;
      ctx.fillStyle = '#fff';
      roundRect(ctx, px - 3 * u, py - 3 * u, pw + 6 * u, ph + 6 * u, 10 * u);
      ctx.fill();
      ctx.restore();
      ctx.save();
      roundRect(ctx, px, py, pw, ph, 8 * u);
      ctx.clip();
      drawSource(ctx, scene.b, px, py, pw, ph);
      ctx.restore();
      break;
    }
    case 'slate': {
      if (scene.a) drawSource(ctx, scene.a, 0, 0, W, H);
      else {
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, scene.color || '#1d3557');
        g.addColorStop(1, '#0b0d12');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
      if (scene.text) {
        ctx.fillStyle = 'rgba(0,0,0,.35)';
        if (scene.a) ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        let size = 72 * u;
        ctx.font = `800 ${size}px system-ui, sans-serif`;
        while (ctx.measureText(scene.text).width > W * 0.88 && size > 20) {
          size -= 4;
          ctx.font = `800 ${size}px system-ui, sans-serif`;
        }
        ctx.fillText(scene.text, W / 2, H / 2);
      }
      break;
    }
  }
}

// ---------- Gráficos ----------

function drawScore(ctx, W, H) {
  const sc = state.score;
  if (!sc.visible) return;
  const m = sc.match;
  const u = Math.min(W, H) / 720;
  const x = 24 * u;
  const y = 24 * u;
  const rowH = 38 * u;
  const nameW = 210 * u;
  const cellW = 34 * u;
  const ptsW = 58 * u;
  const cols = m.sets.length + (m.winner === null ? 1 : 0);
  const totalW = nameW + cols * cellW + (m.winner === null ? ptsW : 0);
  const labels = pointLabels(m);
  const sets = setsWon(m);

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.45)';
  ctx.shadowBlur = 14 * u;
  ctx.fillStyle = 'rgba(12,14,20,.88)';
  roundRect(ctx, x, y, totalW, rowH * 2, 8 * u);
  ctx.fill();
  ctx.restore();

  ctx.textBaseline = 'middle';
  for (let t = 0; t < 2; t++) {
    const ry = y + t * rowH;
    const cy = ry + rowH / 2;
    // saque
    if (m.winner === null && m.server === t) {
      ctx.fillStyle = '#d4f50c';
      ctx.beginPath();
      ctx.arc(x + 14 * u, cy, 5 * u, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = m.winner === t ? '#d4f50c' : '#fff';
    ctx.font = `700 ${19 * u}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    let name = m.teams[t];
    while (ctx.measureText(name).width > nameW - 34 * u && name.length > 3) name = name.slice(0, -2) + '…';
    ctx.fillText(name, x + 26 * u, cy);

    ctx.textAlign = 'center';
    let cx = x + nameW;
    m.sets.forEach((s) => {
      ctx.fillStyle = s[t] > s[1 - t] ? '#fff' : '#8b93a3';
      ctx.font = `700 ${19 * u}px system-ui, sans-serif`;
      ctx.fillText(String(s[t]), cx + cellW / 2, cy);
      cx += cellW;
    });
    if (m.winner === null) {
      ctx.fillStyle = '#fff';
      ctx.font = `800 ${20 * u}px system-ui, sans-serif`;
      ctx.fillText(String(m.games[t]), cx + cellW / 2, cy);
      cx += cellW;
      ctx.fillStyle = '#d4f50c';
      ctx.fillRect(cx, ry + (t === 0 ? 0 : 1 * u), ptsW, rowH - 1 * u);
      ctx.fillStyle = '#0b0d12';
      ctx.font = `800 ${20 * u}px system-ui, sans-serif`;
      ctx.fillText(labels[t], cx + ptsW / 2, cy);
    }
  }
  // separador entre equipos
  ctx.fillStyle = 'rgba(255,255,255,.12)';
  ctx.fillRect(x + 8 * u, y + rowH, totalW - 16 * u, 1 * u);

  const tag = m.winner !== null ? `Ganan ${m.teams[m.winner]} · ${sets[m.winner]}-${sets[1 - m.winner]}` : m.tiebreak ? 'TIE-BREAK' : '';
  if (tag) {
    ctx.font = `800 ${14 * u}px system-ui, sans-serif`;
    const tw = ctx.measureText(tag).width + 20 * u;
    ctx.fillStyle = '#d4f50c';
    roundRect(ctx, x, y + rowH * 2 + 6 * u, tw, 24 * u, 6 * u);
    ctx.fill();
    ctx.fillStyle = '#0b0d12';
    ctx.textAlign = 'left';
    ctx.fillText(tag, x + 10 * u, y + rowH * 2 + 18 * u);
  }
}

function drawLower(ctx, W, H, now) {
  const lo = state.lower;
  if (!lo.visible) return;
  const elapsed = (now - live.lowerShownAt) / 1000;
  if (lo.autoHide > 0 && elapsed > lo.autoHide) {
    lo.visible = false;
    emit('graphics');
    return;
  }
  const u = Math.min(W, H) / 720;
  const k = Math.min(1, elapsed / 0.45);
  const ease = 1 - Math.pow(1 - k, 3);
  const x = 48 * u - (1 - ease) * 500 * u;
  const y = H - (W >= H ? 150 : 260) * u;
  ctx.save();
  ctx.globalAlpha = ease;
  ctx.font = `800 ${32 * u}px system-ui, sans-serif`;
  const tW = ctx.measureText(lo.title).width;
  ctx.font = `500 ${21 * u}px system-ui, sans-serif`;
  const sW = lo.subtitle ? ctx.measureText(lo.subtitle).width : 0;
  const w = Math.min(W - 96 * u, Math.max(tW, sW) + 48 * u);
  ctx.shadowColor = 'rgba(0,0,0,.4)';
  ctx.shadowBlur = 16 * u;
  ctx.fillStyle = lo.color;
  ctx.fillRect(x, y, w, 54 * u);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = `800 ${32 * u}px system-ui, sans-serif`;
  ctx.fillText(lo.title, x + 24 * u, y + 28 * u, w - 48 * u);
  if (lo.subtitle) {
    ctx.fillStyle = 'rgba(12,14,20,.9)';
    ctx.fillRect(x, y + 54 * u, w, 38 * u);
    ctx.fillStyle = '#e5e7eb';
    ctx.font = `500 ${21 * u}px system-ui, sans-serif`;
    ctx.fillText(lo.subtitle, x + 24 * u, y + 73 * u, w - 48 * u);
  }
  ctx.restore();
}

const logoImg = new Image();
let logoSrc = '';
function drawLogo(ctx, W, H) {
  const lg = state.logo;
  if (!lg.visible || !lg.dataUrl) return;
  if (logoSrc !== lg.dataUrl) {
    logoSrc = lg.dataUrl;
    logoImg.src = lg.dataUrl;
  }
  if (!logoImg.naturalWidth) return;
  const u = Math.min(W, H) / 720;
  const w = Math.max(W, H) * lg.size;
  const h = (w * logoImg.naturalHeight) / logoImg.naturalWidth;
  const m = 24 * u;
  const x = lg.corner.includes('l') ? m : W - w - m;
  const y = lg.corner.includes('t') ? m : H - h - m;
  ctx.drawImage(logoImg, x, y, w, h);
}

let tickerX = 0;
let tickerLast = 0;
function drawTicker(ctx, W, H, now) {
  const tk = state.ticker;
  if (!tk.visible || !tk.text) return;
  const u = Math.min(W, H) / 720;
  const h = 40 * u;
  ctx.fillStyle = 'rgba(12,14,20,.9)';
  ctx.fillRect(0, H - h, W, h);
  ctx.font = `600 ${21 * u}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  const text = `${tk.text}     •     `;
  const tw = ctx.measureText(text).width;
  const dt = tickerLast ? (now - tickerLast) / 1000 : 0;
  tickerLast = now;
  tickerX = (tickerX + dt * 110 * u) % tw;
  for (let x = -tickerX; x < W; x += tw) ctx.fillText(text, x, H - h / 2);
}

function drawGraphics(ctx, W, H, now) {
  drawLogo(ctx, W, H);
  drawTicker(ctx, W, H, now);
  drawLower(ctx, W, H, now);
  drawScore(ctx, W, H);
}

// ---------- Transiciones ----------

const FADE_MS = 600;

/** Pasa la vista previa al aire. `fade` = fundido; si no, corte seco. */
export function take(fade) {
  if (!live.preview || live.trans?.mode === 'auto') return;
  if (!fade) {
    swap();
    return;
  }
  live.trans = { mode: 'auto', start: performance.now(), t: live.trans?.t ?? 0 };
}

/** Manda una escena directo al aire (con fundido o corte). */
export function goLive(sceneId, fade) {
  if (sceneId === live.program) return;
  live.trans = null;
  live.preview = sceneId;
  take(fade);
  emit('live');
}

function swap() {
  const old = live.program;
  live.program = live.preview;
  live.preview = old;
  live.trans = null;
  emit('live');
}

/**
 * Palanca de transición manual (crossfader o slider): v de 0 a 1.
 * Recién se activa cuando estuvo apoyada en una punta; llevarla a la otra punta pone la vista previa al aire.
 * Así, un crossfader que arranca en el medio no deja la salida a mitad de fundido.
 */
export function tbar(v) {
  const end = v <= 0.02 ? 0 : v >= 0.98 ? 1 : null;
  if (end !== null) {
    if (live.tbarParked === null) live.tbarParked = end;
    else if (end !== live.tbarParked) {
      live.tbarParked = end;
      if (live.trans?.mode !== 'auto') swap();
    } else if (live.trans?.mode === 'manual') live.trans = null;
    return;
  }
  if (live.tbarParked === null || live.trans?.mode === 'auto') return;
  live.trans = { mode: 'manual', t: live.tbarParked === 0 ? v : 1 - v };
}

// ---------- Bucle ----------

const ids = (sc) => [sc?.a, sc?.b].filter(Boolean);
let frame = 0;

function tick() {
  const now = performance.now();
  const W = program.width;
  const H = program.height;
  const pScene = sceneById(live.program);
  const vScene = sceneById(live.preview);

  let t = 0;
  if (live.trans) {
    if (live.trans.mode === 'auto') {
      t = Math.min(1, live.trans.t + (now - live.trans.start) / FADE_MS);
      if (t >= 1) {
        swap();
        t = 0;
      }
    } else t = live.trans.t;
  }

  drawScene(pctx, sceneById(live.program), W, H);
  if (live.trans && t > 0) {
    drawScene(sctx, sceneById(live.preview), W, H);
    pctx.globalAlpha = t;
    pctx.drawImage(scratch, 0, 0);
    pctx.globalAlpha = 1;
  }
  drawGraphics(pctx, W, H, now);

  // La vista previa se dibuja a la mitad de cuadros para ahorrar.
  if (frame++ % 2 === 0) {
    const w = preview.width;
    const h = preview.height;
    drawScene(vctx, vScene, w, h);
    drawGraphics(vctx, w, h, now);
  }

  if (frame % 15 === 0) {
    const onAir = new Set(ids(pScene));
    if (live.trans) ids(vScene).forEach((i) => onAir.add(i));
    sendTally(onAir, new Set(ids(vScene)));
  }
}

// Un worker marca el ritmo: requestAnimationFrame se frena si la pestaña queda en segundo plano.
let worker = null;
export function startLoop() {
  const code = `let id;onmessage=(e)=>{clearInterval(id);id=setInterval(()=>postMessage(0),1000/e.data)}`;
  worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
  worker.onmessage = tick;
  worker.postMessage(state.settings.fps);
}
