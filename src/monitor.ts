import './styles.css';
import { MidiManager, type MidiMessage } from './midi/midi';
import { actionLabel, bindingLabel, findBinding, hex, loadMapping, type Binding } from './midi/mapping';

const midi = new MidiManager();
const mapping = loadMapping();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const mapEl = $<HTMLTableElement>('map');
const logEl = $('log');
const unknownEl = $<HTMLTableElement>('unknown');
const progressEl = $('progress');
const hideJog = $<HTMLInputElement>('hide-jog');

interface Seen {
  kind: 'note' | 'cc';
  channel: number;
  number: number;
  count: number;
  last: number;
  min: number;
  max: number;
  values: Set<number>;
  port: string;
}
const seen = new Map<string, Seen>();
const keyOf = (kind: string, ch: number, n: number) => `${kind}:${ch}:${n}`;

function renderMap(): void {
  mapEl.innerHTML =
    '<tr><th>Acción</th><th>Control</th><th>Estado</th><th>LED</th></tr>' +
    mapping
      .map((b, i) => {
        const s = seen.get(keyOf(b.kind, b.channel, b.number));
        const state = s
          ? `<span class="tag seen">✔ visto ×${s.count}</span> <span class="mono small">${b.kind === 'cc' ? `${s.min}–${s.max}` : `vel ${s.last}`}</span>`
          : '<span class="muted small">esperando…</span>';
        const led = b.kind === 'note' && b.led ? `<button data-led="${i}" data-on="1">On</button> <button data-led="${i}" data-on="0">Off</button>` : '';
        return `<tr id="row-${i}"><td>${actionLabel(b.action)} ${b.inferred ? '<span class="tag q">?</span>' : ''}</td><td class="mono small">${bindingLabel(b)}</td><td>${state}</td><td>${led}</td></tr>`;
      })
      .join('');
  const confirmed = mapping.filter((b) => seen.has(keyOf(b.kind, b.channel, b.number))).length;
  progressEl.textContent = `${confirmed} / ${mapping.length} confirmados`;
}

function renderUnknown(): void {
  const rows = [...seen.values()].filter((s) => !findBinding(mapping, s.kind, s.channel, s.number));
  unknownEl.innerHTML =
    '<tr><th>Control</th><th>Veces</th><th>Valores</th></tr>' +
    (rows.length
      ? rows.map((s) => `<tr><td class="mono small">${bindingLabel(s)}</td><td>${s.count}</td><td class="mono small">${s.min}–${s.max}</td></tr>`).join('')
      : '<tr><td colspan="3" class="muted small">Ninguno todavía.</td></tr>');
}

function describe(m: MidiMessage): string {
  const bytes = [...m.data].map(hex).join(' ');
  const kind = m.type === 'cc' ? 'CC' : m.type === 'noteon' ? 'Note On' : m.type === 'noteoff' ? 'Note Off' : 'Otro';
  return `${bytes.padEnd(9)}  ${kind.padEnd(8)} canal ${String(m.channel).padStart(2)}  #${String(m.number).padStart(3)}  val ${String(m.value).padStart(3)}`;
}

let renderQueued = false;
function queueRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderMap();
    renderUnknown();
  });
}

midi.onMessage((m) => {
  if (m.type === 'other') return;
  const kind = m.type === 'cc' ? 'cc' : 'note';
  const k = keyOf(kind, m.channel, m.number);
  let s = seen.get(k);
  if (!s) {
    s = { kind, channel: m.channel, number: m.number, count: 0, last: 0, min: 127, max: 0, values: new Set(), port: m.port };
    seen.set(k, s);
  }
  if (m.type !== 'noteoff') {
    s.count++;
    s.last = m.value;
    s.min = Math.min(s.min, m.value);
    s.max = Math.max(s.max, m.value);
    if (s.values.size < 128) s.values.add(m.value);
  }
  const b = findBinding(mapping, kind, m.channel, m.number);
  if (!(hideJog.checked && b?.relative)) {
    const line = document.createElement('div');
    line.innerHTML = `${describe(m).replace(/ /g, '&nbsp;')} ${b ? `<span class="act">→ ${actionLabel(b.action)}</span>` : '<span class="muted">(sin mapear)</span>'}`;
    logEl.prepend(line);
    while (logEl.childElementCount > 300) logEl.lastElementChild?.remove();
  }
  queueRender();
  if (b) {
    const row = document.getElementById(`row-${mapping.indexOf(b)}`);
    row?.classList.add('flash');
    setTimeout(() => row?.classList.remove('flash'), 120);
  }
});

midi.onStatus((s) => {
  if (s.state === 'unsupported') {
    statusEl.innerHTML = '<div class="banner err">Este navegador no soporta Web MIDI. Abrí la página en <b>Chrome</b> o <b>Edge</b>.</div>';
    return;
  }
  if (s.state === 'denied') {
    statusEl.innerHTML = `<div class="banner err">No hay permiso para usar MIDI: ${s.error}</div>`;
    return;
  }
  const ports = s.inputs
    .map((p) => `<span class="dot ${p.state === 'connected' && p.connection === 'open' ? 'ok' : 'err'}"></span>${p.name} <span class="muted small">(${p.state}/${p.connection})</span>`)
    .join(' &nbsp; ');
  const errs = s.errors.map((e) => `<div class="banner err">${e}</div>`).join('');
  statusEl.innerHTML =
    errs +
    (s.controllerFound
      ? `<div class="banner ok">DJ2GO2 detectado. Entradas: ${ports}. LEDs: ${midi.output ? midi.output.name : 'sin salida'}</div>`
      : `<div class="banner warn">No veo el DJ2GO2. Entradas MIDI: ${ports || 'ninguna'}. Enchufalo por USB (se detecta solo).</div>`);
});

mapEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-led]') as HTMLButtonElement | null;
  if (!btn) return;
  const b = mapping[Number(btn.dataset.led)];
  midi.led(b.channel, b.number, btn.dataset.on === '1');
});

const ledBindings = (): Binding[] => mapping.filter((b) => b.kind === 'note' && b.led);

$('led-all').addEventListener('click', async () => {
  for (const b of ledBindings()) {
    midi.led(b.channel, b.number, true);
    document.getElementById(`row-${mapping.indexOf(b)}`)?.classList.add('flash');
    await new Promise((r) => setTimeout(r, 180));
    midi.led(b.channel, b.number, false);
    document.getElementById(`row-${mapping.indexOf(b)}`)?.classList.remove('flash');
  }
});
$('led-off').addEventListener('click', () => ledBindings().forEach((b) => midi.led(b.channel, b.number, false)));
$('clear').addEventListener('click', () => {
  logEl.innerHTML = '';
  seen.clear();
  queueRender();
});
$('copy').addEventListener('click', async () => {
  const report = {
    fecha: new Date().toISOString(),
    puertos: midi.status.state === 'ready' ? midi.status.inputs.map((p) => p.name) : [],
    confirmados: mapping
      .filter((b) => seen.has(keyOf(b.kind, b.channel, b.number)))
      .map((b) => ({ accion: b.action, control: bindingLabel(b), inferido: !!b.inferred })),
    sinVer: mapping.filter((b) => !seen.has(keyOf(b.kind, b.channel, b.number))).map((b) => ({ accion: b.action, control: bindingLabel(b) })),
    noMapeados: [...seen.values()]
      .filter((s) => !findBinding(mapping, s.kind, s.channel, s.number))
      .map((s) => ({ control: bindingLabel(s), veces: s.count, rango: `${s.min}-${s.max}` })),
  };
  await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
  $('copy').textContent = '¡Copiado!';
  setTimeout(() => ($('copy').textContent = 'Copiar reporte'), 1500);
});

window.addEventListener('beforeunload', () => ledBindings().forEach((b) => midi.led(b.channel, b.number, false)));

renderMap();
renderUnknown();
void midi.init();
