// Motor del Modo Aprender: corre una lección sobre la próxima mezcla del Auto-DJ, le cede al
// usuario sólo los parámetros de la lección, resalta qué tocar (pantalla + LEDs) y arma la devolución.
import type { Deck } from '../audio/deck';
import type { Mixer } from '../audio/mixer';
import type { AutoDJ } from '../autodj/autodj';
import type { Controller } from '../midi/controller';
import type { Sampler } from '../audio/sampler';
import type { ActionId } from '../midi/mapping';
import { incShare, LESSONS, xfTargetFor, type Lesson, type LessonCtx, type Step } from './lessons';

export interface StepResult {
  id: string;
  ok: boolean;
  note: string;
}

export interface GuideView {
  phase: 'idle' | 'waiting' | 'running' | 'done';
  lesson: Lesson | null;
  text: string;
  why: string;
  countdown: string;
  xfTarget: number | null;
  ui: string[];
  steps: { id: string; label: string; state: 'pending' | 'active' | 'ok' | 'ai' }[];
  results: StepResult[];
  success: boolean;
  bar: number | null;
}

const PROGRESS_KEY = 'djv.guide.progress.v1';
const NEEDED = 2;

export class Guide {
  phase: GuideView['phase'] = 'idle';
  lesson: Lesson | null = null;
  private out: Deck | null = null;
  private inc: Deck | null = null;
  private stepIdx = 0;
  private results: StepResult[] = [];
  private notes: string[] = [];
  private entryMs: number | null = null;
  private entryByAi = false;
  private xfDev: number[] = [];
  private progress: Record<number, number> = {};
  private listeners = new Set<() => void>();
  private view: GuideView = this.emptyView();
  private autodj: AutoDJ;
  private mixer: Mixer;
  private controller: Controller;
  private sampler: Sampler;
  private hits0 = 0;

  constructor(autodj: AutoDJ, mixer: Mixer, controller: Controller, sampler: Sampler) {
    this.autodj = autodj;
    this.mixer = mixer;
    this.controller = controller;
    this.sampler = sampler;
    try {
      this.progress = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? '{}');
    } catch {
      this.progress = {};
    }
    autodj.onTick(() => this.tick());
    autodj.onEvent((e) => {
      if (this.phase !== 'running') return;
      if (e.type === 'entry') {
        this.entryMs = e.errorMs;
        this.entryByAi = e.byAi;
      } else if (e.type === 'mix-end' && e.inc === this.inc) {
        this.finish();
      }
    });
  }

  onChange(cb: () => void): void {
    this.listeners.add(cb);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  get state(): GuideView {
    return this.view;
  }

  // ---------------------------------------------------------------- progreso

  successes(level: number): number {
    return this.progress[level] ?? 0;
  }

  unlocked(level: number): boolean {
    return level === 1 || this.successes(level - 1) >= NEEDED;
  }

  get needed(): number {
    return NEEDED;
  }

  private saveProgress(): void {
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(this.progress));
    } catch {
      /* ignorar */
    }
  }

  // ---------------------------------------------------------------- control

  /** Empieza una lección: necesita el Auto-DJ prendido con al menos dos temas analizados. */
  start(level: number): string | null {
    const lesson = LESSONS.find((l) => l.level === level);
    if (!lesson) return 'No existe esa lección.';
    this.stop(false);
    this.lesson = lesson;
    this.phase = 'waiting';
    this.results = [];
    this.notes = [];
    this.entryMs = null;
    this.entryByAi = false;
    this.xfDev = [];
    this.stepIdx = 0;
    this.hits0 = this.sampler.hits;
    this.autodj.noTakeover = true;
    this.autodj.bars = 16;
    this.render();
    return null;
  }

  stop(render = true): void {
    for (const p of [...this.autodj.userParams]) this.autodj.userParams.delete(p);
    this.controller.blink.clear();
    this.controller.overrides.clear();
    this.autodj.noTakeover = false;
    if (this.phase !== 'done') this.phase = 'idle';
    this.out = this.inc = null;
    if (render) this.render();
  }

  dismiss(): void {
    this.phase = 'idle';
    this.lesson = null;
    this.render();
  }

  private ctx(): LessonCtx {
    const p = this.autodj.mixProgress();
    return {
      out: this.out!,
      inc: this.inc!,
      bar: this.autodj.barToMix() ?? -99,
      p,
      entryMs: this.entryMs,
      entryByAi: this.entryByAi,
      xf: this.mixer.crossfader,
      samplerHits: this.sampler.hits - this.hits0,
      mark: (n) => this.notes.push(n),
      ungrant: (param) => this.autodj.userParams.delete(param),
    };
  }

  private tick(): void {
    if (!this.lesson) return;
    if (this.phase === 'waiting') {
      const cur = this.autodj.currentDeck;
      const inc = this.autodj.preparedDeck;
      if (!cur || !inc || !cur.analysis || !inc.analysis || this.autodj.mixing) {
        this.render();
        return;
      }
      this.out = cur;
      this.inc = inc;
      for (const g of this.lesson.grants(cur, inc)) this.autodj.userParams.add(g);
      const pads = this.lesson.pads?.(cur, inc) ?? {};
      for (const [k, fn] of Object.entries(pads)) this.controller.overrides.set(k as ActionId, fn!);
      if (this.userOwns(`${inc.id}.tempo`)) inc.setTempo(1);
      // Para no esperar todo el tema, adelantamos hasta ~14 compases antes de la mezcla.
      const plan = this.autodj.nextPlan();
      const bar = this.autodj.barToMix();
      if (plan && bar !== null && bar < -15 && cur.analysis) {
        cur.seek(plan.outStart - (14 * 4 * 60) / cur.analysis.bpm);
        this.notes.push('Adelanté el tema hasta cerca de la mezcla para no esperar.');
      }
      this.phase = 'running';
    }
    if (this.phase !== 'running') return;
    const c = this.ctx();
    // Seguimiento del crossfader (lección 3)
    if (this.userOwns('xf') && c.p !== null && c.p > 0.02 && c.p < 0.98) this.xfDev.push(incShare(c.xf, c.inc) - incShare(xfTargetFor(c.p, c.inc), c.inc));
    const steps = this.lesson.steps;
    while (this.stepIdx < steps.length) {
      const s = steps[this.stepIdx];
      if (s.requires && !this.userOwns(s.requires)) {
        this.stepIdx++;
        continue;
      }
      if (c.bar < s.from && !(s.done && s.done(c))) break;
      if (s.done && s.done(c)) {
        this.results.push({ id: s.id, ok: true, note: s.grade?.(c) ?? this.label(s, c) });
        this.stepIdx++;
        continue;
      }
      if (c.bar > s.until) {
        if (s.done) {
          s.fallback?.(c);
          this.results.push({ id: s.id, ok: false, note: this.notes.at(-1) ?? 'Lo hice yo esta vez.' });
        }
        this.stepIdx++;
        continue;
      }
      break;
    }
    this.render();
  }

  /** Resumen corto de un paso para la devolución. */
  private label(s: Step, c: LessonCtx): string {
    return s.text(c).split(/[:.]/)[0];
  }

  private userOwns(param: string): boolean {
    return this.autodj.userParams.has(param);
  }

  private finish(): void {
    const lesson = this.lesson!;
    const c = this.ctx();
    // Pasos que quedaron pendientes al terminar la mezcla
    for (let i = this.stepIdx; i < lesson.steps.length; i++) {
      const s = lesson.steps[i];
      if (!s.done || (s.requires && !this.userOwns(s.requires))) continue;
      if (s.done(c)) this.results.push({ id: s.id, ok: true, note: s.grade?.(c) ?? this.label(s, c) });
      else this.results.push({ id: s.id, ok: false, note: 'Quedó sin hacer.' });
    }
    if (this.xfDev.length > 10) {
      const mean = this.xfDev.reduce((a, b) => a + b, 0) / this.xfDev.length;
      const abs = this.xfDev.reduce((a, b) => a + Math.abs(b), 0) / this.xfDev.length;
      const note = abs < 0.12 ? 'Crossfade prolijo' : abs < 0.25 ? `Crossfade bien, un poco ${mean > 0 ? 'apurado' : 'lento'}.` : `Crossfade ${mean > 0 ? 'muy apurado: se notó el corte' : 'muy lento: los dos temas sonaron mucho juntos'}.`;
      this.results.push({ id: 'xf-grade', ok: abs < 0.25, note });
    }
    this.phase = 'done';
    const success = this.results.every((r) => r.ok);
    if (success) {
      this.progress[lesson.level] = (this.progress[lesson.level] ?? 0) + 1;
      this.saveProgress();
    }
    this.stop(false);
    this.render();
  }

  // ---------------------------------------------------------------- vista

  private emptyView(): GuideView {
    return { phase: 'idle', lesson: null, text: '', why: '', countdown: '', xfTarget: null, ui: [], steps: [], results: [], success: false, bar: null };
  }

  private render(): void {
    const v = this.emptyView();
    v.phase = this.phase;
    v.lesson = this.lesson;
    v.results = this.results;
    v.success = this.phase === 'done' && this.results.every((r) => r.ok);
    this.controller.blink.clear();
    if (this.phase === 'waiting') {
      v.text = this.autodj.enabled ? 'Preparando el próximo tema para la lección…' : 'Prendiendo el Auto-DJ…';
    } else if (this.phase === 'running' && this.lesson && this.out && this.inc) {
      const c = this.ctx();
      v.bar = c.bar;
      const s: Step | undefined = this.lesson.steps[this.stepIdx];
      if (s && c.bar >= s.from - 0.01) {
        v.text = s.text(c);
        v.why = s.why ?? '';
        v.ui = s.ui?.(c) ?? [];
        v.xfTarget = s.xfTarget?.(c) ?? null;
        for (const a of s.midi?.(c) ?? []) this.controller.blink.add(a);
        if (s.countdownTo !== undefined) {
          const beats = (s.countdownTo - c.bar) * 4;
          v.countdown = beats > 4 ? `en ${Math.ceil(beats / 4)} compases` : beats > 0 ? String(Math.ceil(beats)) : beats > -1 ? '¡Ahora!' : '';
        }
      } else if (s) {
        const bars = Math.ceil(s.from - c.bar);
        v.text = `Escuchá el tema que suena. La próxima indicación llega en ${bars} ${bars === 1 ? 'compás' : 'compases'}.`;
      } else {
        v.text = 'Mirá cómo termina la mezcla…';
      }
      v.steps = this.lesson.steps
        .filter((st) => st.done)
        .map((st) => {
          const r = this.results.find((x) => x.id === st.id);
          const idx = this.lesson!.steps.indexOf(st);
          return { id: st.id, label: this.label(st, c), state: r ? (r.ok ? 'ok' : 'ai') : idx === this.stepIdx ? 'active' : 'pending' };
        });
    }
    this.view = v;
    this.emit();
  }
}
