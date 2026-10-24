// Conecta el DJ2GO2 con la app: despacha acciones, MIDI Learn y LEDs.
import { MidiManager, relativeDelta, type MidiMessage } from './midi';
import { findBinding, learnBinding, loadMapping, resetMapping, saveMapping, type ActionId, type Binding, type DeckId } from './mapping';
import type { Deck } from '../audio/deck';
import type { Mixer } from '../audio/mixer';
import type { AutoDJ } from '../autodj/autodj';
import type { Sampler } from '../audio/sampler';

export interface ControllerHost {
  decks: { A: Deck; B: Deck };
  mixer: Mixer;
  autodj: AutoDJ;
  sampler: Sampler;
  browse(delta: number): void;
  browsePush(): void;
  loadSelected(deck: Deck): void;
  /** Modo Fácil: pedir el tema seleccionado en la biblioteca. */
  requestSelected(): void;
  resumeAudio(): void;
  toast(msg: string): void;
}

const PITCH_INVERT_KEY = 'djv.pitchInvert';

export class Controller {
  readonly midi = new MidiManager();
  mapping: Binding[] = loadMapping();
  learnTarget: ActionId | null = null;
  pitchInvert = false;
  lastMessage: MidiMessage | null = null;
  /** 'easy' usa el mapeo simplificado; 'learn' y 'pro' el normal. */
  mode: 'pro' | 'easy' | 'learn' = 'pro';
  /** LEDs que titilan rápido para indicar "tocá esto" (lecciones). */
  readonly blink = new Set<ActionId>();
  /** Acciones que una lección redefine (p. ej. pad 1 = sacar graves). */
  readonly overrides = new Map<ActionId, () => void>();
  private host: ControllerHost;
  private ledState = new Map<string, boolean>();
  private listeners = new Set<() => void>();

  constructor(host: ControllerHost) {
    this.host = host;
    try {
      this.pitchInvert = localStorage.getItem(PITCH_INVERT_KEY) === '1';
    } catch {
      /* ignorar */
    }
    this.midi.onMessage((m) => this.handle(m));
    this.midi.onStatus(() => {
      this.ledState.clear();
      this.emit();
    });
    setInterval(() => this.syncLeds(), 60);
    window.addEventListener('beforeunload', () => this.allLedsOff());
  }

  init(): Promise<unknown> {
    return this.midi.init();
  }

  onChange(cb: () => void): void {
    this.listeners.add(cb);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  setPitchInvert(on: boolean): void {
    this.pitchInvert = on;
    try {
      localStorage.setItem(PITCH_INVERT_KEY, on ? '1' : '0');
    } catch {
      /* ignorar */
    }
    this.emit();
  }

  startLearn(a: ActionId | null): void {
    this.learnTarget = a;
    this.emit();
  }

  resetMapping(): void {
    this.mapping = resetMapping();
    this.ledState.clear();
    this.emit();
  }

  private handle(m: MidiMessage): void {
    if (m.type === 'other') return;
    this.lastMessage = m;
    const kind = m.type === 'cc' ? 'cc' : 'note';

    if (this.learnTarget) {
      if (m.type === 'noteoff') return;
      const a = this.learnTarget;
      const relative = a.endsWith('.jog') || a === 'M.browse';
      this.mapping = learnBinding(this.mapping, a, kind, m.channel, m.number, relative);
      saveMapping(this.mapping);
      this.learnTarget = null;
      this.ledState.clear();
      this.host.toast('Control aprendido y guardado.');
      this.emit();
      return;
    }

    const b = findBinding(this.mapping, kind, m.channel, m.number);
    if (!b) {
      this.emit();
      return;
    }
    this.host.resumeAudio();
    const ov = this.overrides.get(b.action);
    if (ov) {
      if (m.type === 'noteon' || m.type === 'cc') ov();
      this.emit();
      return;
    }
    const [scope, name] = b.action.split('.') as [string, string];
    if (this.mode === 'easy' && this.easy(scope, name, m, b)) {
      this.emit();
      return;
    }
    if (scope === 'M') this.master(name, m, b);
    else this.deck(this.host.decks[scope as DeckId], name, m, b);
    this.emit();
  }

  /** Mapeo del Modo Fácil. Devuelve false si la acción sigue el mapeo normal. */
  private easy(scope: string, name: string, m: MidiMessage, b: Binding): boolean {
    const h = this.host;
    const press = m.type === 'noteon';
    const ad = h.autodj;
    if (scope === 'M') {
      if (name === 'crossfader') {
        ad.manualXf((m.value / 127) * 2 - 1);
        return true;
      }
      return false;
    }
    const cur = ad.currentDeck;
    switch (name) {
      case 'play':
        if (press && cur) cur.togglePlay();
        return true;
      case 'sync':
        if (press) ad.nudgeEnergy(scope === 'A' ? -1 : 1);
        return true;
      case 'hotcue1':
        if (press) ad.skipNow();
        return true;
      case 'hotcue2':
        if (press) ad.extend();
        return true;
      case 'hotcue3':
        if (press) ad.drop();
        return true;
      case 'hotcue4':
        if (press) ad.skipNow('echo');
        return true;
      case 'jog':
        if (cur && cur.mode === 'local') cur.setFilter(Math.max(-1, Math.min(1, cur.filter + (b.relative ? relativeDelta(m.value) : m.value - 64) * 0.015)));
        return true;
      case 'load':
        if (press) h.requestSelected();
        return true;
      case 'fx3':
        if (cur && press) cur.rollStart(0.25);
        else if (cur && m.type === 'noteoff') cur.rollStop();
        return true;
      case 'fx1':
      case 'fx2':
      case 'fx4':
        if (cur && press) cur.toggleFx(Number(name.slice(-1)) as 1 | 2 | 4);
        return true;
      case 'pfl':
        return false;
      default:
        return true; // el resto de los controles no hace nada en Modo Fácil
    }
  }

  private master(name: string, m: MidiMessage, b: Binding): void {
    const h = this.host;
    const v = m.value / 127;
    switch (name) {
      case 'browse':
        h.browse(b.relative ? relativeDelta(m.value) : m.value >= 64 ? 1 : -1);
        break;
      case 'browsePush':
        if (m.type === 'noteon') h.browsePush();
        break;
      case 'crossfader':
        h.autodj.userTouchedCrossfader();
        h.mixer.setCrossfader(v * 2 - 1);
        break;
      case 'masterVolume':
        h.mixer.setMaster(v);
        break;
      case 'cueMix':
        h.mixer.setCueMix(v);
        break;
      case 'cueVolume':
        h.mixer.setPhonesVolume(v);
        break;
      default:
        if (name.startsWith('sample') && m.type === 'noteon') h.sampler.trigger(Number(name.slice(6)) - 1);
    }
  }

  private deck(d: Deck, name: string, m: MidiMessage, b: Binding): void {
    const press = m.type === 'noteon';
    const release = m.type === 'noteoff';
    const isCc = m.type === 'cc';
    // Tocar cualquier control del deck (salvo la preescucha) le saca el deck a la IA.
    if (name !== 'pfl' && (press || isCc)) this.host.autodj.userTouchedDeck(d);
    const other = d === this.host.decks.A ? this.host.decks.B : this.host.decks.A;

    switch (name) {
      case 'play':
        if (press) d.togglePlay();
        break;
      case 'cue':
        if (press) d.cueDown();
        else if (release) d.cueUp();
        break;
      case 'sync':
        if (press) {
          if (d.synced) d.unsync();
          else if (!d.syncTo(other)) this.host.toast('Sync necesita los dos temas analizados (archivos locales).');
        }
        break;
      case 'pfl':
        if (press) d.setPfl(!d.pfl);
        break;
      case 'jog':
        d.jog(b.relative ? relativeDelta(m.value) : m.value - 64);
        break;
      case 'pitch': {
        let x = (m.value - 64) / 63.5;
        if (Math.abs(m.value - 64) <= 1) x = 0;
        if (this.pitchInvert) x = -x;
        d.setPitchNorm(Math.max(-1, Math.min(1, x)));
        if (d.synced) d.unsync();
        break;
      }
      case 'volume':
        d.setVolume(m.value / 127);
        break;
      case 'hotcue1':
      case 'hotcue2':
      case 'hotcue3':
      case 'hotcue4':
        if (press) d.hotcue(Number(name.slice(-1)) - 1);
        break;
      case 'loopIn':
        if (press) d.loopIn();
        break;
      case 'loopOut':
        if (press) d.loopOut();
        break;
      case 'loopHalf':
        if (press) d.resizeLoop(0.5);
        break;
      case 'loopDouble':
        if (press) d.resizeLoop(2);
        break;
      case 'beatjumpBack':
        if (press) d.beatjump(-1);
        break;
      case 'beatjumpFwd':
        if (press) d.beatjump(1);
        break;
      case 'fx3':
        // Beat roll: suena mientras mantenés el pad
        if (press) d.rollStart(0.25);
        else if (release) d.rollStop();
        break;
      case 'fx1':
      case 'fx2':
      case 'fx4':
        if (press) d.toggleFx(Number(name.slice(-1)) as 1 | 2 | 4);
        break;
      case 'load':
        if (press) {
          if (d.playing) this.host.toast(`El Deck ${d.id} está sonando: pausalo antes de cargar otro tema.`);
          else this.host.loadSelected(d);
        }
        break;
    }
  }

  // ---------------------------------------------------------------- LEDs

  private ledFor(b: Binding, blink: boolean): boolean {
    if (this.blink.has(b.action)) return Math.floor(performance.now() / 180) % 2 === 0;
    const [scope, name] = b.action.split('.') as [string, string];
    if (this.mode === 'easy' && scope !== 'M') {
      if (/^hotcue[1-4]$/.test(name) || name === 'sync') return true;
      if (name === 'play') return !!this.host.autodj.currentDeck?.playing;
      if (name === 'pfl') return this.host.decks[scope as DeckId].pfl;
      return false;
    }
    if (scope === 'M') return name.startsWith('sample') ? !!this.host.sampler.pads[Number(name.slice(6)) - 1]?.playing : false;
    const d = this.host.decks[scope as DeckId];
    switch (name) {
      case 'play':
        return d.playing || (d.loaded && blink && Math.abs(d.position() - d.cuePoint) < 0.05);
      case 'cue':
        return d.loaded && !d.playing;
      case 'sync':
        return d.synced;
      case 'pfl':
        return d.pfl;
      case 'hotcue1':
      case 'hotcue2':
      case 'hotcue3':
      case 'hotcue4':
        return d.hotcues[Number(name.slice(-1)) - 1] != null;
      case 'loopIn':
        return d.loop.on || (d.loopInPending !== null && blink);
      case 'loopOut':
      case 'loopHalf':
      case 'loopDouble':
        return d.loop.on;
      case 'fx1':
        return d.fx.echo;
      case 'fx2':
        return d.fx.reverb;
      case 'fx3':
        return d.fx.roll > 0;
      case 'fx4':
        return d.fx.flanger;
      default:
        return false;
    }
  }

  private syncLeds(): void {
    if (!this.midi.output) return;
    const blink = Math.floor(performance.now() / 400) % 2 === 0;
    for (const b of this.mapping) {
      if (b.kind !== 'note' || !b.led) continue;
      const key = `${b.channel}:${b.number}`;
      const on = this.ledFor(b, blink);
      if (this.ledState.get(key) !== on) {
        this.ledState.set(key, on);
        this.midi.led(b.channel, b.number, on);
      }
    }
  }

  allLedsOff(): void {
    for (const b of this.mapping) if (b.kind === 'note' && b.led) this.midi.led(b.channel, b.number, false);
    this.ledState.clear();
  }
}
