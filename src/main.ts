import './styles.css';
import './app.css';
import './modes.css';
import { AudioEngine } from './audio/engine';
import { Deck, PITCH_RANGES } from './audio/deck';
import { Mixer } from './audio/mixer';
import { Analyzer } from './analysis/analyzer';
import { keyLabel } from './analysis/camelot';
import { AutoDJ } from './autodj/autodj';
import { Controller } from './midi/controller';
import { ALL_ACTIONS, actionLabel, bindingLabel, type DeckId } from './midi/mapping';
import { formatTime, isAudioFile, newTrackId, titleFromFile, youtubeIdFromUrl, type Track } from './library';
import { Knob } from './ui/knob';
import { drawOverview, drawZoom, type WaveMarks } from './ui/waveform';
import { Guide } from './guide/guide';
import { Sampler } from './audio/sampler';
import { SamplerPads } from './ui/sampler-pads';
import { registerPwa } from './pwa';
import { EasyView } from './ui/easy';
import { GuidePanel } from './ui/guide-panel';
import type { App, AppMode } from './app-types';
import { fileKey, filesInDir, fsSupported, hasPermission, hiddenKeys, hideKey, listEntries, pickFiles, pickFolder, putEntry, removeEntry, unhideKey } from './persist';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ------------------------------------------------------------------ toasts

function toast(msg: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ------------------------------------------------------------------ DOM de los decks

const HOT_COLORS = ['#ff4d6d', '#3ddc84', '#ffcc4d', '#b88cff'];

function deckHtml(id: DeckId): string {
  return `
  <div class="deck-head"><span class="deck-letter">${id}</span><div class="title">Deck vacío</div><span class="owner"></span></div>
  <div class="deck-meta">
    <span><span class="bpm">--.-</span> BPM</span>
    <span class="orig"></span>
    <span class="camelot"></span>
    <span class="energy"></span>
    <span class="time">0:00 / -0:00</span>
  </div>
  <canvas class="wf-zoom"></canvas>
  <canvas class="wf-over" title="Click para saltar"></canvas>
  <div class="yt-host"></div>
  <div class="basic-note" hidden>YouTube · modo básico: volumen y crossfade con setVolume, tempo en pasos fijos, sin EQ, sin preescucha y sin BPM.</div>
  <div class="row transport">
    <button class="cue" title="Cue (estilo CDJ)">CUE</button>
    <button class="play" title="Play / Pausa">▶</button>
    <button class="sync" title="Igualar BPM y fase con el otro deck">SYNC</button>
    <button class="keylock on" title="Keylock: cambia el tempo sin cambiar el tono">KEY</button>
    <span class="spacer"></span>
    <button class="nudge-dn" title="Frenar un poco (mantener)">◀◀</button>
    <button class="nudge-up" title="Acelerar un poco (mantener)">▶▶</button>
  </div>
  <div class="row">
    <input type="range" class="pitch" min="-1" max="1" step="0.0005" value="0" title="Pitch (doble click: 0)" />
    <span class="pitch-val">+0.00%</span>
    <select class="prange" title="Rango del pitch">${PITCH_RANGES.map((r) => `<option value="${r}">±${r * 100}%</option>`).join('')}</select>
  </div>
  <div class="pads">${[0, 1, 2, 3].map((i) => `<button class="hc" data-i="${i}" style="--c:${HOT_COLORS[i]}" title="Hot cue ${i + 1} (shift+click o click derecho: borrar)">${i + 1}</button>`).join('')}</div>
  <div class="row loops">
    <button class="lin">IN</button><button class="lout">OUT</button>
    <button class="lhalf">÷2</button><span class="loopsize">4</span><button class="ldbl">×2</button>
    <button class="bjb" title="Beatjump atrás">⟨</button><button class="bjf" title="Beatjump adelante">⟩</button>
    <span class="spacer"></span>
    <button class="grid-l" title="Mover el downbeat (primer tiempo del compás)">◀ compás</button><button class="grid-r" title="Mover el downbeat">compás ▶</button>
  </div>
  <div class="row fxrow">
    <button class="fx" data-fx="echo" title="Eco a ¾ de tiempo">Eco</button>
    <button class="fx" data-fx="reverb" title="Reverb (sala grande)">Reverb</button>
    <button class="fx" data-fx="flanger" title="Flanger con ciclo de 2 compases">Flanger</button>
    <button class="fx" data-fx="gate" title="Trance gate en corcheas">Gate</button>
    <span class="small muted" style="margin-left:6px">Roll</span>
    <button class="roll" data-roll="0.5" title="Mantené: repite ½ tiempo">½</button>
    <button class="roll" data-roll="0.25" title="Mantené: repite ¼ de tiempo">¼</button>
    <button class="roll" data-roll="0.125" title="Mantené: repite ⅛ de tiempo">⅛</button>
  </div>
  <div class="row fxrow">
    <button class="flt" data-flt="hp">Filtro HP</button>
    <button class="flt" data-flt="lp">Filtro LP</button>
    <button class="act" data-act="brake">Freno</button>
    <button class="act" data-act="spin">Backspin</button>
  </div>
  <div class="deck-msg"></div>`;
}

const deckRoots = { A: $(`.deck[data-deck="A"]`), B: $(`.deck[data-deck="B"]`) };
deckRoots.A.innerHTML = deckHtml('A');
deckRoots.B.innerHTML = deckHtml('B');

// ------------------------------------------------------------------ núcleo

const engine = new AudioEngine();
const decks = { A: new Deck('A', engine, $('.yt-host', deckRoots.A)), B: new Deck('B', engine, $('.yt-host', deckRoots.B)) };
const mixer = new Mixer(engine, decks);
const autodj = new AutoDJ(decks, mixer);
const analyzer = new Analyzer(engine.ctx);
const tracks: Track[] = [];
let selected = 0;

function otherDeck(d: Deck): Deck {
  return d === decks.A ? decks.B : decks.A;
}

function resumeAudio(): void {
  if (engine.ctx.state !== 'running') void engine.resume();
}

/** Toda interacción del usuario con un deck: activa el audio y le saca el deck a la IA. */
function touch(d: Deck): void {
  resumeAudio();
  autodj.userTouchedDeck(d);
}

const sampler = new Sampler(engine);
sampler.clock = () => autodj.currentDeck ?? (decks.A.playing ? decks.A : decks.B.playing ? decks.B : null);
const controller = new Controller({
  sampler,
  decks,
  mixer,
  autodj,
  browse: (delta) => select(selected + delta),
  browsePush: () => {
    const t = tracks[selected];
    if (!t) return;
    autodj.addToQueue(t);
    toast(`En cola: ${t.title}`);
  },
  loadSelected: (d) => void loadInto(d, tracks[selected]),
  requestSelected: () => {
    const t = tracks[selected];
    if (!t) return;
    if (autodj.enabled) autodj.request(t);
    else {
      autodj.addToQueue(t);
      toast(`En cola: ${t.title}`);
    }
  },
  resumeAudio,
  toast,
});

async function loadInto(d: Deck, t: Track | undefined): Promise<void> {
  if (!t) return;
  if (d.playing) {
    toast(`El Deck ${d.id} está sonando: pausalo antes de cargar otro tema.`);
    return;
  }
  touch(d);
  await d.loadTrack(t);
}

// ------------------------------------------------------------------ biblioteca

/** Agrega archivos a la biblioteca, sin duplicar. Devuelve cuántos temas nuevos entraron. */
function addTrackFiles(items: { file: File; storeKey?: string }[], silent = false): number {
  const have = new Set(tracks.map((t) => t.fileKey).filter(Boolean));
  const hidden = hiddenKeys();
  let n = 0;
  let dup = 0;
  for (const { file: f, storeKey } of items) {
    if (!isAudioFile(f)) continue;
    const k = fileKey(f);
    if (have.has(k)) {
      dup++;
      continue;
    }
    if (storeKey?.startsWith('d:') && hidden.has(k)) continue;
    have.add(k);
    const t: Track = { id: newTrackId(), title: titleFromFile(f.name), source: 'local', file: f, fileKey: k, storeKey, duration: 0, status: 'pending' };
    tracks.push(t);
    analyzer.enqueue(t);
    n++;
  }
  if (!silent) {
    if (n) toast(`${n} tema${n > 1 ? 's' : ''} agregado${n > 1 ? 's' : ''}: analizando…${dup ? ` (${dup} ya estaban)` : ''}`);
    else if (dup) toast('Esos temas ya estaban en la biblioteca.');
    else toast('No encontré archivos de audio (MP3, WAV, FLAC…).');
  }
  renderLibrary();
  scheduleRender('easy');
  return n;
}

/** Archivos sin acceso guardado (navegadores sin File System Access): no se recuerdan. */
function addFiles(files: Iterable<File>): void {
  addTrackFiles([...files].map((file) => ({ file })));
}

async function addFileHandles(handles: FileSystemFileHandle[]): Promise<void> {
  const items: { file: File; storeKey: string }[] = [];
  for (const h of handles) {
    try {
      const f = await h.getFile();
      if (!isAudioFile(f)) continue;
      const key = `f:${fileKey(f)}`;
      unhideKey(fileKey(f));
      await putEntry({ key, kind: 'file', name: f.name, handle: h, addedAt: Date.now() });
      items.push({ file: f, storeKey: key });
    } catch {
      /* archivo ilegible */
    }
  }
  addTrackFiles(items);
}

async function addDirectory(dir: FileSystemDirectoryHandle): Promise<void> {
  let key = `d:${dir.name}:${Date.now()}`;
  for (const e of await listEntries()) {
    if (e.kind === 'dir' && (await e.handle.isSameEntry(dir))) key = e.key;
  }
  await putEntry({ key, kind: 'dir', name: dir.name, handle: dir, addedAt: Date.now() });
  toast(`Leyendo la carpeta "${dir.name}"…`);
  const items = await filesInDir(dir);
  const n = addTrackFiles(
    items.map((x) => ({ file: x.file, storeKey: key })),
    true,
  );
  toast(n ? `Carpeta "${dir.name}": ${n} temas nuevos. Queda guardada; lo que agregues ahí aparece solo.` : `La carpeta "${dir.name}" no tiene temas nuevos.`);
}

async function chooseFiles(): Promise<void> {
  if (!fsSupported) {
    $<HTMLInputElement>('#file-input').click();
    return;
  }
  try {
    await addFileHandles(await pickFiles());
  } catch {
    /* canceló */
  }
}

async function chooseFolder(): Promise<void> {
  if (!fsSupported) {
    toast('Tu navegador no deja elegir carpetas: usá Chrome o Edge.');
    return;
  }
  try {
    await addDirectory(await pickFolder());
  } catch {
    /* canceló */
  }
}

function removeTrack(t: Track): void {
  if ([decks.A, decks.B].some((d) => d.track === t && d.playing)) {
    toast('Ese tema está sonando: pausalo antes de sacarlo.');
    return;
  }
  const i = tracks.indexOf(t);
  if (i >= 0) tracks.splice(i, 1);
  autodj.removeFromQueue(t);
  const k = t.storeKey;
  if (k?.startsWith('d:') && t.fileKey) hideKey(t.fileKey);
  else if (k) void removeEntry(k);
  if (selected >= tracks.length) selected = Math.max(0, tracks.length - 1);
  renderLibrary();
  scheduleRender('easy');
}

// ------------------------------------------------------------------ restaurar la biblioteca guardada

let restorePending = 0;

async function restoreLibrary(ask: boolean): Promise<void> {
  const entries = await listEntries();
  let pending = 0;
  let missing = 0;
  let fileEntries = 0;
  for (const e of entries) {
    if (e.kind === 'yt') {
      if (!tracks.some((t) => t.storeKey === e.key)) tracks.push({ id: newTrackId(), title: e.name, source: 'youtube', youtubeId: e.videoId, storeKey: e.key, duration: 0, status: 'ready' });
      continue;
    }
    if (e.kind === 'file') fileEntries++;
    let ok = false;
    try {
      ok = await hasPermission(e.handle, ask);
    } catch {
      ok = false;
    }
    if (!ok) {
      pending++;
      continue;
    }
    try {
      if (e.kind === 'file') addTrackFiles([{ file: await e.handle.getFile(), storeKey: e.key }], true);
      else
        addTrackFiles(
          (await filesInDir(e.handle)).map((x) => ({ file: x.file, storeKey: e.key })),
          true,
        );
    } catch {
      missing++;
    }
  }
  restorePending = pending;
  renderRestoreBar(fileEntries);
  if (missing) toast(`${missing} archivo(s) guardados ya no están (¿los moviste o borraste?).`);
  renderLibrary();
  scheduleRender('easy');
}

function renderRestoreBar(fileEntries = 0): void {
  const bar = $('#restore-bar');
  bar.hidden = restorePending === 0;
  if (!restorePending) return;
  bar.innerHTML = `🎵 Tu biblioteca está guardada (${restorePending} ${restorePending === 1 ? 'fuente' : 'fuentes'} de música). El navegador pide permiso para volver a leerla. <button id="restore-btn" class="primary">🔓 Reconectar mi música</button>${fileEntries > 5 ? ' <span class="small muted">Tip: con "+ Carpeta" se reconecta todo de un solo click.</span>' : ''}`;
  $('#restore-btn').addEventListener('click', () => void restoreLibrary(true));
}

function addYouTube(): void {
  const input = $<HTMLInputElement>('#yt-url');
  const id = youtubeIdFromUrl(input.value);
  if (!id) {
    toast('No reconozco ese link de YouTube.');
    return;
  }
  const key = `y:${id}`;
  if (!tracks.some((t) => t.storeKey === key)) {
    tracks.push({ id: newTrackId(), title: `YouTube · ${id}`, source: 'youtube', youtubeId: id, storeKey: key, duration: 0, status: 'ready' });
    void putEntry({ key, kind: 'yt', name: `YouTube · ${id}`, videoId: id, addedAt: Date.now() });
  }
  input.value = '';
  select(tracks.length - 1);
  renderLibrary();
}

function select(i: number): void {
  if (!tracks.length) return;
  selected = Math.max(0, Math.min(tracks.length - 1, i));
  renderLibrary();
  $(`#lib-table tr[data-i="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
}

analyzer.onUpdate = (t) => {
  if (t.status === 'error') toast(t.error ?? 'Error de análisis');
  for (const d of [decks.A, decks.B]) if (d.track === t) d.analysisArrived();
  scheduleRender('library');
  scheduleRender('autodj');
  scheduleRender('easy');
};

function renderLibrary(): void {
  const table = $<HTMLTableElement>('#lib-table');
  $('#drop-hint').style.display = tracks.length ? 'none' : '';
  $('#lib-count').textContent = tracks.length ? `${tracks.length} temas${analyzer.queued ? ` · analizando ${analyzer.queued}` : ''}` : '';
  if (!tracks.length) {
    table.innerHTML = '';
    return;
  }
  const status = (t: Track) =>
    t.source === 'youtube'
      ? '<span class="tag">YouTube</span>'
      : t.status === 'ready'
        ? `<span class="tag seen" title="Ajuste de la grilla: ${Math.round((t.analysis?.gridFit ?? 0) * 100)} %">✔</span>`
        : t.status === 'error'
          ? `<span class="tag q" title="${esc(t.error ?? '')}">error</span>`
          : `<span class="tag">${t.status === 'analyzing' ? 'analizando…' : 'en espera'}</span>`;
  table.innerHTML =
    '<tr><th>#</th><th>Título</th><th>BPM</th><th>Tono</th><th>Energía</th><th>Dur.</th><th></th><th></th></tr>' +
    tracks
      .map((t, i) => {
        const a = t.analysis;
        const inQ = autodj.queue.includes(t);
        return `<tr data-i="${i}" class="${i === selected ? 'sel' : ''}">
          <td class="muted">${i + 1}</td>
          <td class="t" title="${esc(t.title)}">${esc(t.title)}</td>
          <td class="mono">${a ? a.bpm.toFixed(a.bpm % 1 ? 2 : 0) : '—'}</td>
          <td>${a ? `<b>${a.camelot}</b> <span class="muted small">${keyLabel(a.key, a.scale)}</span>` : '—'}</td>
          <td>${a ? `<span class="ebar" title="${a.energy}/10"><i style="width:${a.energy * 10}%"></i></span>` : '—'}</td>
          <td class="mono small">${t.duration ? formatTime(t.duration) : '—'}</td>
          <td>${status(t)}</td>
          <td style="white-space:nowrap"><button data-act="A">A</button> <button data-act="B">B</button> <button data-act="q" ${inQ ? 'disabled' : ''}>${inQ ? 'en cola' : '+ cola'}</button> <button data-act="rm" title="Sacar de la biblioteca">✕</button></td>
        </tr>`;
      })
      .join('');
}

$('#lib-table').addEventListener('click', (e) => {
  const tr = (e.target as HTMLElement).closest('tr[data-i]') as HTMLElement | null;
  if (!tr) return;
  const i = Number(tr.dataset.i);
  const act = (e.target as HTMLElement).closest('button')?.dataset.act;
  if (act === 'A' || act === 'B') void loadInto(decks[act], tracks[i]);
  else if (act === 'q') autodj.addToQueue(tracks[i]);
  else if (act === 'rm') {
    removeTrack(tracks[i]);
    return;
  }
  select(i);
});
$('#lib-table').addEventListener('dblclick', (e) => {
  const tr = (e.target as HTMLElement).closest('tr[data-i]') as HTMLElement | null;
  if (!tr) return;
  const free = !decks.A.playing ? decks.A : !decks.B.playing ? decks.B : null;
  if (free) void loadInto(free, tracks[Number(tr.dataset.i)]);
});

$<HTMLInputElement>('#file-input').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files) addFiles(input.files);
  input.value = '';
});
$('#yt-add').addEventListener('click', addYouTube);
$<HTMLInputElement>('#yt-url').addEventListener('keydown', (e) => e.key === 'Enter' && addYouTube());

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
  $('#drop-hint').style.display = '';
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
    renderLibrary();
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  // Con File System Access guardamos el acceso (archivos o carpetas enteras) para la próxima vez.
  const items = [...(e.dataTransfer?.items ?? [])].filter((i) => i.kind === 'file');
  const getters = items.map((i) => (i as DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> }).getAsFileSystemHandle?.());
  if (fsSupported && getters.length && getters.every(Boolean)) {
    void Promise.all(getters as Promise<FileSystemHandle | null>[]).then(async (hs) => {
      const files = hs.filter((h): h is FileSystemFileHandle => h?.kind === 'file');
      const dirs = hs.filter((h): h is FileSystemDirectoryHandle => h?.kind === 'directory');
      if (files.length) await addFileHandles(files);
      for (const d of dirs) await addDirectory(d);
    });
  } else if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
  else renderLibrary();
});
$('#lib-files').addEventListener('click', (e) => {
  if (!fsSupported || (e.target as HTMLElement).id === 'file-input') return; // sigue el input clásico
  e.preventDefault();
  void chooseFiles();
});
$('#lib-folder').addEventListener('click', () => void chooseFolder());

// ------------------------------------------------------------------ controles de deck

interface DeckUi {
  root: HTMLElement;
  zoom: HTMLCanvasElement;
  over: HTMLCanvasElement;
  pitch: HTMLInputElement;
  knobs: { high: Knob; mid: Knob; low: Knob; filter: Knob };
  fader: HTMLInputElement;
  vu: HTMLElement;
  pfl: HTMLButtonElement;
}
const ui = {} as Record<DeckId, DeckUi>;

function bindDeck(id: DeckId): void {
  const d = decks[id];
  const root = deckRoots[id];
  const on = (sel: string, ev: string, fn: (e: Event) => void) => $(sel, root).addEventListener(ev, fn);

  on('.play', 'click', () => {
    touch(d);
    d.togglePlay();
  });
  on('.cue', 'pointerdown', () => {
    touch(d);
    d.cueDown();
  });
  on('.cue', 'pointerup', () => d.cueUp());
  on('.cue', 'pointerleave', () => d.cueUp());
  on('.sync', 'click', () => {
    touch(d);
    if (d.synced) d.unsync();
    else if (!d.syncTo(otherDeck(d))) toast('Sync necesita los dos temas analizados (archivos locales).');
  });
  on('.keylock', 'click', () => d.setKeylock(!d.keylock));
  for (const [sel, amt] of [
    ['.nudge-dn', -0.04],
    ['.nudge-up', 0.04],
  ] as const) {
    on(sel, 'pointerdown', () => {
      touch(d);
      d.bend(amt);
    });
    on(sel, 'pointerup', () => d.bend(0));
    on(sel, 'pointerleave', () => d.bend(0));
  }
  const pitch = $<HTMLInputElement>('.pitch', root);
  pitch.addEventListener('input', () => {
    touch(d);
    d.setPitchNorm(Number(pitch.value));
    if (d.synced) d.unsync();
  });
  pitch.addEventListener('dblclick', () => {
    touch(d);
    d.setPitchNorm(0);
  });
  on('.prange', 'change', (e) => {
    const x = (d.tempo - 1) / d.pitchRange;
    d.pitchRange = Number((e.target as HTMLSelectElement).value);
    d.setPitchNorm(Math.max(-1, Math.min(1, x * (d.pitchRange > 0 ? 1 : 0))));
  });
  $$('.hc', root).forEach((b) => {
    const i = Number(b.dataset.i);
    b.addEventListener('click', (e) => {
      touch(d);
      if ((e as MouseEvent).shiftKey) d.clearHotcue(i);
      else d.hotcue(i);
    });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      d.clearHotcue(i);
    });
  });
  const act = (sel: string, fn: () => void) =>
    on(sel, 'click', () => {
      touch(d);
      fn();
    });
  act('.lin', () => d.loopIn());
  act('.lout', () => d.loopOut());
  act('.lhalf', () => d.resizeLoop(0.5));
  act('.ldbl', () => d.resizeLoop(2));
  act('.bjb', () => d.beatjump(-1));
  act('.bjf', () => d.beatjump(1));
  on('.grid-l', 'click', () => d.shiftDownbeat(-1));
  on('.grid-r', 'click', () => d.shiftDownbeat(1));
  $$('.fx', root).forEach((b) =>
    b.addEventListener('click', () => {
      touch(d);
      const k = b.dataset.fx as 'echo' | 'reverb' | 'flanger' | 'gate';
      d.setFx(k, !d.fx[k]);
    }),
  );
  $$('.roll', root).forEach((b) => {
    b.addEventListener('pointerdown', () => {
      touch(d);
      d.rollStart(Number(b.dataset.roll));
    });
    b.addEventListener('pointerup', () => d.rollStop());
    b.addEventListener('pointerleave', () => d.rollStop());
  });
  $$('.flt', root).forEach((b) =>
    b.addEventListener('click', () => {
      touch(d);
      const hp = b.dataset.flt === 'hp';
      d.setFilter(hp ? (d.fx.hp ? 0 : 0.55) : d.fx.lp ? 0 : -0.55);
    }),
  );
  $$('.act', root).forEach((b) =>
    b.addEventListener('click', () => {
      touch(d);
      if (b.dataset.act === 'brake') d.brake();
      else d.backspin();
    }),
  );
  const over = $<HTMLCanvasElement>('.wf-over', root);
  over.addEventListener('click', (e) => {
    if (!d.loaded || !d.duration) return;
    touch(d);
    const r = over.getBoundingClientRect();
    d.seek(((e.clientX - r.left) / r.width) * d.duration);
  });
  // Arrastrar la forma de onda con zoom = scratch / mover la posición
  const zoom = $<HTMLCanvasElement>('.wf-zoom', root);
  let lastX = 0;
  zoom.addEventListener('pointerdown', (e) => {
    if (!d.loaded) return;
    zoom.setPointerCapture(e.pointerId);
    lastX = e.clientX;
  });
  zoom.addEventListener('pointermove', (e) => {
    if (!zoom.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    if (!d.playing) {
      touch(d);
      d.seek(d.position() - (dx / zoom.clientWidth) * 8);
    }
  });

  d.onChange(() => scheduleRender(`deck${id}`));
  ui[id] = {
    root,
    zoom,
    over,
    pitch,
    knobs: undefined as unknown as DeckUi['knobs'],
    fader: undefined as unknown as HTMLInputElement,
    vu: undefined as unknown as HTMLElement,
    pfl: undefined as unknown as HTMLButtonElement,
  };
}

function renderDeck(id: DeckId): void {
  const d = decks[id];
  const u = ui[id];
  const root = u.root;
  const t = d.track;
  const a = d.analysis;
  $('.title', root).textContent = d.mode === 'loading' ? 'Cargando…' : (t?.title ?? 'Deck vacío');
  $('.title', root).title = t?.title ?? '';
  const owner = $('.owner', root);
  owner.textContent = autodj.enabled ? (d.owner === 'ai' ? 'IA' : 'Vos') : '';
  owner.className = `owner ${d.owner === 'ai' && autodj.enabled ? 'ai' : ''}`;
  owner.style.display = autodj.enabled ? '' : 'none';
  $('.orig', root).textContent = a && Math.abs(d.tempo - 1) > 0.0004 ? `(orig. ${a.bpm.toFixed(a.bpm % 1 ? 2 : 0)})` : '';
  $('.camelot', root).textContent = a ? `${a.camelot} · ${keyLabel(a.key, a.scale)}` : '';
  $('.energy', root).textContent = a ? `energía ${a.energy.toFixed(1)}` : '';
  $('.play', root).classList.toggle('on', d.playing);
  $('.play', root).textContent = d.playing ? '❚❚' : '▶';
  $('.sync', root).classList.toggle('on', d.synced);
  $('.keylock', root).classList.toggle('on', d.keylock);
  $<HTMLSelectElement>('.prange', root).value = String(d.pitchRange);
  if (document.activeElement !== u.pitch) u.pitch.value = String((d.tempo - 1) / d.pitchRange);
  $('.pitch-val', root).textContent = `${d.tempo >= 1 ? '+' : ''}${((d.tempo - 1) * 100).toFixed(2)}%`;
  $$('.hc', root).forEach((b, i) => b.classList.toggle('set', d.hotcues[i] != null));
  $('.lin', root).classList.toggle('on', d.loopInPending !== null);
  $('.lout', root).classList.toggle('on', d.loop.on);
  const lb = d.loop.beats;
  $('.loopsize', root).textContent = lb >= 1 ? String(lb) : `1/${Math.round(1 / lb)}`;
  $$('.fx', root).forEach((b) => b.classList.toggle('on', !!d.fx[b.dataset.fx as 'echo']));
  $$('.roll', root).forEach((b) => b.classList.toggle('on', d.fx.roll === Number(b.dataset.roll)));
  $$('.flt', root).forEach((b) => b.classList.toggle('on', b.dataset.flt === 'hp' ? d.fx.hp : d.fx.lp));
  $$('.act', root).forEach((b) => b.classList.toggle('on', b.dataset.act === 'brake' ? d.fx.brake : d.fx.spin));
  const yt = d.mode === 'youtube';
  ($('.basic-note', root) as HTMLElement).hidden = !yt;
  for (const sel of ['.sync', '.keylock', '.loops', '.nudge-dn', '.nudge-up']) $(sel, root).style.opacity = yt ? '0.35' : '';
  $$('.fxrow', root).forEach((r) => (r.style.opacity = yt ? '0.35' : ''));
  $('.deck-msg', root).textContent = d.error;
  // Mixer
  const k = u.knobs;
  if (k) {
    k.high.set(d.eq.high);
    k.mid.set(d.eq.mid);
    k.low.set(d.eq.low);
    k.filter.set(d.filter);
    if (document.activeElement !== u.fader) u.fader.value = String(d.volume);
    u.pfl.classList.toggle('on', d.pfl);
  }
}

// ------------------------------------------------------------------ mixer

function buildMixer(): void {
  const root = $('#mixer');
  root.innerHTML = `
    <div class="chans">
      ${(['A', 'B'] as DeckId[])
        .map(
          (id) => `<div class="chan" data-deck="${id}">
        <div class="chan-label" style="color:var(--deck-${id.toLowerCase()})">${id}</div>
        <div class="k-high"></div><div class="k-mid"></div><div class="k-low"></div><div class="k-filter"></div>
        <button class="pfl" title="Preescucha en auriculares">🎧 CUE</button>
        <div class="fader-wrap"><input type="range" class="vfader" min="0" max="1" step="0.001" value="1" /><div class="vu"><div></div></div></div>
      </div>`,
        )
        .join('')}
    </div>
    <div class="xf"><b style="color:var(--deck-a)">A</b><span class="xf-wrap"><input type="range" id="xfader" min="-1" max="1" step="0.001" value="0" title="Crossfader (doble click: centro)" /><i id="xf-target" hidden></i></span><b style="color:var(--deck-b)">B</b></div>
    <div class="masters"><div class="k-master"></div><div class="k-cuemix"></div><div class="k-phones"></div></div>
    <div class="sampler" id="sampler"></div>
    <div class="row" style="justify-content:center"><span class="small muted">Master</span><div class="vu" id="vu-master" style="width:80px;height:8px"><div style="height:100%;width:0;right:auto;background:linear-gradient(90deg,var(--ok) 0 70%,var(--warn) 70% 88%,var(--err) 88%);background-size:80px 100%"></div></div></div>`;

  const dbFmt = (v: number) => (v <= -39.5 ? 'kill' : `${v > 0 ? '+' : ''}${v.toFixed(0)}dB`);
  for (const id of ['A', 'B'] as DeckId[]) {
    const d = decks[id];
    const col = $(`.chan[data-deck="${id}"]`, root);
    const mk = (cls: string, label: string, band: 'high' | 'mid' | 'low') =>
      new Knob($(cls, col), {
        label,
        min: -40,
        max: 6,
        value: 0,
        def: 0,
        bipolar: true,
        format: dbFmt,
        onInput: (v) => {
          touch(d);
          d.setEq(band, v);
        },
      });
    const knobs = {
      high: mk('.k-high', 'Agudos', 'high'),
      mid: mk('.k-mid', 'Medios', 'mid'),
      low: mk('.k-low', 'Graves', 'low'),
      filter: new Knob($('.k-filter', col), {
        label: 'Filtro',
        min: -1,
        max: 1,
        value: 0,
        def: 0,
        bipolar: true,
        format: (v) => (Math.abs(v) < 0.02 ? '—' : v < 0 ? `LP ${Math.round(-v * 100)}` : `HP ${Math.round(v * 100)}`),
        onInput: (v) => {
          touch(d);
          d.setFilter(v);
        },
      }),
    };
    const fader = $<HTMLInputElement>('.vfader', col);
    fader.addEventListener('input', () => {
      touch(d);
      d.setVolume(Number(fader.value));
    });
    const pfl = $<HTMLButtonElement>('.pfl', col);
    pfl.addEventListener('click', () => {
      resumeAudio();
      d.setPfl(!d.pfl);
    });
    Object.assign(ui[id], { knobs, fader, pfl, vu: $('.vu > div', col) });
  }
  const xf = $<HTMLInputElement>('#xfader');
  xf.addEventListener('input', () => {
    resumeAudio();
    autodj.userTouchedCrossfader();
    mixer.setCrossfader(Number(xf.value));
  });
  xf.addEventListener('dblclick', () => mixer.setCrossfader(0));
  masterKnobs = {
    master: new Knob($('.k-master', root), { label: 'Master', min: 0, max: 1, value: mixer.master, def: 0.8, format: (v) => `${Math.round(v * 100)}`, onInput: (v) => mixer.setMaster(v) }),
    cueMix: new Knob($('.k-cuemix', root), {
      label: 'Cue mix',
      min: 0,
      max: 1,
      value: mixer.cueMix,
      def: 0,
      format: (v) => (v < 0.05 ? 'CUE' : v > 0.95 ? 'MST' : `${Math.round(v * 100)}%`),
      onInput: (v) => mixer.setCueMix(v),
    }),
    phones: new Knob($('.k-phones', root), { label: 'Auricular', min: 0, max: 1, value: mixer.phonesVolume, def: 0.8, format: (v) => `${Math.round(v * 100)}`, onInput: (v) => mixer.setPhonesVolume(v) }),
  };
}
let masterKnobs: { master: Knob; cueMix: Knob; phones: Knob };

function renderMixer(): void {
  const xf = $<HTMLInputElement>('#xfader');
  if (document.activeElement !== xf) xf.value = String(mixer.crossfader);
  masterKnobs.master.set(mixer.master);
  masterKnobs.cueMix.set(mixer.cueMix);
  masterKnobs.phones.set(mixer.phonesVolume);
}
mixer.onChange(() => scheduleRender('mixer'));

// ------------------------------------------------------------------ Auto-DJ

function renderAutoDJ(): void {
  const btn = $('#ad-toggle');
  btn.textContent = autodj.enabled ? '■ Parar Auto-DJ' : '▶ Auto-DJ';
  btn.classList.toggle('on', autodj.enabled);
  $('#ad-status').textContent = autodj.status;
  $<HTMLSelectElement>('#ad-bars').value = String(autodj.bars);
  $<HTMLInputElement>('#ad-glide').checked = autodj.tempoGlide;
  const owners = $('#ad-owners');
  if (autodj.enabled) {
    const chip = (label: string, isAi: boolean, key: string) =>
      `<span>${label}: <b style="color:${isAi ? 'var(--ai)' : 'var(--text)'}">${isAi ? 'IA' : 'Vos'}</b> <button data-own="${key}" data-ai="${isAi ? 1 : 0}">${isAi ? 'Tomar' : 'Devolver a la IA'}</button></span>`;
    owners.innerHTML = chip('Deck A', decks.A.owner === 'ai', 'A') + chip('Deck B', decks.B.owner === 'ai', 'B') + chip('Crossfader', mixer.xfOwner === 'ai', 'xf');
  } else {
    owners.innerHTML = '<span class="muted">Modo híbrido: con el Auto-DJ prendido, si tocás un deck en el controlador la IA te lo cede.</span>';
  }
  $('#q-count').textContent = autodj.queue.length ? ` (${autodj.queue.length})` : '';
  $('#queue').innerHTML = autodj.queue
    .map((t, i) => {
      const a = t.analysis;
      return `<li><div class="q"><span class="qt" title="${esc(t.title)}">${esc(t.title)}</span>
        <span class="mono small">${a ? a.bpm.toFixed(0) : t.source === 'youtube' ? 'YT' : '…'}</span><span class="small"><b>${a?.camelot ?? ''}</b></span>
        <span class="small muted">${a ? `E${a.energy.toFixed(1)}` : t.source === 'youtube' ? 'crossfade' : t.status === 'error' ? 'error' : 'analizando'}</span>
        <button data-q="up" data-i="${i}" title="Subir">↑</button><button data-q="down" data-i="${i}" title="Bajar">↓</button><button data-q="rm" data-i="${i}" title="Sacar">✕</button></div></li>`;
    })
    .join('');
  $('#ad-log').textContent = autodj.log.join('\n');
}
autodj.onChange(() => {
  scheduleRender('autodj');
  scheduleRender('easy');
  scheduleRender('deckA');
  scheduleRender('deckB');
  scheduleRender('library');
});

$('#ad-toggle').addEventListener('click', () => {
  resumeAudio();
  if (autodj.enabled) autodj.stop();
  else {
    if (!autodj.queue.length) {
      tracks.filter((t) => t.status !== 'error').forEach((t) => autodj.addToQueue(t));
      if (autodj.queue.length > 1) autodj.sortQueue();
    }
    autodj.start();
  }
});
$('#ad-bars').addEventListener('change', (e) => {
  autodj.bars = Number((e.target as HTMLSelectElement).value) as 16 | 32;
});
$('#ad-glide').addEventListener('change', (e) => {
  autodj.tempoGlide = (e.target as HTMLInputElement).checked;
});
$('#ad-owners').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button[data-own]') as HTMLElement | null;
  if (!b) return;
  const key = b.dataset.own!;
  const isAi = b.dataset.ai === '1';
  if (key === 'xf') {
    if (isAi) autodj.userTouchedCrossfader();
    else autodj.giveBack('xf');
  } else {
    const d = decks[key as DeckId];
    if (isAi) autodj.userTouchedDeck(d);
    else autodj.giveBack(d);
  }
});
$('#queue').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button[data-q]') as HTMLElement | null;
  if (!b) return;
  const t = autodj.queue[Number(b.dataset.i)];
  if (b.dataset.q === 'up') autodj.moveInQueue(t, -1);
  else if (b.dataset.q === 'down') autodj.moveInQueue(t, 1);
  else autodj.removeFromQueue(t);
});
$('#q-sort').addEventListener('click', () => autodj.sortQueue());
$('#q-all').addEventListener('click', () => tracks.forEach((t) => t.status !== 'error' && autodj.addToQueue(t)));
$('#q-clear').addEventListener('click', () => [...autodj.queue].forEach((t) => autodj.removeFromQueue(t)));

// ------------------------------------------------------------------ MIDI: estado, learn

function renderMidi(): void {
  const s = controller.midi.status;
  const pill = $('#midi-pill');
  const dot = $('.dot', pill);
  const txt = $('.txt', pill);
  const banners: string[] = [];
  dot.className = 'dot';
  if (s.state === 'unsupported') {
    txt.textContent = 'Sin Web MIDI';
    dot.classList.add('err');
    banners.push('<div class="banner err">Este navegador no soporta Web MIDI: abrí la app en <b>Chrome</b> o <b>Edge</b> para usar el DJ2GO2.</div>');
  } else if (s.state === 'denied') {
    txt.textContent = 'MIDI bloqueado';
    dot.classList.add('err');
    banners.push(`<div class="banner err">No hay permiso para MIDI (${esc(s.error)}). Habilitalo en el candado de la barra de direcciones.</div>`);
  } else {
    if (s.controllerFound) {
      txt.textContent = `DJ2GO2 conectado${controller.midi.output ? '' : ' (sin LEDs)'}`;
      dot.classList.add('ok');
    } else {
      txt.textContent = 'DJ2GO2 no detectado';
    }
    for (const e of s.errors) banners.push(`<div class="banner err">${esc(e)}</div>`);
  }
  if (!seratoDismissed)
    banners.push(
      '<div class="banner warn" id="serato">⚠ <b>Serato DJ Lite tiene que estar cerrado</b>: en Windows el DJ2GO2 sólo puede estar conectado a un programa a la vez. Si lo abrís después, la app deja de recibir el controlador. <button id="serato-ok" style="float:right;padding:0 8px">Entendido</button></div>',
    );
  $('#banners').innerHTML = banners.join('');
  $('#serato-ok')?.addEventListener('click', () => {
    seratoDismissed = true;
    try {
      sessionStorage.setItem('djv.seratoOk', '1');
    } catch {
      /* ignorar */
    }
    renderMidi();
  });
  if (($('#dlg-learn') as HTMLDialogElement).open) renderLearn();
}
let seratoDismissed = false;
try {
  seratoDismissed = sessionStorage.getItem('djv.seratoOk') === '1';
} catch {
  /* ignorar */
}

function renderLearn(): void {
  const m = controller.lastMessage;
  $('#learn-last').textContent = m ? `Último: ${m.type === 'cc' ? 'CC' : 'Nota'} ${m.number} · canal ${m.channel} · valor ${m.value}` : '';
  $<HTMLInputElement>('#pitch-invert').checked = controller.pitchInvert;
  $('#learn-table').innerHTML =
    '<tr><th>Acción</th><th>Control asignado</th><th></th></tr>' +
    ALL_ACTIONS.map((a) => {
      const bs = controller.mapping.filter((b) => b.action === a);
      const learning = controller.learnTarget === a;
      return `<tr class="${learning ? 'learning' : ''}"><td>${actionLabel(a)} ${bs.some((b) => b.inferred) ? '<span class="tag q">?</span>' : ''}</td>
        <td class="mono small">${bs.length ? bs.map((b) => bindingLabel(b)).join('<br>') : '<span class="muted">—</span>'}</td>
        <td><button data-learn="${a}">${learning ? 'Tocá un control… (cancelar)' : 'Aprender'}</button></td></tr>`;
    }).join('');
}
controller.onChange(() => {
  scheduleRender('midi');
});
$('#btn-learn').addEventListener('click', () => {
  renderLearn();
  ($('#dlg-learn') as HTMLDialogElement).showModal();
});
$('#learn-table').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button[data-learn]') as HTMLElement | null;
  if (!b) return;
  const a = b.dataset.learn as (typeof ALL_ACTIONS)[number];
  controller.startLearn(controller.learnTarget === a ? null : a);
});
$('#learn-reset').addEventListener('click', () => {
  if (confirm('¿Volver al mapeo por defecto? Se pierden los controles aprendidos.')) controller.resetMapping();
});
$('#pitch-invert').addEventListener('change', (e) => controller.setPitchInvert((e.target as HTMLInputElement).checked));
$('#dlg-learn').addEventListener('close', () => controller.startLearn(null));
$$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => (b.closest('dialog') as HTMLDialogElement).close()));

// ------------------------------------------------------------------ salidas de audio

async function renderAudioForm(): Promise<void> {
  const devices = await engine.listOutputDevices();
  const s = engine.settings;
  const noLabels = devices.some((d) => !d.label);
  const opts = (sel: string, none: string) =>
    `<option value="">${none}</option>` +
    devices
      .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === sel ? 'selected' : ''}>${esc(d.label || `Salida ${i + 1}`)}</option>`)
      .join('');
  const max = engine.maxChannels;
  $('#audio-form').innerHTML = `
    <div class="form-row"><label>Modo</label>
      <select id="ao-mode">
        <option value="stereo" ${s.mode === 'stereo' ? 'selected' : ''}>Estéreo: master y auriculares en dispositivos separados</option>
        <option value="quad" ${s.mode === 'quad' ? 'selected' : ''} ${max < 4 ? 'disabled' : ''}>4 canales: master 1-2 y auriculares 3-4 (misma placa)${max < 4 ? ' — no disponible' : ''}</option>
      </select></div>
    <div class="form-row"><label>Master (parlantes)</label>
      <select id="ao-master" ${engine.canChooseMasterDevice ? '' : 'disabled'}>${opts(s.masterDevice, 'Predeterminado del sistema')}</select></div>
    <div class="form-row"><label>Auriculares (preescucha)</label>
      <select id="ao-phones" ${s.mode === 'quad' ? 'disabled' : ''}>${opts(s.phonesDevice, 'Sin preescucha')}</select></div>
    <p class="small muted">La salida master actual tiene ${max} canales. El DJ2GO2 trae placa de audio propia: si Windows la muestra con 4 canales, elegila como master y usá el modo de 4 canales; si no, usá la placa de la PC para los parlantes y la del DJ2GO2 para los auriculares.</p>
    ${noLabels ? '<p class="small"><button id="ao-unlock">Mostrar nombres de dispositivos</button> <span class="muted">Chrome pide permiso de micrófono para mostrar los nombres; no se graba nada.</span></p>' : ''}
    <p class="small">${esc(engine.phonesStatus)}</p>`;
  const upd = async (patch: Parameters<typeof engine.updateSettings>[0]) => {
    await engine.updateSettings(patch);
    void renderAudioForm();
  };
  $('#ao-mode').addEventListener('change', (e) => void upd({ mode: (e.target as HTMLSelectElement).value as 'stereo' | 'quad' }));
  $('#ao-master').addEventListener('change', (e) => void upd({ masterDevice: (e.target as HTMLSelectElement).value }));
  $('#ao-phones').addEventListener('change', (e) => void upd({ phonesDevice: (e.target as HTMLSelectElement).value }));
  $('#ao-unlock')?.addEventListener('click', async () => {
    try {
      await engine.unlockDeviceLabels();
    } catch {
      toast('Sin permiso: los dispositivos se muestran sin nombre.');
    }
    void renderAudioForm();
  });
}
$('#btn-audio').addEventListener('click', () => {
  void renderAudioForm();
  ($('#dlg-audio') as HTMLDialogElement).showModal();
});

// ------------------------------------------------------------------ render diferido + bucle de animación

const dirty = new Set<string>();
let renderQueued = false;
function scheduleRender(what: string): void {
  dirty.add(what);
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const d = [...dirty];
    dirty.clear();
    for (const w of d) {
      if (w === 'deckA') renderDeck('A');
      else if (w === 'deckB') renderDeck('B');
      else if (w === 'mixer') renderMixer();
      else if (w === 'library') renderLibrary();
      else if (w === 'autodj') renderAutoDJ();
      else if (w === 'midi') renderMidi();
      else if (w === 'easy') easy.render();
    }
  });
}

const vuBuf = new Float32Array(512);
const vuLevels = { A: 0, B: 0, M: 0 };
function frame(): void {
  for (const id of ['A', 'B'] as DeckId[]) {
    const d = decks[id];
    const u = ui[id];
    const pos = d.position();
    const marks: WaveMarks = {
      pos,
      duration: d.duration,
      cue: d.cuePoint,
      hotcues: d.hotcues,
      loop: d.loop,
      accent: id === 'A' ? '#3fb6ff' : '#ff7a3d',
    };
    const local = d.mode === 'local';
    drawZoom(u.zoom, local ? d.track?.waveform : undefined, d.analysis, marks);
    drawOverview(u.over, local ? d.track?.waveform : undefined, marks);
    $('.time', u.root).textContent = `${formatTime(pos)} / -${formatTime(d.duration - pos)}`;
    $('.bpm', u.root).textContent = d.bpm ? d.bpm.toFixed(1) : d.mode === 'youtube' ? `×${d.tempo.toFixed(2)}` : '--.-';
    const lvl = d.strip.level(vuBuf);
    vuLevels[id] = Math.max(lvl, vuLevels[id] * 0.9);
    if (u.vu) u.vu.style.height = `${Math.min(100, vuLevels[id] * 100)}%`;
  }
  engine.masterAnalyser.getFloatTimeDomainData(vuBuf);
  let m = 0;
  for (const v of vuBuf) m = Math.max(m, Math.abs(v));
  vuLevels.M = Math.max(m, vuLevels.M * 0.9);
  ($('#vu-master > div') as HTMLElement).style.width = `${Math.min(100, vuLevels.M * 100)}%`;
  const p = autodj.mixProgress();
  ($('#ad-progress') as HTMLElement).style.width = p === null ? '0' : `${p * 100}%`;
  if (mode === 'easy') easy.frame();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ modos: Fácil, Aprender, Pro

function fillQueue(onlyAnalyzed = false): number {
  const busy = new Set([decks.A.track, decks.B.track].filter(Boolean));
  let n = 0;
  for (const t of tracks) {
    if (t.status === 'error' || busy.has(t) || autodj.queue.includes(t)) continue;
    if (onlyAnalyzed && !(t.source === 'local' && t.analysis)) continue;
    autodj.addToQueue(t);
    n++;
  }
  return n;
}

const guide = new Guide(autodj, mixer, controller, sampler);
const app: App = { engine, decks, mixer, autodj, controller, guide, sampler, tracks, addFiles, chooseFiles, chooseFolder, toast, resumeAudio, fillQueue };
const easy = new EasyView(app, $('#easy'));
new GuidePanel(app, $('#guide'));

const MODE_KEY = 'djv.mode';
let mode: AppMode = 'easy';
try {
  mode = (localStorage.getItem(MODE_KEY) as AppMode) || 'easy';
} catch {
  /* ignorar */
}

function setMode(m: AppMode): void {
  if (m !== 'learn' && guide.phase !== 'idle') {
    guide.stop();
    guide.dismiss();
  }
  mode = m;
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* ignorar */
  }
  controller.mode = m;
  autodj.noTakeover = m === 'easy' || (m === 'learn' && guide.phase === 'running');
  $('#easy').hidden = m !== 'easy';
  $('#guide').hidden = m !== 'learn';
  ($('.console') as HTMLElement).hidden = m === 'easy';
  ($('.bottom') as HTMLElement).hidden = m === 'easy';
  $$('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  if (m === 'easy') easy.render();
}
$('#modes').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button[data-mode]') as HTMLElement | null;
  if (b) setMode(b.dataset.mode as AppMode);
});
setMode(mode);

// ------------------------------------------------------------------ arranque

const overlay = $('#start-overlay');
function hideOverlayIfRunning(): void {
  overlay.classList.toggle('hidden', engine.ctx.state === 'running');
}
engine.onChange(hideOverlayIfRunning);
$('#start-btn').addEventListener('click', async () => {
  await engine.resume();
  hideOverlayIfRunning();
});
window.addEventListener('pointerdown', resumeAudio, { capture: true });

async function boot(): Promise<void> {
  bindDeck('A');
  bindDeck('B');
  buildMixer();
  await engine.whenReady();
  await decks.A.init();
  await decks.B.init();
  await sampler.init();
  new SamplerPads(app, $('#sampler'), false);
  easy.initSampler();
  mixer.setCrossfader(0);
  renderDeck('A');
  renderDeck('B');
  renderMixer();
  renderLibrary();
  renderAutoDJ();
  renderMidi();
  void restoreLibrary(false);
  hideOverlayIfRunning();
  requestAnimationFrame(frame);
  await controller.init();
  renderMidi();
}

registerPwa($('#btn-install'));
void boot();

// Para depurar desde la consola
Object.assign(window, { dj: { engine, decks, mixer, autodj, controller, tracks, addFiles, guide, setMode, sampler, addDirectory, restoreLibrary } });
