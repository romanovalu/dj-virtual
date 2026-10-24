// Pads del sampler (Pro: compactos en el mixer; Fácil: grandes). Click = disparar,
// arrastrar un archivo encima = cargar tu sonido, click derecho = volver al de fábrica.
import { esc, type App } from '../app-types';
import { Knob } from './knob';

export class SamplerPads {
  private app: App;
  private root: HTMLElement;
  private big: boolean;

  constructor(app: App, root: HTMLElement, big: boolean) {
    this.app = app;
    this.root = root;
    this.big = big;
    root.classList.add('sampler-pads');
    root.classList.toggle('big', big);
    root.innerHTML = `
      <div class="sp-head"><span class="lbl">Sampler</span>
        <label class="small muted" title="Los sonidos caen en el próximo tiempo; el riser termina justo en el compás 1"><input type="checkbox" class="sp-q" checked /> al ritmo</label>
        <span class="sp-vol"></span></div>
      <div class="sp-grid"></div>
      <div class="small muted sp-hint">${big ? 'Arrastrá un audio sobre un pad para usar tu propio sonido (un grito, tu nombre, un efecto). Click derecho lo vuelve al original.' : 'Arrastrá un audio a un pad · click derecho: original'}</div>`;
    const grid = root.querySelector('.sp-grid') as HTMLElement;
    grid.addEventListener('pointerdown', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-pad]') as HTMLElement | null;
      if (!b || (e as PointerEvent).button !== 0) return;
      app.resumeAudio();
      const i = Number(b.dataset.pad);
      if (!app.sampler.pads[i].buffer) {
        app.toast('Pad libre: arrastrá un archivo de audio encima para cargarle un sonido.');
        return;
      }
      app.sampler.trigger(i);
    });
    grid.addEventListener('contextmenu', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-pad]') as HTMLElement | null;
      if (!b) return;
      e.preventDefault();
      void app.sampler.reset(Number(b.dataset.pad));
    });
    grid.addEventListener('dragover', (e) => {
      if ((e.target as HTMLElement).closest('button[data-pad]')) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    grid.addEventListener('drop', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-pad]') as HTMLElement | null;
      const f = e.dataTransfer?.files[0];
      if (!b || !f) return;
      e.preventDefault();
      e.stopPropagation();
      document.body.classList.remove('dragging');
      app.sampler
        .loadFile(Number(b.dataset.pad), f)
        .then(() => app.toast(`Sonido cargado en el pad ${Number(b.dataset.pad) + 1}.`))
        .catch(() => app.toast('No pude leer ese audio.'));
    });
    (root.querySelector('.sp-q') as HTMLInputElement).addEventListener('change', (e) => {
      app.sampler.quantizeOn = (e.target as HTMLInputElement).checked;
    });
    new Knob(root.querySelector('.sp-vol') as HTMLElement, {
      label: 'Vol',
      min: 0,
      max: 1,
      value: 0.84,
      def: 0.84,
      format: (v) => `${Math.round(v * 100)}`,
      onInput: (v) => app.sampler.setVolume(v),
    });
    app.sampler.onChange(() => this.render());
    this.render();
  }

  render(): void {
    const s = this.app.sampler;
    const grid = this.root.querySelector('.sp-grid') as HTMLElement;
    grid.innerHTML = s.pads
      .map(
        (p, i) =>
          `<button data-pad="${i}" class="${p.playing ? 'on' : ''} ${p.buffer ? '' : 'empty'}" title="${esc(p.name)} · pad ${i + 1}${i < 4 ? ` (Deck A, pad sampler ${i + 1})` : ` (Deck B, pad sampler ${i - 3})`}"><span class="em">${p.emoji}</span>${this.big ? `<span class="nm">${esc(p.name)}</span>` : ''}</button>`,
      )
      .join('');
  }
}
