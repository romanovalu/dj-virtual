// Panel del Modo Aprender: niveles, indicación actual con cuenta regresiva, resaltado de controles
// y devolución al final de cada mezcla.
import { esc, type App } from '../app-types';
import { LESSONS } from '../guide/lessons';

export class GuidePanel {
  private app: App;
  private root: HTMLElement;
  private selected = 1;
  private lastHl: HTMLElement[] = [];

  constructor(app: App, root: HTMLElement) {
    this.app = app;
    this.root = root;
    root.innerHTML = `
      <div class="g-head">
        <b>🎓 Aprender a mezclar</b>
        <div class="g-levels" id="g-levels"></div>
      </div>
      <div class="g-body">
        <div class="g-count" id="g-count"></div>
        <div class="g-main">
          <div class="g-goal muted small" id="g-goal"></div>
          <div class="g-text" id="g-text"></div>
          <div class="g-why" id="g-why"></div>
          <div class="g-explain" id="g-explain"></div>
          <ul class="g-steps" id="g-steps"></ul>
          <div class="g-result" id="g-result" hidden></div>
        </div>
        <div class="g-actions">
          <button id="g-start" class="primary">Empezar lección</button>
          <button id="g-stop" hidden>Cancelar</button>
        </div>
      </div>`;
    const $ = (s: string) => root.querySelector(s) as HTMLElement;
    $('#g-levels').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-lv]') as HTMLButtonElement | null;
      if (!b || b.disabled) return;
      this.selected = Number(b.dataset.lv);
      this.render();
    });
    $('#g-start').addEventListener('click', () => this.startLesson(this.selected));
    $('#g-stop').addEventListener('click', () => {
      app.guide.stop();
      app.guide.dismiss();
    });
    $('#g-result').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-r]') as HTMLElement | null;
      if (!b) return;
      if (b.dataset.r === 'again') this.startLesson(this.selected);
      else if (b.dataset.r === 'next') {
        this.selected = Math.min(LESSONS.length, this.selected + 1);
        this.startLesson(this.selected);
      } else app.guide.dismiss();
    });
    app.guide.onChange(() => this.render());
    // El primer nivel no aprobado como sugerencia
    for (const l of LESSONS) if (app.guide.unlocked(l.level)) this.selected = l.level;
    for (const l of LESSONS) if (app.guide.unlocked(l.level) && app.guide.successes(l.level) < app.guide.needed) {
      this.selected = l.level;
      break;
    }
    this.render();
  }

  private startLesson(level: number): void {
    const app = this.app;
    app.resumeAudio();
    const analyzed = app.tracks.filter((t) => t.source === 'local' && t.analysis);
    if (analyzed.length < 2) {
      app.toast('Para practicar necesitás al menos 2 temas (archivos) ya analizados en la biblioteca.');
      return;
    }
    if (app.autodj.queue.filter((t) => t.analysis).length === 0) app.fillQueue(true);
    const err = app.guide.start(level);
    if (err) return app.toast(err);
    if (!app.autodj.enabled) app.autodj.start();
  }

  render(): void {
    const app = this.app;
    const g = app.guide;
    const v = g.state;
    const $ = (s: string) => this.root.querySelector(s) as HTMLElement;
    $('#g-levels').innerHTML = LESSONS.map((l) => {
      const open = g.unlocked(l.level);
      const n = g.successes(l.level);
      return `<button data-lv="${l.level}" class="${l.level === this.selected ? 'on' : ''}" ${open ? '' : 'disabled'} title="${esc(l.goal)}">${open ? '' : '🔒 '}${l.level}. ${esc(l.title)} <span class="small muted">${Math.min(n, g.needed)}/${g.needed}</span></button>`;
    }).join('');
    const lesson = LESSONS.find((l) => l.level === this.selected)!;
    const running = v.phase === 'running' || v.phase === 'waiting';
    $('#g-goal').textContent = running && v.lesson ? `Nivel ${v.lesson.level} · ${v.lesson.goal}` : `Nivel ${lesson.level} · ${lesson.goal}`;
    $('#g-text').textContent = running ? v.text : v.phase === 'done' ? '' : 'Elegí un nivel y tocá "Empezar lección". La IA mezcla con vos: te avisa qué mover y cuándo, y si no llegás lo hace ella.';
    $('#g-why').textContent = running && v.why ? `¿Por qué? ${v.why}` : '';
    $('#g-explain').textContent = running && app.autodj.mixing ? `IA: ${app.autodj.lastExplain}` : '';
    $('#g-count').textContent = running ? v.countdown : '';
    $('#g-count').classList.toggle('now', v.countdown === '¡Ahora!');
    $('#g-steps').innerHTML = running ? v.steps.map((s) => `<li class="${s.state}">${s.state === 'ok' ? '✔' : s.state === 'ai' ? '🤖' : s.state === 'active' ? '👉' : '·'} ${esc(s.label)}</li>`).join('') : '';
    ($('#g-start') as HTMLElement).hidden = running;
    ($('#g-stop') as HTMLElement).hidden = !running;
    const res = $('#g-result');
    res.hidden = v.phase !== 'done';
    if (v.phase === 'done' && v.lesson) {
      const lv = v.lesson.level;
      const unlockedNext = lv < LESSONS.length && g.unlocked(lv + 1);
      res.innerHTML = `
        <div class="g-res-title">${v.success ? '🎉 ¡Mezcla limpia!' : '👍 Mezcla terminada'}</div>
        <ul>${v.results.map((r) => `<li>${r.ok ? '✔' : '🤖'} ${esc(r.note)}</li>`).join('')}</ul>
        <div class="small muted">${v.success ? `Nivel ${lv}: ${Math.min(g.successes(lv), g.needed)}/${g.needed} mezclas bien.` : 'Cuando la IA tiene que ayudarte no cuenta para avanzar; la próxima sale.'}</div>
        <div class="row" style="margin-top:8px"><button data-r="again" class="primary">Otra vez</button>${unlockedNext ? '<button data-r="next">Siguiente nivel →</button>' : ''}<button data-r="close">Cerrar</button></div>`;
    }
    this.highlight(running ? v.ui : []);
    const marker = document.getElementById('xf-target');
    if (marker) {
      marker.hidden = v.xfTarget === null || !running;
      if (v.xfTarget !== null) marker.style.left = `${((v.xfTarget + 1) / 2) * 100}%`;
    }
  }

  private highlight(selectors: string[]): void {
    const els = selectors.flatMap((s) => [...document.querySelectorAll<HTMLElement>(s)]);
    for (const e of this.lastHl) if (!els.includes(e)) e.classList.remove('guide-hl');
    for (const e of els) e.classList.add('guide-hl');
    this.lastHl = els;
  }
}
