// Auto-DJ: arma el set, prepara el próximo tema en el deck libre y mezcla en frases con
// beatmatching, bass swap, crossfade y filtro. Modo híbrido: si tocás un deck, la IA te lo cede.
// También expone "intenciones" (pasar ya, que dure, más/menos energía, pedidos, momentos) para el
// Modo Fácil, y control por parámetro (userParams) para las lecciones del Modo Aprender.
import type { Deck } from '../audio/deck';
import type { Mixer } from '../audio/mixer';
import { beatIndex, beatTime, barStartBeat, firstDownbeat, type Analysis, type Track } from '../library';
import { describeTransition, orderSet, orderToCurve, orderWithBias, transitionCost, transitionGrade, type EnergyCurve, type Grade, type SetItem } from './ordering';
import { bendForPhaseError, phaseError, planMix, planSoon, type MixPlan } from './plan';

export type AutoState = 'off' | 'starting' | 'playing' | 'scheduled' | 'mixing' | 'waiting';
export type MixStyle = 'blend' | 'echo' | 'spin' | 'basic';
export type AutoEvent = { type: 'mix-start'; out: Deck; inc: Deck } | { type: 'mix-end'; out: Deck; inc: Deck } | { type: 'entry'; errorMs: number; byAi: boolean };

interface Mix {
  plan: MixPlan;
  out: Deck;
  inc: Deck;
  /** Tiempo del contexto en que arranca la mezcla (compás 0). */
  t0: number;
  /** El entrante ya está sonando y alineado. */
  startedIn: boolean;
  style: MixStyle;
  /** Mezcla guiada por el crossfader del usuario (crossfader asistido). */
  manual: boolean;
}

interface Moment {
  kind: 'drop' | 'break';
  deck: Deck;
  t1: number; // inicio (contexto)
  t2: number; // fin / "suelta" (contexto)
}

const KILL_DB = -40;
/** Duración del crossfade en modo básico (YouTube). */
const BASIC_FADE_SEC = 12;

/** Rampa suave 0..1 entre a y b. */
function ramp(p: number, a: number, b: number): number {
  if (p <= a) return 0;
  if (p >= b) return 1;
  const x = (p - a) / (b - a);
  return x * x * (3 - 2 * x);
}

function itemOf(t: Track, tempo = 1): SetItem & { duration: number } {
  const a = t.analysis!;
  return { id: t.id, bpm: a.bpm * tempo, camelot: a.camelot, energy: a.energy, duration: t.duration || a.duration };
}

/** Próximo límite de `gridBars` compases (tiempo del tema) al menos `minLead` s adelante. */
function nextBoundary(a: Analysis, pos: number, gridBars: number, minLead: number): number {
  const beatSec = 60 / a.bpm;
  const d0 = barStartBeat(a, 0);
  const bar = Math.max(0, Math.ceil((pos + minLead - beatTime(a, d0)) / (4 * beatSec) / gridBars) * gridBars);
  return beatTime(a, d0 + bar * 4);
}

export class AutoDJ {
  state: AutoState = 'off';
  queue: Track[] = [];
  bars: 16 | 32 = 16;
  /** Después de una mezcla, llevar de a poco el tempo del tema nuevo a su BPM original. */
  tempoGlide = true;
  status = 'Auto-DJ apagado';
  log: string[] = [];
  /** Modo Fácil / Aprender: tocar controles no le saca el deck a la IA. */
  noTakeover = false;
  /** Parámetros que maneja el usuario aunque la IA tenga el deck: 'xf', 'A.low', 'B.play', 'B.tempo'… */
  readonly userParams = new Set<string>();
  /** Explicación corta de lo último que hizo la IA (para aprender mirando). */
  lastExplain = '';
  /** Cuándo (reloj de audio) se actualizó la explicación. */
  explainAt = 0;

  private decks: { A: Deck; B: Deck };
  private mixer: Mixer;
  private current: Deck | null = null;
  private prepared: { deck: Deck; track: Track } | null = null;
  private mix: Mix | null = null;
  private preparing = false;
  private glide: { deck: Deck; from: number; t0: number; dur: number } | null = null;
  private forced: { plan: MixPlan; style: MixStyle } | null = null;
  private skipRequested: MixStyle | null = null;
  private extendOff: { deck: Deck; at: number } | null = null;
  private moment: Moment | null = null;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: AutoEvent) => void>();
  private ticker: Worker;
  private tickListeners = new Set<(now: number) => void>();

  constructor(decks: { A: Deck; B: Deck }, mixer: Mixer) {
    this.decks = decks;
    this.mixer = mixer;
    // Timer en un worker: los setInterval del hilo principal se frenan con la pestaña en segundo plano.
    const src = 'setInterval(() => postMessage(0), 40);';
    this.ticker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    this.ticker.onmessage = () => {
      this.tick();
      const now = this.now;
      this.tickListeners.forEach((l) => l(now));
    };
    for (const d of [decks.A, decks.B]) d.onEnded(() => this.onDeckEnded(d));
  }

  get now(): number {
    return this.decks.A.engine.ctx.currentTime;
  }

  onChange(cb: () => void): void {
    this.listeners.add(cb);
  }

  onEvent(cb: (e: AutoEvent) => void): void {
    this.eventListeners.add(cb);
  }

  /** Se llama en cada tick del reloj del Auto-DJ (40 ms), aunque esté apagado. */
  onTick(cb: (now: number) => void): void {
    this.tickListeners.add(cb);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  private fire(e: AutoEvent): void {
    this.eventListeners.forEach((l) => l(e));
  }

  private say(msg: string, toLog = true): void {
    if (!toLog && msg === this.status) return;
    this.status = msg;
    if (toLog) {
      const t = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      this.log.unshift(`${t} · ${msg}`);
      this.log.length = Math.min(this.log.length, 60);
    }
    this.emit();
  }

  private explain(msg: string): void {
    this.explainAt = this.now;
    if (msg === this.lastExplain) return;
    this.lastExplain = msg;
    this.emit();
  }

  get enabled(): boolean {
    return this.state !== 'off';
  }

  other(d: Deck): Deck {
    return d === this.decks.A ? this.decks.B : this.decks.A;
  }

  private xfIsAi(): boolean {
    return this.mixer.xfOwner === 'ai' && !this.userParams.has('xf');
  }

  private aiOwns(d: Deck, param: string): boolean {
    return d.owner === 'ai' && !this.userParams.has(`${d.id}.${param}`);
  }

  // ---------------------------------------------------------------- consultas para la UI

  get currentDeck(): Deck | null {
    return this.current;
  }

  get preparedDeck(): Deck | null {
    return this.prepared?.deck ?? null;
  }

  get preparedTrack(): Track | null {
    return this.prepared?.track ?? null;
  }

  get mixing(): boolean {
    return !!this.mix;
  }

  get mixDecks(): { out: Deck; inc: Deck; plan: MixPlan; t0: number; manual: boolean } | null {
    const m = this.mix;
    return m ? { out: m.out, inc: m.inc, plan: m.plan, t0: m.t0, manual: m.manual } : null;
  }

  /** Plan de la próxima mezcla (si ya hay un tema preparado), sin ejecutarlo. */
  nextPlan(): MixPlan | null {
    if (this.mix) return this.mix.plan;
    const cur = this.current;
    const p = this.prepared;
    if (!cur || !p) return null;
    if (this.forced) return this.forced.plan;
    const outA = cur.analysis;
    const inA = p.track.analysis;
    if (!outA || !inA) return null;
    return planMix(outA, cur.tempo, cur.position(), inA, this.bars, 0.1);
  }

  /** Segundos reales hasta que arranque la próxima mezcla (null si no se sabe). */
  secondsToMix(): number | null {
    const cur = this.current;
    if (!cur) return null;
    if (this.mix) return 0;
    const plan = this.nextPlan();
    if (plan) return Math.max(0, (plan.outStart - cur.position()) / (cur.tempo || 1));
    if (this.prepared && cur.duration) {
      const end = cur.analysis?.audioEnd ?? cur.duration;
      return Math.max(0, (end - cur.position()) / (cur.tempo || 1) - BASIC_FADE_SEC);
    }
    return null;
  }

  /**
   * Compás (fraccional) respecto del inicio de la próxima mezcla o de la actual: negativo antes,
   * 0 = arranca, `plan.bars` = termina. Se mide sobre el tema saliente.
   */
  barToMix(): number | null {
    const cur = this.mix?.out ?? this.current;
    const a = cur?.analysis;
    const plan = this.nextPlan();
    if (!cur || !a || !plan) return null;
    return (cur.position() - plan.outStart) / ((4 * 60) / a.bpm);
  }

  /** Progreso de la mezcla actual (0..1) o null. */
  mixProgress(): number | null {
    const m = this.mix;
    if (!m) return null;
    if (m.manual) return this.manualProgress(m);
    return Math.max(0, Math.min(1, (this.now - m.t0) / m.plan.realDuration));
  }

  /** Semáforo de cada pasaje: [actual→1º de la cola, 1º→2º, …]. */
  queueGrades(): (Grade | 'basic')[] {
    const out: (Grade | 'basic')[] = [];
    let prev: Track | null = this.prepared?.track ?? this.current?.track ?? null;
    const seq = this.prepared ? this.queue : this.queue;
    for (const t of seq) {
      out.push(prev?.analysis && t.analysis ? transitionGrade(itemOf(prev), itemOf(t)) : 'basic');
      prev = t;
    }
    return out;
  }

  /** Semáforo del pasaje entre lo que suena y lo que está preparado. */
  preparedGrade(): Grade | 'basic' | null {
    const a = this.current?.track;
    const b = this.prepared?.track;
    if (!a || !b) return null;
    return a.analysis && b.analysis ? transitionGrade(itemOf(a, this.current!.tempo), itemOf(b)) : 'basic';
  }

  // ---------------------------------------------------------------- cola

  addToQueue(t: Track): void {
    if (!this.queue.includes(t) && this.prepared?.track !== t && this.current?.track !== t) this.queue.push(t);
    this.emit();
  }

  removeFromQueue(t: Track): void {
    this.queue = this.queue.filter((x) => x !== t);
    this.emit();
  }

  moveInQueue(t: Track, dir: number): void {
    const i = this.queue.indexOf(t);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.queue.length) return;
    [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    this.emit();
  }

  /** Ordena la cola con la IA (BPM, Camelot, energía), arrancando del tema que suena si hay uno. */
  sortQueue(): void {
    this.unprepare();
    const ready = this.queue.filter((t) => t.analysis);
    const notReady = this.queue.filter((t) => !t.analysis);
    const items = ready.map((t) => ({ t, ...itemOf(t) }));
    const playing = this.current?.track?.analysis;
    let ordered: typeof items;
    if (playing && this.current?.track) {
      const anchor = { t: this.current.track, ...itemOf(this.current.track, this.current.tempo), id: '__now' };
      ordered = orderSet([anchor, ...items], anchor).slice(1);
    } else {
      ordered = orderSet(items);
    }
    this.queue = [...ordered.map((o) => o.t), ...notReady];
    const lines: string[] = [];
    for (let i = 1; i < Math.min(ordered.length, 6); i++) lines.push(describeTransition(ordered[i - 1], ordered[i]));
    const yt = notReady.filter((t) => t.source === 'youtube').length;
    const pend = notReady.length - yt;
    this.say(`Set ordenado (${ordered.length} temas analizados${pend ? `, ${pend} pendientes al final` : ''}${yt ? `, ${yt} de YouTube al final: se mezclan con crossfade` : ''}).`);
    if (lines.length) this.log.splice(1, 0, ...lines.map((l) => `   ${l}`));
    this.emit();
  }

  /** Ordena la cola siguiendo una curva de energía (Modo Fácil: tipo de evento). */
  applyCurve(curve: EnergyCurve): void {
    this.unprepare();
    const ready = this.queue.filter((t) => t.analysis);
    const notReady = this.queue.filter((t) => !t.analysis);
    const first = this.current?.track?.analysis ? itemOf(this.current.track, this.current.tempo) : undefined;
    const ordered = orderToCurve(
      ready.map((t) => ({ t, ...itemOf(t) })),
      curve,
      first,
    );
    this.queue = [...ordered.map((o) => o.t), ...notReady];
    this.say(`Set armado siguiendo la curva de energía (${ordered.length} temas).`);
  }

  /** Devuelve el tema preparado a la cola (si la mezcla no arrancó) para poder reordenar. */
  private unprepare(): void {
    if (!this.prepared || this.mix) return;
    const t = this.prepared.track;
    this.prepared = null;
    this.forced = null;
    if (!this.queue.includes(t)) this.queue.unshift(t);
  }

  // ---------------------------------------------------------------- intenciones (Modo Fácil)

  /** Más energía (+1) o bajar un cambio (-1): reordena lo que viene. */
  nudgeEnergy(dir: 1 | -1): void {
    const cur = this.current?.track;
    if (!cur?.analysis) {
      this.say('Necesito un tema analizado sonando para saber hacia dónde ir.');
      return;
    }
    this.unprepare();
    const ready = this.queue.filter((t) => t.analysis);
    const notReady = this.queue.filter((t) => !t.analysis);
    const ordered = orderWithBias(
      ready.map((t) => ({ t, ...itemOf(t) })),
      itemOf(cur, this.current!.tempo),
      dir,
    );
    this.queue = [...ordered.map((o) => o.t), ...notReady];
    const next = this.queue[0];
    this.say(dir > 0 ? `Subimos: lo próximo es "${next?.title ?? '—'}" (energía ${next?.analysis?.energy.toFixed(1) ?? '?'}).` : `Bajamos un cambio: lo próximo es "${next?.title ?? '—'}" (energía ${next?.analysis?.energy.toFixed(1) ?? '?'}).`);
    void this.prepareNext();
  }

  /** Pedido: lo mete lo antes posible sin romper la mezcla. Devuelve en cuántos temas entra. */
  request(t: Track): number {
    this.removeFromQueue(t);
    if (this.current?.track === t) {
      this.say(`"${t.title}" ya está sonando.`);
      return 0;
    }
    if (this.prepared?.track === t) {
      this.say(`"${t.title}" es el próximo.`);
      return 1;
    }
    const canReplace = !this.mix;
    if (canReplace) this.unprepare();
    const cur = this.current?.track;
    let pos = 0;
    if (cur?.analysis && t.analysis) {
      const direct = transitionCost(itemOf(cur, this.current!.tempo), itemOf(t));
      if (direct > 4.5) {
        // Buscamos un tema "puente" que deje bien parado al pedido.
        let best = -1;
        let bc = direct;
        this.queue.forEach((b, i) => {
          if (!b.analysis) return;
          const c = transitionCost(itemOf(cur), itemOf(b)) + transitionCost(itemOf(b), itemOf(t));
          if (c / 2 < bc) {
            bc = c / 2;
            best = i;
          }
        });
        if (best >= 0) {
          const [bridge] = this.queue.splice(best, 1);
          this.queue.unshift(bridge);
          pos = 1;
        }
      }
    }
    if (!canReplace) pos += 1; // ya hay una mezcla en curso con otro tema
    this.queue.splice(pos - (canReplace ? 0 : 1), 0, t);
    const n = pos + 1;
    this.say(n === 1 ? `Pedido: "${t.title}" entra después de este tema.` : `Pedido: "${t.title}" entra en ${n} temas (antes pongo uno que lo deja bien parado).`);
    void this.prepareNext();
    return n;
  }

  /** Pasar al próximo tema ya: en la próxima frase corta (4 compases). style 'echo' = salida con eco. */
  skipNow(style: MixStyle = 'blend'): void {
    if (this.mix) {
      this.say('Ya estoy mezclando.');
      return;
    }
    if (!this.current) return;
    this.skipRequested = style;
    this.forced = null;
    this.say(style === 'echo' ? 'Salida con eco en el próximo compás.' : 'Paso al próximo tema en la próxima frase.');
  }

  /** "Me encanta, que dure": repite la frase de 8 compases que está sonando una vez más. */
  extend(): void {
    const d = this.current;
    const a = d?.analysis;
    if (!d || !a || this.mix) {
      this.say(this.mix ? 'Ya estoy mezclando: no puedo alargar ahora.' : 'Para alargar necesito un tema analizado sonando.');
      return;
    }
    const beatSec = 60 / a.bpm;
    const d0 = barStartBeat(a, 0);
    const pos = d.position();
    const bar = Math.floor((pos - beatTime(a, d0)) / (4 * beatSec));
    const start = beatTime(a, d0 + Math.floor(bar / 8) * 32);
    const end = start + 32 * beatSec;
    if (end > a.audioEnd) {
      this.say('Estamos en el final del tema: no hay una frase entera para repetir.');
      return;
    }
    d.loop = { on: true, start, end, beats: 32 };
    d.emit();
    d.node?.port.postMessage({ type: 'loop', on: true, start, end });
    const now = this.now;
    this.extendOff = { deck: d, at: now + (end - pos + (end - start) - 0.05) / d.tempo };
    this.forced = null;
    this.say('Que dure: repito esta frase de 8 compases una vez más.');
  }

  /** Drop: sube un filtro y saca los graves durante 2 compases y suelta todo en el compás 1. */
  drop(): void {
    this.startMoment('drop');
  }

  /** Break: saca los graves 4 compases y vuelven en el compás 1. */
  breakdown(): void {
    this.startMoment('break');
  }

  private startMoment(kind: Moment['kind']): void {
    const d = this.current;
    const a = d?.analysis;
    if (!d || !a || !d.playing) {
      this.say('Los momentos necesitan un tema analizado sonando.');
      return;
    }
    if (this.mix) {
      this.say('Ahora estoy mezclando: probá después de la transición.');
      return;
    }
    const now = this.now;
    const pos = d.position();
    const beatSec = 60 / a.bpm;
    let t1: number;
    let t2: number;
    if (kind === 'drop') {
      const b = nextBoundary(a, pos, 4, 2 * 4 * beatSec);
      t1 = now;
      t2 = now + (b - pos) / d.tempo;
    } else {
      const b1 = nextBoundary(a, pos, 1, 0.1);
      t1 = now + (b1 - pos) / d.tempo;
      t2 = t1 + (4 * 4 * beatSec) / d.tempo;
    }
    this.moment = { kind, deck: d, t1, t2 };
    this.say(kind === 'drop' ? `Drop en ${Math.round(t2 - now)} s: subo la tensión y suelto en el compás 1.` : 'Break: saco los graves 4 compases.');
  }

  private updateMoment(now: number): void {
    const m = this.moment;
    if (!m) return;
    const d = m.deck;
    if (d !== this.current || this.mix) {
      d.setFilter(0);
      d.setEq('low', 0);
      this.moment = null;
      return;
    }
    if (now >= m.t2) {
      d.setFilter(0);
      d.setEq('low', 0);
      this.moment = null;
      this.explain(m.kind === 'drop' ? '¡Drop! Volvieron los graves justo en el compás 1.' : 'Volvieron los graves en el compás 1.');
      return;
    }
    if (now < m.t1) return;
    const p = (now - m.t1) / (m.t2 - m.t1);
    if (m.kind === 'drop') {
      d.setFilter(0.7 * ramp(p, 0, 1));
      d.setEq('low', KILL_DB * ramp(p, 0.5, 0.9));
      this.explain('Drop: el filtro pasa altos va subiendo la tensión; los graves se van para volver de golpe.');
    } else {
      d.setEq('low', KILL_DB * ramp(p, 0, 0.03));
      this.explain('Break: sin graves, la pista "respira" y el regreso pega más.');
    }
  }

  // ---------------------------------------------------------------- crossfader asistido

  /** El usuario mueve el crossfader en Modo Fácil: la mezcla sigue su mano y la IA hace el resto. */
  manualXf(x: number): void {
    this.mixer.setCrossfader(x);
    if (!this.enabled) return;
    const m = this.mix;
    if (m) {
      if (!m.manual) {
        m.manual = true;
        this.say('Tomaste el crossfader: la mezcla sigue tu mano; yo me ocupo del tempo y los graves.');
      }
      return;
    }
    const cur = this.current;
    const prep = this.prepared;
    if (!cur || !prep || !cur.playing) return;
    const s = this.sideProgress(prep.deck, x);
    if (s < 0.1) return;
    const now = this.now;
    const outA = cur.analysis;
    const inA = prep.track.analysis;
    let plan: MixPlan;
    let t0 = now;
    if (outA && inA) {
      const pos = cur.position(now);
      plan = planSoon(outA, cur.tempo, pos, inA, 16, 1, 0.15);
      t0 = now + (plan.outStart - pos) / cur.tempo;
    } else {
      plan = { outStart: cur.position(now), bars: 0, realDuration: 8, inCue: inA ? firstDownbeat(inA) : 0, tempoIn: 1, mult: 1, beatmatch: false };
    }
    this.launchMix(plan, cur, prep.deck, t0, outA && inA ? 'blend' : 'basic', true);
  }

  /** 0 = todo el saliente, 1 = todo el entrante, según de qué lado está el entrante. */
  private sideProgress(inc: Deck, x: number): number {
    const sIn = inc.id === 'A' ? -1 : 1;
    return Math.max(0, Math.min(1, (x * sIn + 1) / 2));
  }

  private manualProgress(m: Mix): number {
    return this.sideProgress(m.inc, this.mixer.crossfader);
  }

  // ---------------------------------------------------------------- encendido

  start(): void {
    if (this.enabled) return;
    const playing = [this.decks.A, this.decks.B].find((d) => d.playing && (d.mode === 'local' || d.mode === 'youtube'));
    this.state = 'starting';
    this.decks.A.setOwner('ai');
    this.decks.B.setOwner('ai');
    this.mixer.setXfOwner('ai');
    if (playing) {
      this.current = playing;
      this.say(`Auto-DJ encendido: sigo desde el Deck ${playing.id}.`);
      this.state = 'playing';
      void this.prepareNext();
    } else {
      this.current = null;
      void this.startFirst();
    }
    this.emit();
  }

  stop(): void {
    if (!this.enabled) return;
    if (this.mix) this.abortMix(false);
    this.state = 'off';
    this.prepared = null;
    this.glide = null;
    this.forced = null;
    this.skipRequested = null;
    this.moment = null;
    this.decks.A.setOwner('user');
    this.decks.B.setOwner('user');
    this.mixer.setXfOwner('user');
    this.say('Auto-DJ apagado: todo el control es tuyo.');
  }

  /** El usuario devuelve un deck (o el crossfader) a la IA. */
  giveBack(what: Deck | 'xf'): void {
    if (what === 'xf') this.mixer.setXfOwner('ai');
    else what.setOwner('ai');
    if (this.enabled && !this.prepared && !this.mix) void this.prepareNext();
    this.emit();
  }

  /** Llamado por la capa de entrada cuando el usuario toca un control de un deck. */
  userTouchedDeck(d: Deck): void {
    if (!this.enabled || d.owner === 'user' || this.noTakeover) return;
    d.setOwner('user');
    if (this.mix && this.mix.inc === d) d.bend(0);
    if (this.prepared?.deck === d) this.prepared = null;
    this.say(`Tomaste el Deck ${d.id}: la IA no lo toca hasta que lo devuelvas.`);
  }

  userTouchedCrossfader(): void {
    if (!this.enabled || this.mixer.xfOwner === 'user' || this.noTakeover) return;
    this.mixer.setXfOwner('user');
    this.say('Tomaste el crossfader: la IA sigue con EQ y filtros, el fade lo hacés vos.');
  }

  private nextReadyTrack(): Track | null {
    return this.queue.find((x) => x.status === 'ready' && (x.analysis || x.source === 'youtube')) ?? null;
  }

  private async startFirst(): Promise<void> {
    const t = this.nextReadyTrack();
    if (!t) {
      this.state = 'waiting';
      this.say(this.queue.length ? 'Esperando a que termine el análisis de la cola…' : 'Agregá temas a la cola para arrancar.', false);
      return;
    }
    const deck = this.decks.A.owner === 'ai' && !this.decks.A.playing ? this.decks.A : this.decks.B;
    this.removeFromQueue(t);
    this.say(`Arranco con "${t.title}" en el Deck ${deck.id}.`);
    await deck.loadTrack(t);
    if (!this.enabled) return;
    this.resetChannel(deck);
    deck.setTempo(1);
    deck.seek(t.analysis ? firstDownbeat(t.analysis) : 0);
    if (this.xfIsAi() || this.noTakeover) this.mixer.setCrossfader(deck.id === 'A' ? -1 : 1);
    deck.play();
    this.current = deck;
    this.state = 'playing';
    void this.prepareNext();
  }

  private resetChannel(d: Deck): void {
    d.setEq('low', 0);
    d.setEq('mid', 0);
    d.setEq('high', 0);
    d.setFilter(0);
    d.setVolume(1);
    d.bend(0);
    d.clearFx();
    if (d.loop.on) {
      d.loop.on = false;
      d.node?.port.postMessage({ type: 'loop', on: false, start: 0, end: 0 });
    }
  }

  private async prepareNext(): Promise<void> {
    if (this.preparing || !this.enabled || !this.current || this.prepared || this.mix) return;
    const deck = this.other(this.current);
    if (deck.owner !== 'ai') {
      this.state = 'waiting';
      this.say(`Esperando que devuelvas el Deck ${deck.id} para cargar el próximo tema.`, false);
      return;
    }
    if (deck.playing) return;
    const t = this.nextReadyTrack();
    if (!t) {
      this.say(this.queue.length ? 'El próximo tema todavía se está analizando…' : 'Cola vacía: agregá más temas para seguir mezclando.', false);
      return;
    }
    this.preparing = true;
    this.removeFromQueue(t);
    if (deck.track !== t || deck.mode === 'empty') await deck.loadTrack(t);
    this.preparing = false;
    if (!this.enabled || deck.owner !== 'ai' || deck.track !== t) return;
    // Si mientras cargaba se reordenó la cola, el tema ya volvió a la cola: no lo preparamos.
    if (this.queue.includes(t)) return;
    this.resetChannel(deck);
    deck.setEq('low', KILL_DB);
    deck.setEq('high', -10);
    if (!this.userParams.has(`${deck.id}.pfl`)) deck.setPfl(false);
    if (t.analysis) deck.seek(firstDownbeat(t.analysis));
    this.prepared = { deck, track: t };
    this.state = 'playing';
    const cur = this.current.track?.analysis;
    if (!cur || !t.analysis) this.say(`Próximo: "${t.title}" en el Deck ${deck.id} · modo básico (crossfade por volumen, sin beatmatching).`);
    else this.say(`Próximo: "${t.title}" en el Deck ${deck.id} · ${describeTransition(itemOf(this.current.track!, this.current.tempo), itemOf(t))}`);
  }

  // ---------------------------------------------------------------- reloj

  private tick(): void {
    if (!this.enabled) return;
    const now = this.now;
    if (this.state === 'waiting' && !this.current) {
      void this.startFirst();
      return;
    }
    const cur = this.current;
    if (!cur) return;

    this.updateGlide(now);
    this.updateMoment(now);
    if (this.extendOff && now >= this.extendOff.at) {
      const d = this.extendOff.deck;
      d.loop = { ...d.loop, on: false };
      d.node?.port.postMessage({ type: 'loop', on: false, start: 0, end: 0 });
      d.emit();
      this.extendOff = null;
    }

    if (this.mix) {
      this.updateMix(now);
      return;
    }
    if (!this.prepared) {
      if (!this.preparing && (this.state === 'playing' || this.state === 'waiting' || this.state === 'scheduled')) void this.prepareNext();
      return;
    }
    const inc = this.prepared.deck;
    const outA = cur.analysis;
    const inA = this.prepared.track.analysis;
    if (!cur.playing) return;
    if (!outA || !inA) {
      this.tickBasic(now, cur, inc);
      return;
    }
    const pos = cur.position(now);
    if (this.skipRequested) {
      const short = this.skipRequested === 'echo' || this.skipRequested === 'spin';
      this.forced = { plan: planSoon(outA, cur.tempo, pos, inA, this.skipRequested === 'spin' ? 2 : short ? 4 : 8, short ? 1 : 4, 0.6), style: this.skipRequested };
      this.skipRequested = null;
    }
    // minLead chico: la frase elegida sigue siendo válida hasta el último momento.
    let plan = this.forced?.plan ?? planMix(outA, cur.tempo, pos, inA, this.bars, 0.1);
    let timeToStart = (plan.outStart - pos) / cur.tempo;
    if (this.forced && timeToStart < 0.05) {
      plan = planSoon(outA, cur.tempo, pos, inA, plan.bars, 1, 0.6);
      this.forced.plan = plan;
      timeToStart = (plan.outStart - pos) / cur.tempo;
    }
    if (this.extendOff && plan.outStart < cur.loop.end && cur.loop.on) return; // esperamos a salir del loop
    if (timeToStart > 0.6) {
      if (this.state !== 'scheduled') {
        this.state = 'scheduled';
        this.say(`Mezcla planificada: ${plan.bars} compases${plan.beatmatch ? ' con beatmatching' : ' sin beatmatching (BPM muy distintos)'}.`, false);
      }
      return;
    }
    if (timeToStart < 0.05) return; // muy justo: replanifica en el próximo tick
    this.launchMix(plan, cur, inc, now + timeToStart, this.forced?.style ?? 'blend', false);
    this.forced = null;
  }

  private launchMix(plan: MixPlan, out: Deck, inc: Deck, t0: number, style: MixStyle, manual: boolean): void {
    if (!this.userParams.has(`${inc.id}.tempo`)) inc.setTempo(plan.tempoIn);
    inc.seek(plan.inCue);
    const userPlays = this.userParams.has(`${inc.id}.play`);
    if (!userPlays) {
      if (style === 'basic') inc.play();
      else inc.play(t0);
    }
    if (style === 'echo' || style === 'spin') {
      inc.setEq('low', 0);
      inc.setEq('high', 0);
    }
    this.mix = { plan, out, inc, t0, startedIn: !userPlays, style, manual };
    this.state = 'mixing';
    this.glide = null;
    this.moment = null;
    this.fire({ type: 'mix-start', out, inc });
    const desc =
      style === 'basic'
        ? `Crossfade → "${inc.track?.title}" (modo básico).`
        : style === 'echo'
          ? `Salida con eco → "${inc.track?.title}".`
          : style === 'spin'
            ? `Rebobinar → "${inc.track?.title}".`
          : `Mezclando → "${inc.track?.title}" (${plan.bars} compases${plan.beatmatch ? `, tempo ${((plan.tempoIn - 1) * 100).toFixed(1)} %` : ''}).`;
    this.say(desc);
  }

  /**
   * Modo básico (YouTube o temas sin análisis): sin BPM ni grilla, así que la transición es un
   * crossfade por volumen durante los últimos segundos del tema saliente.
   */
  private tickBasic(now: number, cur: Deck, inc: Deck): void {
    const dur = cur.duration;
    if (!dur) return;
    const end = cur.analysis?.audioEnd ?? dur;
    const pos = cur.position(now);
    const remaining = (end - pos) / (cur.tempo || 1);
    const fade = Math.min(BASIC_FADE_SEC, Math.max(3, dur * 0.15));
    const skip = this.skipRequested !== null;
    if (remaining > fade + 0.5 && !skip) {
      if (this.state !== 'scheduled') {
        this.state = 'scheduled';
        this.say(`Crossfade planificado: ${Math.round(fade)} s antes del final (modo básico, sin beatmatching).`, false);
      }
      return;
    }
    this.skipRequested = null;
    const inA = inc.analysis;
    inc.setTempo(1);
    const realDuration = skip ? 6 : Math.max(2, Math.min(fade, remaining));
    this.launchMix({ outStart: pos, bars: 0, realDuration, inCue: inA ? firstDownbeat(inA) : 0, tempoIn: 1, mult: 1, beatmatch: false }, cur, inc, now, 'basic', false);
  }

  private updateMix(now: number): void {
    const m = this.mix!;
    const { out, inc, plan } = m;
    const beatSecReal = plan.bars > 0 && out.analysis ? 60 / (out.analysis.bpm * out.tempo) : 0.5;

    // Entrada a cargo del usuario (lecciones): esperamos su Play y lo alineamos.
    if (!m.startedIn) {
      if (inc.playing) {
        this.alignIncoming(m, now, inc.lastPlayAt, false);
      } else if (now > m.t0 + beatSecReal) {
        inc.play();
        this.alignIncoming(m, now, now, true);
      } else {
        this.emit();
        return;
      }
    }

    const p = m.manual ? this.manualProgress(m) : Math.max(0, Math.min(1, (now - m.t0) / plan.realDuration));
    const beatFrac = plan.bars > 0 ? 1 / (plan.bars * 4) : 0.05;
    const outAi = out.owner === 'ai';
    const incAi = inc.owner === 'ai';
    const sOut = out.id === 'A' ? -1 : 1;

    if (m.style === 'spin') {
      // Rebobinar: el saliente hace backspin en el compás y el entrante entra entero.
      if (outAi && out.playing && !out.fx.spin && now >= m.t0) out.backspin();
      if (!m.manual && this.xfIsAi()) this.mixer.setCrossfader(sOut * (1 - ramp(p, 0, 0.2)) + -sOut * ramp(p, 0, 0.2));
      this.explain('Rebobinar: el tema viejo "vuelve para atrás" como un vinilo y el nuevo cae justo en el 1.');
    } else if (m.style === 'echo') {
      // Salida con eco: el saliente se va con eco en el primer cuarto, el entrante entra entero.
      if (!m.manual && this.xfIsAi()) this.mixer.setCrossfader(sOut * (1 - ramp(p, 0, 0.35)) + -sOut * ramp(p, 0.1, 0.4));
      if (outAi) {
        if (!out.fx.echo && p > 0) out.setFx('echo', true);
        out.setVolume(1 - ramp(p, 0.05, 0.4));
      }
      this.explain('Salida con eco: el tema que se va queda rebotando mientras entra el nuevo, entero.');
    } else {
      // Crossfader: hacia el centro en la primera mitad, al lado del entrante en el último cuarto.
      if (!m.manual && this.xfIsAi()) this.mixer.setCrossfader(sOut * (1 - ramp(p, 0, 0.45)) + -sOut * ramp(p, 0.7, 1));
      // Bass swap a la mitad (en 2 beats), agudos del entrante suben en la primera mitad.
      const swap = ramp(p, 0.5, 0.5 + 2 * beatFrac);
      if (this.aiOwns(inc, 'low')) inc.setEq('low', KILL_DB * (1 - swap));
      if (incAi) inc.setEq('high', -10 * (1 - ramp(p, 0.05, 0.5)));
      if (this.aiOwns(out, 'low')) out.setEq('low', KILL_DB * swap);
      if (outAi) {
        // Filtro pasa altos en el saliente durante el último 30 %.
        out.setFilter(0.6 * ramp(p, 0.7, 1));
        if (!plan.beatmatch && !m.manual) out.setVolume(1 - ramp(p, 0.6, 1));
      }
      this.explain(
        p < 0.5
          ? 'Entra el tema nuevo sin graves: así los dos bajos no chocan.'
          : p < 0.7
            ? 'Cambio de graves: ahora el bajo es del tema nuevo y el viejo se queda sin graves.'
            : 'El tema viejo se va con un filtro que le saca el cuerpo, de a poco.',
      );
    }
    // Corrección de fase continua (como un "sync" que no deja derivar).
    if (plan.beatmatch && incAi && inc.playing && out.playing && now > m.t0 + 0.1) {
      const err = phaseError(out.beatPos(now), inc.beatPos(now), plan.mult);
      inc.bend(bendForPhaseError(err, 60 / (inc.track!.analysis!.bpm * inc.tempo)));
    }
    const done = m.manual ? p >= 0.97 && now > m.t0 : p >= 1;
    if (done) this.finishMix();
    else this.emit();
  }

  /** Alinea un entrante que arrancó el usuario (o tarde) con la fase del saliente. */
  private alignIncoming(m: Mix, now: number, pressedAt: number, byAi: boolean): void {
    const { out, inc, plan } = m;
    m.startedIn = true;
    const outA = out.analysis;
    const inA = inc.analysis;
    if (outA && inA && plan.bars > 0) {
      const elapsedOutBeats = out.beatPos(now) - beatIndex(outA, plan.outStart);
      const desiredBeat = beatIndex(inA, plan.inCue) + elapsedOutBeats / plan.mult;
      inc.seek(Math.max(0, beatTime(inA, desiredBeat)));
    }
    this.fire({ type: 'entry', errorMs: (pressedAt - m.t0) * 1000, byAi });
  }

  private finishMix(): void {
    const m = this.mix!;
    const { out, inc } = m;
    inc.bend(0);
    if (inc.owner === 'ai') {
      if (!this.userParams.has(`${inc.id}.low`)) inc.setEq('low', 0);
      inc.setEq('high', 0);
    }
    if (out.owner === 'ai') {
      out.pause();
      this.resetChannel(out);
    }
    if (this.xfIsAi() && !m.manual) this.mixer.setCrossfader(inc.id === 'A' ? -1 : 1);
    this.mix = null;
    this.prepared = null;
    this.current = inc;
    this.state = 'playing';
    if (this.tempoGlide && inc.owner === 'ai' && inc.analysis && Math.abs(inc.tempo - 1) > 0.002 && !this.userParams.has(`${inc.id}.tempo`)) {
      const a = inc.analysis;
      this.glide = { deck: inc, from: inc.tempo, t0: this.now + 2, dur: Math.min(40, (32 * 4 * 60) / a.bpm) };
    }
    this.lastExplain = '';
    this.fire({ type: 'mix-end', out, inc });
    this.say(`Listo: suena "${inc.track?.title}" en el Deck ${inc.id}.`);
    void this.prepareNext();
  }

  /** Lleva el tempo de vuelta al original en ~32 compases, sin pisar una mezcla. */
  private updateGlide(now: number): void {
    const g = this.glide;
    if (!g || this.mix) return;
    if (g.deck.owner !== 'ai' || g.deck !== this.current) {
      this.glide = null;
      return;
    }
    if (now < g.t0) return;
    const p = Math.min(1, (now - g.t0) / g.dur);
    const t = g.from + (1 - g.from) * p;
    if (Math.abs(t - g.deck.tempo) > 0.0002 || p >= 1) g.deck.setTempo(t);
    if (p >= 1) this.glide = null;
  }

  private abortMix(say = true): void {
    const m = this.mix;
    if (!m) return;
    m.inc.bend(0);
    this.mix = null;
    if (say) this.say('Mezcla cancelada.');
  }

  private onDeckEnded(d: Deck): void {
    if (!this.enabled) return;
    if (this.mix && this.mix.out === d) {
      this.finishMix();
      return;
    }
    if (d === this.current) {
      // Se terminó sin transición (p. ej. no había próximo tema listo).
      const n = this.prepared;
      if (n && n.deck.owner === 'ai') {
        n.deck.setEq('low', 0);
        n.deck.setEq('high', 0);
        if (this.xfIsAi() || this.noTakeover) this.mixer.setCrossfader(n.deck.id === 'A' ? -1 : 1);
        n.deck.play();
        this.current = n.deck;
        this.prepared = null;
        this.say(`Arranco "${n.track.title}" (el tema anterior terminó antes de mezclar).`);
        void this.prepareNext();
      } else {
        this.current = null;
        this.state = 'waiting';
        this.say('Se terminó el tema y no hay otro listo. Esperando la cola…');
      }
    }
  }
}
