// Perilla rotativa: arrastrar vertical, rueda del mouse, doble click vuelve al valor por defecto.

export interface KnobOptions {
  label: string;
  min: number;
  max: number;
  value: number;
  def?: number;
  bipolar?: boolean;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}

export class Knob {
  readonly el: HTMLElement;
  value: number;
  private o: KnobOptions;
  private dial: HTMLElement;
  private readout: HTMLElement;

  constructor(host: HTMLElement, o: KnobOptions) {
    this.o = o;
    this.value = o.value;
    this.el = document.createElement('div');
    this.el.className = 'knob';
    this.el.innerHTML = `<div class="dial" tabindex="0" role="slider" aria-label="${o.label}"></div><div class="klabel">${o.label}</div><div class="kval"></div>`;
    this.dial = this.el.querySelector('.dial')!;
    this.readout = this.el.querySelector('.kval')!;
    host.appendChild(this.el);

    let startY = 0;
    let startV = 0;
    this.dial.addEventListener('pointerdown', (e) => {
      this.dial.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startV = this.value;
      e.preventDefault();
    });
    this.dial.addEventListener('pointermove', (e) => {
      if (!this.dial.hasPointerCapture(e.pointerId)) return;
      const range = o.max - o.min;
      const fine = e.shiftKey ? 0.25 : 1;
      this.input(startV + ((startY - e.clientY) / 160) * range * fine);
    });
    this.dial.addEventListener('dblclick', () => this.input(o.def ?? o.value));
    this.dial.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.input(this.value - Math.sign(e.deltaY) * (o.max - o.min) * 0.03);
      },
      { passive: false },
    );
    this.dial.addEventListener('keydown', (e) => {
      const step = (o.max - o.min) * 0.02;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') this.input(this.value + step);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') this.input(this.value - step);
      else return;
      e.preventDefault();
    });
    this.render();
  }

  private input(v: number): void {
    let x = Math.max(this.o.min, Math.min(this.o.max, v));
    const def = this.o.def;
    // Imán al centro / valor por defecto
    if (def !== undefined && Math.abs(x - def) < (this.o.max - this.o.min) * 0.015) x = def;
    if (x === this.value) return;
    this.value = x;
    this.render();
    this.o.onInput(x);
  }

  /** Actualiza desde afuera (MIDI / Auto-DJ) sin disparar onInput. */
  set(v: number): void {
    if (Math.abs(v - this.value) < 1e-6) return;
    this.value = v;
    this.render();
  }

  private render(): void {
    const n = (this.value - this.o.min) / (this.o.max - this.o.min);
    const ang = -135 + 270 * n;
    const startN = this.o.bipolar ? ((this.o.def ?? 0) - this.o.min) / (this.o.max - this.o.min) : 0;
    const a0 = Math.min(startN, n) * 270;
    const a1 = Math.max(startN, n) * 270;
    this.dial.style.setProperty('--ang', `${ang}deg`);
    this.dial.style.setProperty('--a0', `${a0}deg`);
    this.dial.style.setProperty('--a1', `${a1}deg`);
    this.readout.textContent = this.o.format ? this.o.format(this.value) : this.value.toFixed(2);
  }
}
