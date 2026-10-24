// Modo Fácil: una sola pantalla con intenciones ("pasar ya", "más energía", "drop"…). La IA hace
// toda la técnica; la persona decide qué suena, cuándo y con qué energía.
import { esc, type App } from '../app-types';
import { formatTime, type Track } from '../library';
import { curveAt, type EnergyCurve, type Grade } from '../autodj/ordering';
import { SamplerPads } from './sampler-pads';

const EVENTS: { id: string; label: string; curve: EnergyCurve; hint: string }[] = [
  { id: 'previa', label: '🍻 Previa', curve: [3, 4, 5, 6, 7], hint: 'Arranca tranqui y sube de a poco.' },
  { id: 'cumple', label: '🎂 Cumple', curve: [3, 5, 7, 8, 6], hint: 'Sube hasta el pico y baja al final.' },
  { id: 'cena', label: '🍷 Cena', curve: [2, 3, 3, 3, 2], hint: 'Suave y parejo, para charlar.' },
  { id: 'boliche', label: '🪩 Boliche', curve: [5, 6, 8, 9, 8], hint: 'Arriba casi todo el tiempo.' },
];

const GRADE_TXT: Record<Grade | 'basic', string> = {
  green: 'mezcla perfecto',
  yellow: 'se puede mezclar',
  red: 'conviene cambiarlo',
  basic: 'fundido simple (sin análisis)',
};

const CURVE_KEY = 'djv.easy.curve.v1';

export class EasyView {
  private app: App;
  private root: HTMLElement;
  private curve: EnergyCurve;
  private eventId = 'cumple';
  private hours = 2;
  private dragging = false;
  private search = '';
  private lastProgress = 0;
  private samplerUi: HTMLElement | null = null;
  private samplerReady = false;

  /** Se llama cuando el sampler terminó de cargar sus sonidos. */
  initSampler(): void {
    if (this.samplerReady || !this.samplerUi) return;
    this.samplerReady = true;
    new SamplerPads(this.app, this.samplerUi, true);
  }

  constructor(app: App, root: HTMLElement) {
    this.app = app;
    this.root = root;
    this.curve = [...EVENTS[1].curve] as EnergyCurve;
    try {
      const saved = JSON.parse(localStorage.getItem(CURVE_KEY) ?? 'null');
      if (saved?.curve?.length === 5) {
        this.curve = saved.curve;
        this.eventId = saved.eventId ?? this.eventId;
        this.hours = saved.hours ?? this.hours;
      }
    } catch {
      /* ignorar */
    }
    this.build();
    app.autodj.onEvent((e) => {
      if (e.type === 'mix-end') this.setHand(0);
    });
  }

  private saveCurve(): void {
    try {
      localStorage.setItem(CURVE_KEY, JSON.stringify({ curve: this.curve, eventId: this.eventId, hours: this.hours }));
    } catch {
      /* ignorar */
    }
  }

  private build(): void {
    this.root.innerHTML = `
      <div class="easy-grid">
        <div class="easy-main">
          <div class="card now">
            <div class="lbl">Suena ahora</div>
            <div class="e-title" id="e-now">Nada todavía</div>
            <div class="e-meta" id="e-now-meta"></div>
            <div class="e-bar"><div id="e-now-bar"></div></div>
          </div>
          <div class="card next">
            <div class="lbl">Viene después <span id="e-mixin" class="muted"></span></div>
            <div class="e-title" id="e-next">—</div>
            <div class="e-meta" id="e-next-meta"></div>
          </div>
          <div class="e-explain" id="e-explain"></div>
          <div class="e-start"><button id="e-go" class="primary big">▶ Arrancar la fiesta</button></div>
          <div class="intents">
            <button data-i="skip"><b>⏭ Pasar ya</b><span>en la próxima frase</span></button>
            <button data-i="extend"><b>♾ Que dure</b><span>repite esta parte</span></button>
            <button data-i="up"><b>⬆ Más energía</b><span>lo próximo sube</span></button>
            <button data-i="down"><b>⬇ Bajar un cambio</b><span>lo próximo baja</span></button>
          </div>
          <div class="moments">
            <button data-m="drop">💥 Drop</button>
            <button data-m="break">🌊 Break</button>
            <button data-m="echo">🔁 Salida con eco</button>
            <button data-m="spin">⏪ Rebobinar</button>
            <button data-hold="roll">🌀 Roll <span class="small muted">(mantené)</span></button>
          </div>
          <div class="card" id="e-sampler"></div>
          <div class="hand">
            <div class="lbl">Mezclá vos <span class="muted small">— arrastrá y la IA iguala el tempo y los graves</span></div>
            <div class="hand-row"><span>Ahora</span><input type="range" id="e-hand" min="0" max="1" step="0.001" value="0" /><span>Próximo</span></div>
          </div>
        </div>
        <div class="easy-side">
          <div class="card">
            <div class="lbl">¿Qué fiesta es?</div>
            <div class="chips" id="e-events">${EVENTS.map((e) => `<button data-ev="${e.id}">${e.label}</button>`).join('')}</div>
            <div class="muted small" id="e-ev-hint"></div>
            <div class="row small" style="margin-top:6px">Dura
              <select id="e-hours">${[1, 2, 3, 4, 5].map((h) => `<option value="${h}">${h} h</option>`).join('')}</select>
              <span class="muted" id="e-dur"></span>
            </div>
            <div class="lbl" style="margin-top:8px">Curva de energía <span class="muted small">— arrastrá los puntos</span></div>
            <svg id="e-curve" viewBox="0 0 300 120" preserveAspectRatio="none"></svg>
            <div class="row"><button id="e-build" class="primary">✨ Armar el set</button>
              <label class="filebtn small">+ Temas<input type="file" id="e-files" accept="audio/*,.mp3,.wav,.flac,.ogg,.m4a" multiple hidden /></label>
              <input type="url" id="e-yt" placeholder="o pegá un link de YouTube" style="flex:1;min-width:120px" />
            </div>
          </div>
          <div class="card">
            <div class="lbl">Pedidos</div>
            <input type="text" id="e-search" placeholder="Buscá un tema…" style="width:100%" />
            <ul class="e-results" id="e-results"></ul>
          </div>
          <div class="card">
            <div class="lbl">Lo que viene</div>
            <ol class="e-list" id="e-list"></ol>
          </div>
        </div>
      </div>`;
    const $ = (s: string) => this.root.querySelector(s) as HTMLElement;
    const app = this.app;
    $('#e-go').addEventListener('click', () => {
      app.resumeAudio();
      const ad = app.autodj;
      if (ad.enabled) {
        const cur = ad.currentDeck;
        if (cur) cur.togglePlay();
        return;
      }
      if (!ad.queue.length && !app.fillQueue()) {
        app.toast('Primero agregá temas: arrastralos a la ventana o usá "+ Temas".');
        return;
      }
      if (ad.queue.length > 1) ad.applyCurve(this.curve);
      ad.start();
    });
    this.root.querySelector('.intents')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-i]') as HTMLElement | null;
      if (!b) return;
      app.resumeAudio();
      const ad = app.autodj;
      if (!ad.enabled) return app.toast('Primero arrancá la fiesta.');
      ({ skip: () => ad.skipNow(), extend: () => ad.extend(), up: () => ad.nudgeEnergy(1), down: () => ad.nudgeEnergy(-1) })[b.dataset.i as 'skip']();
    });
    this.root.querySelector('.moments')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-m]') as HTMLElement | null;
      if (!b) return;
      const ad = app.autodj;
      if (!ad.enabled) return app.toast('Primero arrancá la fiesta.');
      ({ drop: () => ad.drop(), break: () => ad.breakdown(), echo: () => ad.skipNow('echo'), spin: () => ad.skipNow('spin') })[b.dataset.m as 'drop']();
    });
    const roll = this.root.querySelector('[data-hold="roll"]') as HTMLElement;
    roll.addEventListener('pointerdown', () => {
      const cur = app.autodj.currentDeck;
      if (!cur?.playing) return app.toast('El roll necesita un tema sonando.');
      cur.rollStart(0.25);
    });
    const rollUp = () => app.autodj.currentDeck?.rollStop();
    roll.addEventListener('pointerup', rollUp);
    roll.addEventListener('pointerleave', rollUp);
    const hand = $('#e-hand') as HTMLInputElement;
    hand.addEventListener('pointerdown', () => (this.dragging = true));
    hand.addEventListener('pointerup', () => (this.dragging = false));
    hand.addEventListener('input', () => {
      const ad = app.autodj;
      const inc = ad.mixDecks?.inc ?? ad.preparedDeck;
      if (!ad.enabled || !inc) return;
      const sIn = inc.id === 'A' ? -1 : 1;
      ad.manualXf((2 * Number(hand.value) - 1) * sIn);
    });
    $('#e-events').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-ev]') as HTMLElement | null;
      if (!b) return;
      const ev = EVENTS.find((x) => x.id === b.dataset.ev)!;
      this.eventId = ev.id;
      this.curve = [...ev.curve] as EnergyCurve;
      this.saveCurve();
      this.renderSetup();
    });
    ($('#e-hours') as HTMLSelectElement).addEventListener('change', (e) => {
      this.hours = Number((e.target as HTMLSelectElement).value);
      this.saveCurve();
      this.renderSetup();
    });
    $('#e-build').addEventListener('click', () => {
      const ad = app.autodj;
      if (!ad.queue.length) app.fillQueue();
      if (!ad.queue.length) return app.toast('Primero agregá temas.');
      ad.applyCurve(this.curve);
      app.toast('Set armado siguiendo tu curva de energía.');
    });
    ($('#e-files') as HTMLInputElement).addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.files) app.addFiles(input.files);
      input.value = '';
    });
    ($('#e-yt') as HTMLInputElement).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const input = e.target as HTMLInputElement;
      const yt = document.querySelector('#yt-url') as HTMLInputElement;
      yt.value = input.value;
      (document.querySelector('#yt-add') as HTMLButtonElement).click();
      input.value = '';
      const t = app.tracks.at(-1);
      if (t?.source === 'youtube') app.autodj.addToQueue(t);
    });
    ($('#e-search') as HTMLInputElement).addEventListener('input', (e) => {
      this.search = (e.target as HTMLInputElement).value;
      this.renderSearch();
    });
    $('#e-results').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-req]') as HTMLElement | null;
      if (!b) return;
      const t = app.tracks.find((x) => x.id === b.dataset.req);
      if (!t) return;
      if (!app.autodj.enabled) {
        app.autodj.addToQueue(t);
        app.toast(`En la cola: ${t.title}`);
      } else app.autodj.request(t);
      this.search = '';
      ($('#e-search') as HTMLInputElement).value = '';
      this.renderSearch();
    });
    $('#e-list').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-swap]') as HTMLElement | null;
      if (!b) return;
      const t = app.autodj.queue.find((x) => x.id === b.dataset.swap);
      if (!t) return;
      app.autodj.removeFromQueue(t);
      app.autodj.addToQueue(t);
      app.toast('Lo mandé al final del set.');
    });
    this.buildCurve();
    this.renderSetup();
    this.samplerUi = this.root.querySelector('#e-sampler') as HTMLElement;
    this.renderSearch();
  }

  private buildCurve(): void {
    const svg = this.root.querySelector('#e-curve') as SVGSVGElement;
    let drag = -1;
    const toY = (v: number) => 110 - ((v - 1) / 9) * 100;
    const fromY = (y: number) => Math.max(1, Math.min(10, 1 + ((110 - y) / 100) * 9));
    const pt = (e: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * 300, y: ((e.clientY - r.top) / r.height) * 120 };
    };
    svg.addEventListener('pointerdown', (e) => {
      const { x } = pt(e);
      drag = Math.max(0, Math.min(4, Math.round((x - 10) / 70)));
      svg.setPointerCapture(e.pointerId);
      this.curve[drag] = Math.round(fromY(pt(e).y) * 2) / 2;
      this.drawCurve();
    });
    svg.addEventListener('pointermove', (e) => {
      if (drag < 0 || !svg.hasPointerCapture(e.pointerId)) return;
      this.curve[drag] = Math.round(fromY(pt(e).y) * 2) / 2;
      this.drawCurve();
    });
    svg.addEventListener('pointerup', () => {
      drag = -1;
      this.saveCurve();
    });
    void toY;
    this.drawCurve();
  }

  private drawCurve(): void {
    const svg = this.root.querySelector('#e-curve') as SVGSVGElement;
    const toY = (v: number) => 110 - ((v - 1) / 9) * 100;
    let d = '';
    for (let i = 0; i <= 60; i++) {
      const x = i / 60;
      d += `${i ? 'L' : 'M'}${10 + x * 280},${toY(curveAt(this.curve, x)).toFixed(1)} `;
    }
    // Posición actual del set (aprox.: temas ya sonados / total)
    const total = this.app.autodj.queue.length + 1;
    const played = this.app.tracks.length - total;
    const at = this.app.autodj.enabled && this.app.tracks.length ? Math.max(0, played) / Math.max(1, this.app.tracks.length) : -1;
    svg.innerHTML = `
      <path d="${d} L290,115 L10,115 Z" fill="var(--ai)" opacity="0.15"></path>
      <path d="${d}" fill="none" stroke="var(--ai)" stroke-width="2.5"></path>
      ${at >= 0 ? `<line x1="${10 + at * 280}" x2="${10 + at * 280}" y1="5" y2="115" stroke="var(--text)" stroke-dasharray="3 3" opacity="0.6"></line>` : ''}
      ${this.curve.map((v, i) => `<circle cx="${10 + i * 70}" cy="${toY(v)}" r="7" fill="var(--panel)" stroke="var(--ai)" stroke-width="2.5" style="cursor:ns-resize"></circle>`).join('')}
      <text x="12" y="12" font-size="9" fill="var(--muted)">más energía</text><text x="12" y="113" font-size="9" fill="var(--muted)">tranqui</text>`;
  }

  private renderSetup(): void {
    this.root.querySelectorAll('#e-events button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.ev === this.eventId));
    const ev = EVENTS.find((e) => e.id === this.eventId);
    (this.root.querySelector('#e-ev-hint') as HTMLElement).textContent = ev?.hint ?? '';
    (this.root.querySelector('#e-hours') as HTMLSelectElement).value = String(this.hours);
    const secs = this.app.tracks.reduce((s, t) => s + (t.duration || 0), 0);
    const need = this.hours * 3600;
    (this.root.querySelector('#e-dur') as HTMLElement).textContent = this.app.tracks.length
      ? secs >= need
        ? `· tenés ${formatHours(secs)} de música ✔`
        : `· tenés ${formatHours(secs)} de música: sumá temas o el set va a terminar antes`
      : '';
    this.drawCurve();
  }

  private renderSearch(): void {
    const q = this.search.trim().toLowerCase();
    const ul = this.root.querySelector('#e-results') as HTMLElement;
    if (!q) {
      ul.innerHTML = '';
      return;
    }
    const hits = this.app.tracks.filter((t) => t.title.toLowerCase().includes(q)).slice(0, 6);
    ul.innerHTML = hits.length
      ? hits.map((t) => `<li><span>${esc(t.title)}</span><button data-req="${t.id}">Pedir</button></li>`).join('')
      : '<li class="muted small">No encontré ese tema en tu biblioteca.</li>';
  }

  private setHand(v: number): void {
    const hand = this.root.querySelector('#e-hand') as HTMLInputElement;
    if (!this.dragging) hand.value = String(v);
  }

  /** Render liviano: se llama en cada frame. */
  frame(): void {
    const app = this.app;
    const ad = app.autodj;
    const cur = ad.currentDeck;
    const set = (id: string, txt: string) => {
      const el = this.root.querySelector(id) as HTMLElement;
      if (el.textContent !== txt) el.textContent = txt;
    };
    if (cur?.track) {
      const pos = cur.position();
      const a = cur.analysis;
      set('#e-now', cur.track.title);
      set('#e-now-meta', `${a ? `${(a.bpm * cur.tempo).toFixed(0)} BPM · ${a.camelot} · energía ${a.energy.toFixed(1)} · ` : ''}quedan ${formatTime(cur.duration - pos)}`);
      (this.root.querySelector('#e-now-bar') as HTMLElement).style.width = `${cur.duration ? (pos / cur.duration) * 100 : 0}%`;
    } else {
      set('#e-now', ad.enabled ? 'Preparando…' : 'Nada todavía');
      set('#e-now-meta', ad.enabled ? ad.status : 'Elegí el tipo de fiesta, agregá temas y dale "Arrancar".');
    }
    const next = ad.mixDecks?.inc.track ?? ad.preparedTrack ?? ad.queue[0] ?? null;
    set('#e-next', next ? next.title : '—');
    const g = ad.mixDecks ? null : ad.preparedGrade();
    const nextEl = this.root.querySelector('#e-next-meta') as HTMLElement;
    const nextHtml = next
      ? `${g ? `<span class="gdot ${g}"></span>${GRADE_TXT[g]}` : ''}${next.analysis ? ` · ${next.analysis.bpm.toFixed(0)} BPM · ${next.analysis.camelot}` : next.source === 'youtube' ? ' · YouTube' : ''}`
      : ad.enabled
        ? 'La cola está vacía: pedí o agregá temas.'
        : '';
    if (nextEl.innerHTML !== nextHtml) nextEl.innerHTML = nextHtml;
    const s = ad.secondsToMix();
    const p = ad.mixProgress();
    set('#e-mixin', p !== null ? `· mezclando ${Math.round(p * 100)} %` : s !== null && ad.preparedTrack ? `· mezcla en ${formatTime(s)}` : '');
    set('#e-explain', ad.mixing || ad.now - ad.explainAt < 6 ? ad.lastExplain : '');
    const go = this.root.querySelector('#e-go') as HTMLElement;
    set('#e-go', !ad.enabled ? '▶ Arrancar la fiesta' : cur?.playing ? '❚❚ Pausa' : '▶ Seguir');
    go.classList.toggle('on', ad.enabled && !!cur?.playing);
    // La mano: acompaña la mezcla automática si no la estás moviendo.
    if (p !== null) this.setHand(p);
    else if (this.lastProgress !== 0 && !ad.mixing) this.setHand(0);
    this.lastProgress = p ?? 0;
  }

  /** Render de la lista (cuando cambia la cola). */
  render(): void {
    const ad = this.app.autodj;
    const grades = ad.queueGrades();
    const list = this.root.querySelector('#e-list') as HTMLElement;
    list.innerHTML = ad.queue.length
      ? ad.queue
          .slice(0, 12)
          .map(
            (t: Track, i) =>
              `<li><span class="gdot ${grades[i]}" title="${GRADE_TXT[grades[i]]}"></span><span class="qt">${esc(t.title)}</span>${t.analysis ? `<span class="small muted">E${t.analysis.energy.toFixed(0)}</span>` : ''}${grades[i] === 'red' ? `<button data-swap="${t.id}" title="Mandarlo al final">cambiar</button>` : ''}</li>`,
          )
          .join('') + (ad.queue.length > 12 ? `<li class="muted small">y ${ad.queue.length - 12} más…</li>` : '')
      : '<li class="muted small">Sin temas en cola.</li>';
    this.renderSetup();
  }
}

function formatHours(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
