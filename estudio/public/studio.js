// Interfaz del estudio: une fuentes, escenas, gráficos, audio, salida y la DJ2GO2.
import { state, live, save, emit, on, uid, sceneById } from './state.js';
import { sources, hasVideo, KIND_LABEL, listDevices, ensureDeviceLabels, addWebcam, addMic, addScreen, addImage, addVideoFile, removeSource, renameSource, restoreSources, reopen } from './sources.js';
import { programCanvas, previewCanvas, resize, take, goLive, tbar, startLoop } from './render.js';
import { channels, channelSettings, syncChannels, setGain, setMuted, setMaster, faderMoved, level, resume } from './audio.js';
import { startRecording, stopRecording, startStreaming, stopStreaming, recordingSeconds, streamingSeconds, streamStats, PLATFORMS, destinationUrl } from './output.js';
import { initMidi, midiStatus, MIDI_HELP, setPadLeds } from './midi.js';
import { newMatch, addPoint, pointLabels } from './padel.mjs';
import { net } from './net.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const LAYOUTS = { full: 'Pantalla completa', pip: 'Cámara + ventana', side: 'Dos lado a lado', slate: 'Placa de texto' };

let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}
on('toast', toast);

async function attempt(fn) {
  try {
    resume();
    await fn();
  } catch (e) {
    if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') toast(e?.message ?? String(e));
  }
}

// ---------- Monitores y transición ----------

$('pvWrap').append(previewCanvas);
$('pgWrap').append(programCanvas);
$('btnCut').onclick = () => take(false);
$('btnFade').onclick = () => take(true);
$('tbar').oninput = (e) => tbar(e.target.value / 1000);

function fmtTime(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ---------- Escenas ----------

let editing = live.program;

function sceneClick(sc) {
  editing = sc.id;
  if (state.settings.sceneClick === 'fade') goLive(sc.id, true);
  else {
    live.preview = sc.id;
    emit('live');
  }
  renderEditor();
}

function renderScenes() {
  const list = $('sceneList');
  list.innerHTML = '';
  state.scenes.forEach((sc, i) => {
    const b = document.createElement('button');
    b.className = `scene${sc.id === live.program ? ' pg' : ''}${sc.id === live.preview ? ' pv' : ''}`;
    b.innerHTML = `<span class="n">${i < 8 ? `Pad ${i < 4 ? 'A' : 'B'}${(i % 4) + 1} · tecla ${i + 1}` : ''}</span><span class="name">${esc(sc.name)}</span><span class="kind">${LAYOUTS[sc.layout]}</span>`;
    b.onclick = () => sceneClick(sc);
    b.ondblclick = () => goLive(sc.id, false);
    b.title = 'Clic: elegir · Doble clic: corte directo al aire';
    list.append(b);
  });
  const add = document.createElement('button');
  add.className = 'scene add';
  add.textContent = '+ Escena';
  add.onclick = () => {
    const sc = { id: uid(), name: `Escena ${state.scenes.length + 1}`, layout: 'full', a: null, b: null, corner: 'br', text: '', color: '#1d3557' };
    state.scenes.push(sc);
    editing = sc.id;
    save();
    renderScenes();
    renderEditor();
    showTab('escena');
  };
  list.append(add);
  $('pvName').textContent = sceneById(live.preview)?.name ?? '';
  $('pgName').textContent = sceneById(live.program)?.name ?? '';
  const idx = (id) => state.scenes.findIndex((s) => s.id === id);
  setPadLeds(idx(live.program), idx(live.preview));
}
on('live', renderScenes);
on('scenes', () => {
  renderScenes();
  renderEditor();
});

for (const r of document.querySelectorAll('input[name=sceneClick]')) {
  r.checked = r.value === state.settings.sceneClick;
  r.onchange = () => {
    state.settings.sceneClick = r.value;
    save();
  };
}

function sourceOptions(selected, allowNone = true) {
  const opts = allowNone ? [`<option value="">— ninguna —</option>`] : [];
  for (const s of sources.values()) {
    if (!hasVideo(s)) continue;
    opts.push(`<option value="${esc(s.id)}"${s.id === selected ? ' selected' : ''}>${esc(s.label)} (${KIND_LABEL[s.kind]})</option>`);
  }
  return opts.join('');
}

function renderEditor() {
  const sc = sceneById(editing) ?? sceneById(live.program);
  const box = $('sceneEditor');
  if (!sc) {
    box.innerHTML = '<p class="hint">No hay escenas.</p>';
    return;
  }
  editing = sc.id;
  const needsB = sc.layout === 'pip' || sc.layout === 'side';
  box.innerHTML = `
    <div class="editor">
      <label>Nombre <input data-k="name" value="${esc(sc.name)}" /></label>
      <label>Diseño
        <select data-k="layout">${Object.entries(LAYOUTS).map(([k, v]) => `<option value="${k}"${k === sc.layout ? ' selected' : ''}>${v}</option>`).join('')}</select>
      </label>
      <label>${sc.layout === 'slate' ? 'Fondo (opcional)' : sc.layout === 'side' ? 'Izquierda / arriba' : 'Fuente principal'}
        <select data-k="a">${sourceOptions(sc.a)}</select>
      </label>
      ${needsB ? `<label>${sc.layout === 'pip' ? 'Ventana chica' : 'Derecha / abajo'} <select data-k="b">${sourceOptions(sc.b)}</select></label>` : ''}
      ${sc.layout === 'pip' ? `<label>Esquina de la ventana <select data-k="corner">${[['br', 'Abajo derecha'], ['bl', 'Abajo izquierda'], ['tr', 'Arriba derecha'], ['tl', 'Arriba izquierda']].map(([k, v]) => `<option value="${k}"${k === sc.corner ? ' selected' : ''}>${v}</option>`).join('')}</select></label>` : ''}
      ${sc.layout === 'full' ? `<label>Encuadre <select data-k="fit"><option value="cover"${sc.fit !== 'contain' ? ' selected' : ''}>Llenar la pantalla (recorta)</option><option value="contain"${sc.fit === 'contain' ? ' selected' : ''}>Mostrar todo (bandas negras)</option></select></label>` : ''}
      ${sc.layout === 'slate' ? `<label>Texto <input data-k="text" value="${esc(sc.text)}" /></label><label>Color <input data-k="color" type="color" value="${esc(sc.color)}" /></label>` : ''}
    </div>
    <div class="row">
      <button id="sceneUp" class="btn">← Mover</button>
      <button id="sceneDown" class="btn">Mover →</button>
      <button id="sceneDel" class="btn danger">Borrar escena</button>
      <span class="hint">Editando: <b>${esc(sc.name)}</b> · los cambios se ven al instante.</span>
    </div>`;
  for (const el of box.querySelectorAll('[data-k]')) {
    el.oninput = el.onchange = () => {
      const k = el.dataset.k;
      sc[k] = el.value === '' && (k === 'a' || k === 'b') ? null : el.value;
      save();
      if (k === 'name') renderScenes();
      if (k === 'layout' && el.type !== 'text') {
        renderEditor();
        renderScenes();
      }
    };
  }
  const move = (d) => {
    const i = state.scenes.indexOf(sc);
    const j = i + d;
    if (j < 0 || j >= state.scenes.length) return;
    [state.scenes[i], state.scenes[j]] = [state.scenes[j], state.scenes[i]];
    save();
    renderScenes();
  };
  $('sceneUp').onclick = () => move(-1);
  $('sceneDown').onclick = () => move(1);
  $('sceneDel').onclick = () => {
    if (state.scenes.length <= 1) return toast('Tiene que quedar al menos una escena.');
    if (!confirm(`¿Borrar la escena "${sc.name}"?`)) return;
    state.scenes = state.scenes.filter((s) => s !== sc);
    if (live.program === sc.id) live.program = state.scenes[0].id;
    if (live.preview === sc.id) live.preview = state.scenes[0].id;
    editing = live.program;
    save();
    renderScenes();
    renderEditor();
  };
}

// ---------- Pestañas ----------

function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.id === `tab-${name}`);
  if (name === 'escena') renderEditor();
}
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => showTab(b.dataset.tab);

// ---------- Fuentes ----------

async function fillDeviceSelects() {
  try {
    const { cams, mics } = await listDevices();
    $('camSelect').innerHTML = cams.length ? cams.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `Cámara ${i + 1}`)}</option>`).join('') : '<option value="">(sin webcams)</option>';
    $('micSelect').innerHTML = mics.length ? mics.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `Micrófono ${i + 1}`)}</option>`).join('') : '<option value="">(sin micrófonos)</option>';
  } catch {
    /* sin acceso a dispositivos */
  }
}
navigator.mediaDevices?.addEventListener('devicechange', fillDeviceSelects);

$('addCam').onclick = () =>
  attempt(async () => {
    await ensureDeviceLabels('video');
    await fillDeviceSelects();
    const sel = $('camSelect');
    if (!sel.value) return toast('No se encontró ninguna webcam.');
    await addWebcam(sel.value, sel.selectedOptions[0].textContent);
  });
$('addMic').onclick = () =>
  attempt(async () => {
    await ensureDeviceLabels('audio');
    await fillDeviceSelects();
    const sel = $('micSelect');
    if (!sel.value) return toast('No se encontró ningún micrófono.');
    await addMic(sel.value, sel.selectedOptions[0].textContent);
  });
$('addScreen').onclick = () => attempt(addScreen);
$('addImage').onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  readImage(f, 1920).then((url) => addImage(url, f.name.replace(/\.[^.]+$/, '')));
  e.target.value = '';
};
$('addVideo').onchange = (e) => {
  const f = e.target.files[0];
  if (f) addVideoFile(f);
  e.target.value = '';
};
$('addPhone').onclick = $('btnPhone').onclick = openPhoneDialog;

/** Achica la imagen para que entre en el almacenamiento del navegador. */
function readImage(file, maxSide) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(file.type === 'image/png' || file.type === 'image/svg+xml' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.88));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function renderSources() {
  const box = $('sourceList');
  box.innerHTML = '';
  if (!sources.size) {
    box.innerHTML = '<p class="hint">Todavía no hay fuentes. Sumá una webcam, un celular o la pantalla.</p>';
  }
  for (const s of sources.values()) {
    const card = document.createElement('div');
    card.className = 'source';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (s.el && s.online) thumb.append(s.el);
    else thumb.textContent = s.kind === 'mic' ? 'Solo audio' : 'Sin señal';
    const status = s.online ? '<span class="status ok">● conectada</span>' : `<span class="status bad">● ${esc(s.error ?? (s.kind === 'phone' ? 'esperando al celular' : 'desconectada'))}</span>`;
    card.append(thumb);
    card.insertAdjacentHTML(
      'beforeend',
      `<div class="meta"><input value="${esc(s.label)}" title="Nombre" /><button class="btn danger" title="Quitar">✕</button></div>
       <div class="meta"><span class="hint" style="margin:0">${KIND_LABEL[s.kind]}</span>${status}${!s.online && (s.kind === 'webcam' || s.kind === 'mic') ? '<button class="btn retry">Reintentar</button>' : ''}</div>`,
    );
    card.querySelector('input').onchange = (e) => renameSource(s.id, e.target.value.trim() || s.label);
    card.querySelector('.danger').onclick = () => {
      if (confirm(`¿Quitar "${s.label}"? Las escenas que la usan quedan sin esa fuente.`)) removeSource(s.id);
    };
    const retry = card.querySelector('.retry');
    if (retry) retry.onclick = () => attempt(() => reopen(s.id));
    box.append(card);
  }
}
on('sources', () => {
  renderSources();
  syncChannels();
  if (document.querySelector('#tab-escena.on')) renderEditor();
});

// ---------- Celulares ----------

let info = null;
async function openPhoneDialog() {
  const dlg = $('phoneDlg');
  try {
    info = await (await fetch('/api/info')).json();
    $('qrList').innerHTML = info.cams.length
      ? info.cams.map((c) => `<figure>${c.qr}<a href="${esc(c.link)}" target="_blank">${esc(c.link)}</a></figure>`).join('')
      : '<p class="hint">Esta PC no está conectada a ninguna red. Conectala al WiFi y volvé a abrir esta ventana.</p>';
  } catch {
    $('qrList').innerHTML = '<p class="hint">No se pudo hablar con el servidor del estudio.</p>';
  }
  dlg.showModal();
}

// ---------- Marcador ----------

function scorePush(next) {
  const sc = state.score;
  if (next === sc.match) return;
  sc.history = [...sc.history.slice(-60), sc.match];
  sc.match = next;
  save();
  renderScore();
}
const point = (t) => scorePush(addPoint(state.score.match, t));
function undo() {
  const sc = state.score;
  const prev = sc.history.pop();
  if (!prev) return;
  prev.teams = sc.match.teams;
  sc.match = prev;
  save();
  renderScore();
}
function toggle(obj, ev = 'graphics') {
  obj.visible = !obj.visible;
  if (obj === state.lower && obj.visible) live.lowerShownAt = performance.now();
  save();
  emit(ev);
}

function renderScore() {
  const m = state.score.match;
  for (const t of [0, 1]) {
    const inp = $(`team${t}`);
    if (document.activeElement !== inp) inp.value = m.teams[t];
    $(`pt${t}`).textContent = `+ Punto ${m.teams[t]}`;
  }
  const labels = pointLabels(m);
  const pad = (s, n) => String(s).padEnd(n);
  const lines = [0, 1].map((t) => `${m.server === t && m.winner === null ? '●' : ' '} ${pad(m.teams[t].slice(0, 16), 16)} ${m.sets.map((s) => s[t]).join(' ')}${m.winner === null ? `  ${m.games[t]}  ${labels[t]}` : ''}`);
  if (m.tiebreak) lines.push('  TIE-BREAK');
  if (m.winner !== null) lines.push(`  Ganaron ${m.teams[m.winner]}`);
  $('scoreText').textContent = lines.join('\n');
  $('golden').checked = m.goldenPoint;
  const tg = $('scoreToggle');
  tg.classList.toggle('on', state.score.visible);
  tg.textContent = state.score.visible ? 'Marcador visible (ocultar)' : 'Mostrar marcador';
}
for (const t of [0, 1]) {
  $(`pt${t}`).onclick = () => point(t);
  $(`team${t}`).oninput = (e) => {
    state.score.match.teams[t] = e.target.value;
    save();
    renderScore();
  };
}
$('scoreUndo').onclick = undo;
$('scoreServe').onclick = () => {
  const m = structuredClone(state.score.match);
  m.server = 1 - m.server;
  scorePush(m);
};
$('scoreNew').onclick = () => {
  if (!confirm('¿Empezar un partido nuevo? Se mantienen los nombres.')) return;
  scorePush(newMatch({ teams: [...state.score.match.teams], goldenPoint: state.score.match.goldenPoint }));
};
$('golden').onchange = (e) => {
  state.score.match.goldenPoint = e.target.checked;
  save();
};
$('scoreToggle').onclick = () => toggle(state.score);

// ---------- Gráficos ----------

function renderGraphics() {
  const lo = state.lower;
  const set = (id, v) => document.activeElement !== $(id) && ($(id).value = v);
  set('lowerTitle', lo.title);
  set('lowerSub', lo.subtitle);
  set('lowerColor', lo.color);
  set('lowerAuto', lo.autoHide);
  set('logoCorner', state.logo.corner);
  set('logoSize', Math.round(state.logo.size * 100));
  set('tickerText', state.ticker.text);
  const tg = (id, obj, on, off) => {
    $(id).classList.toggle('on', obj.visible);
    $(id).textContent = obj.visible ? on : off;
  };
  tg('lowerToggle', lo, 'Zócalo visible (ocultar)', 'Mostrar zócalo');
  tg('logoToggle', state.logo, 'Logo visible (ocultar)', 'Mostrar logo');
  tg('tickerToggle', state.ticker, 'Texto visible (ocultar)', 'Mostrar texto');
  renderScore();
}
on('graphics', renderGraphics);
const bindText = (id, obj, key, num = false) => {
  $(id).oninput = (e) => {
    obj[key] = num ? Number(e.target.value) : e.target.value;
    save();
  };
};
bindText('lowerTitle', state.lower, 'title');
bindText('lowerSub', state.lower, 'subtitle');
bindText('lowerColor', state.lower, 'color');
bindText('lowerAuto', state.lower, 'autoHide', true);
bindText('logoCorner', state.logo, 'corner');
bindText('tickerText', state.ticker, 'text');
$('logoSize').oninput = (e) => {
  state.logo.size = e.target.value / 100;
  save();
};
$('logoFile').onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  readImage(f, 600).then((url) => {
    state.logo.dataUrl = url;
    state.logo.visible = true;
    save();
    renderGraphics();
  });
};
$('lowerToggle').onclick = () => toggle(state.lower);
$('logoToggle').onclick = () => {
  if (!state.logo.dataUrl) return toast('Primero elegí la imagen del logo.');
  toggle(state.logo);
};
$('tickerToggle').onclick = () => toggle(state.ticker);

// ---------- Audio ----------

function renderMixer() {
  const box = $('mixer');
  box.innerHTML = '';
  const strip = (id, label, gain, muted, fader) => {
    const el = document.createElement('div');
    el.className = `strip${id === 'master' ? ' master' : ''}`;
    el.dataset.id = id;
    el.innerHTML = `<div class="label" title="${esc(label)}">${esc(label)}</div>
      <div class="fader-row"><input type="range" min="0" max="1" step="0.01" value="${gain}" /><div class="meter"><i></i></div></div>
      ${id === 'master' ? '<span class="hint" style="margin:0">Master</span>' : `<button class="btn${muted ? ' muted' : ''}">${muted ? 'Silenciado' : 'Activo'}</button>
      <select title="Qué fader de la DJ2GO2 lo controla"><option value="">Sin fader</option><option value="A"${fader === 'A' ? ' selected' : ''}>Fader A</option><option value="B"${fader === 'B' ? ' selected' : ''}>Fader B</option></select>`}`;
    el.querySelector('input').oninput = (e) => (id === 'master' ? setMaster(Number(e.target.value)) : setGain(id, Number(e.target.value)));
    if (id !== 'master') {
      el.querySelector('button').onclick = () => setMuted(id, !channelSettings(id).muted);
      el.querySelector('select').onchange = (e) => {
        channelSettings(id).fader = e.target.value;
        save();
      };
    }
    box.append(el);
  };
  for (const id of channels.keys()) {
    const s = sources.get(id);
    const st = channelSettings(id);
    strip(id, s?.label ?? id, st.gain, st.muted, st.fader);
  }
  if (!channels.size) box.insertAdjacentHTML('beforeend', '<p class="hint">No hay fuentes con sonido todavía. Sumá un micrófono, un celular o una pestaña con audio.</p>');
  strip('master', 'Salida', state.master.gain, false, '');
}
on('mixer', renderMixer);
on('mixer-values', () => {
  for (const el of $('mixer').querySelectorAll('.strip')) {
    const id = el.dataset.id;
    const range = el.querySelector('input');
    if (id === 'master') range.value = state.master.gain;
    else {
      const st = channelSettings(id);
      if (document.activeElement !== range) range.value = st.gain;
      const b = el.querySelector('button');
      b.classList.toggle('muted', st.muted);
      b.textContent = st.muted ? 'Silenciado' : 'Activo';
    }
  }
});

function drawMeters() {
  for (const el of $('mixer').querySelectorAll('.strip')) {
    el.querySelector('.meter i').style.height = `${Math.round(level(el.dataset.id) * 100)}%`;
  }
}

// ---------- Transmisión ----------

function renderOutputSettings() {
  const s = state.settings;
  $('setRes').value = String(s.res);
  $('setVertical').value = s.vertical ? '1' : '0';
  $('setKbps').value = s.kbps;
  const n = state.destinations.filter((d) => d.enabled).length;
  const up = ((s.kbps + 160) * Math.max(1, n)) / 1000;
  $('bwHint').textContent = `Con ${n || 1} destino${n === 1 ? '' : 's'} activos vas a subir unos ${up.toFixed(1)} Mbps. Tu conexión necesita al menos ${(up * 1.5).toFixed(1)} Mbps de subida (medilo en fast.com → "Más info"). Para 720p alcanza con 2500–4000 kbps.`;
  for (const id of ['setRes', 'setVertical', 'setKbps']) $(id).disabled = live.streaming || live.recording;
}
$('setRes').onchange = (e) => {
  state.settings.res = Number(e.target.value);
  save();
  resize();
};
$('setVertical').onchange = (e) => {
  state.settings.vertical = e.target.value === '1';
  save();
  resize();
  document.documentElement.style.setProperty('--ratio', state.settings.vertical ? '9 / 16' : '16 / 9');
};
$('setKbps').onchange = (e) => {
  state.settings.kbps = Math.max(1000, Math.min(9000, Number(e.target.value) || 3500));
  save();
  renderOutputSettings();
};

$('destPlatform').innerHTML = Object.entries(PLATFORMS)
  .map(([k, p]) => `<option value="${k}">${p.name}</option>`)
  .join('');
$('destAdd').onclick = () => {
  const platform = $('destPlatform').value;
  state.destinations.push({ id: uid(), platform, server: PLATFORMS[platform].server, key: '', vertical: !!PLATFORMS[platform].vertical, enabled: true });
  save();
  renderDestinations();
};

function renderDestinations() {
  const box = $('destList');
  box.innerHTML = state.destinations.length ? '' : '<p class="hint">Agregá dónde querés transmitir. Podés transmitir a varios lugares a la vez.</p>';
  for (const d of state.destinations) {
    const p = PLATFORMS[d.platform] ?? PLATFORMS.custom;
    const row = document.createElement('div');
    row.className = 'dest';
    row.innerHTML = `
      <input type="checkbox" ${d.enabled ? 'checked' : ''} title="Activo" data-k="enabled" />
      <span class="pname">${p.name}</span>
      <input placeholder="URL del servidor (rtmp://…)" value="${esc(d.server)}" data-k="server" />
      <input type="password" placeholder="Clave de transmisión" value="${esc(d.key)}" data-k="key" autocomplete="off" />
      <label class="check" title="Recorta el centro de la imagen en vertical 9:16 (para TikTok o Instagram)"><input type="checkbox" ${d.vertical ? 'checked' : ''} data-k="vertical" /> Vertical</label>
      <button class="btn danger" title="Quitar">✕</button>
      <div class="help">${esc(p.help)}</div>`;
    for (const el of row.querySelectorAll('[data-k]')) {
      el.onchange = el.oninput = () => {
        d[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value.trim();
        save();
        if (el.type === 'checkbox') renderOutputSettings();
      };
    }
    row.querySelector('.danger').onclick = () => {
      state.destinations = state.destinations.filter((x) => x !== d);
      save();
      renderDestinations();
    };
    box.append(row);
  }
  renderOutputSettings();
}

function renderOutput() {
  $('btnRec').classList.toggle('on', live.recording);
  $('btnLive').classList.toggle('on', live.streaming);
  $('btnLive').firstChild.nextSibling.textContent = live.streaming ? ' AL AIRE ' : ' Salir al aire ';
  const st = streamStats;
  const label = { off: 'Sin transmitir.', starting: 'Conectando con las plataformas…', live: `Transmitiendo (codificador ${st.encoder ?? ''}).`, stopped: 'Transmisión terminada.', error: `Error: ${st.msg}` }[st.state] ?? '';
  $('streamState').textContent = label;
  renderOutputSettings();
}
on('output', renderOutput);
on('stream-stats', () => {
  const st = streamStats;
  $('streamLog').textContent = st.log.join('\n');
  $('liveStats').textContent = live.streaming && st.kbps ? `${Math.round(st.kbps)} kbps · ${Math.round(st.fps)} fps${Number(st.speed) < 0.95 ? ' · ¡la PC no llega!' : ''}` : '';
});

function toggleRec() {
  if (live.recording) {
    if (confirm('¿Terminar la grabación?')) stopRecording();
  } else attempt(startRecording);
}
function toggleLive(fromMidi = false) {
  if (live.streaming) {
    if (fromMidi || confirm('¿Terminar la transmisión?')) stopStreaming();
  } else {
    resume();
    if (startStreaming()) toast('Saliendo al aire…');
  }
}
$('btnRec').onclick = () => toggleRec();
$('btnLive').onclick = () => toggleLive();

// ---------- DJ2GO2 ----------

$('midiHelp').innerHTML = MIDI_HELP.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('');

function onMidi(action, v) {
  resume();
  const idx = state.scenes.findIndex((s) => s.id === live.preview);
  switch (action) {
    case 'scene': {
      const sc = state.scenes[v];
      if (sc) sceneClick(sc);
      break;
    }
    case 'cut':
      take(false);
      break;
    case 'fade':
      take(true);
      break;
    case 'tbar':
      tbar(v);
      $('tbar').value = Math.round(v * 1000);
      break;
    case 'browse': {
      const n = state.scenes.length;
      live.preview = state.scenes[(((idx + v) % n) + n) % n].id;
      emit('live');
      break;
    }
    case 'point':
      point(v);
      break;
    case 'undo':
      undo();
      break;
    case 'toggleScore':
      toggle(state.score);
      break;
    case 'toggleLower':
      toggle(state.lower);
      break;
    case 'toggleLogo':
      if (state.logo.dataUrl) toggle(state.logo);
      break;
    case 'fader':
      faderMoved(v.which, v.v);
      break;
    case 'toggleRec':
      if (live.recording) stopRecording();
      else attempt(startRecording);
      break;
    case 'toggleLive':
      toggleLive(true);
      break;
    case 'hint':
      toast(v);
      break;
  }
}

on('midi', () => {
  const chip = $('midiChip');
  const s = midiStatus;
  chip.textContent = { ready: `DJ2GO2 conectada`, busy: 'DJ2GO2 ocupada (cerrá el DJ virtual)', none: 'DJ2GO2 no conectada', denied: 'MIDI bloqueado', unsupported: 'MIDI no disponible (usá Chrome o Edge)', off: 'DJ2GO2…' }[s.state];
  chip.className = `chip${s.state === 'ready' ? ' ok' : s.state === 'busy' ? ' bad' : ''}`;
  if (s.state === 'ready') renderScenes();
});

// ---------- Teclado ----------

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key >= '1' && e.key <= '9') {
    const sc = state.scenes[Number(e.key) - 1];
    if (sc) sceneClick(sc);
  } else if (e.key === ' ') {
    e.preventDefault();
    take(true);
  } else if (e.key === 'Enter') {
    take(false);
  }
});
document.addEventListener('pointerdown', resume, { once: true });

// ---------- Arranque ----------

net.on('open', () => {
  $('serverChip').textContent = 'Servidor conectado';
  $('serverChip').className = 'chip ok';
});
net.on('close', () => {
  $('serverChip').textContent = 'Sin servidor (¿npm start?)';
  $('serverChip').className = 'chip bad';
});
net.on('replaced', () => toast('El estudio se abrió en otra pestaña: esta dejó de recibir los celulares.'));
net.start('studio');

document.documentElement.style.setProperty('--ratio', state.settings.vertical ? '9 / 16' : '16 / 9');
renderScenes();
renderEditor();
renderSources();
renderGraphics();
renderMixer();
renderDestinations();
renderOutput();
fillDeviceSelects();
restoreSources();
startLoop();
initMidi(onMidi);

setInterval(() => {
  $('recTime').textContent = live.recording ? fmtTime(recordingSeconds()) : '';
  $('liveTime').textContent = live.streaming ? fmtTime(streamingSeconds()) : '';
}, 500);
setInterval(drawMeters, 80);
