// Mapeo del Numark DJ2GO2. Canales MIDI contados desde 1 (como en el .tsi de Traktor).
// Note On = 0x90 + (canal - 1), CC = 0xB0 + (canal - 1).

export type MidiKind = 'note' | 'cc';
export type DeckId = 'A' | 'B';

export interface Binding {
  action: ActionId;
  kind: MidiKind;
  channel: number; // 1..16
  number: number; // 0..127
  /** El control tiene LED y se le devuelve la misma nota. */
  led?: boolean;
  /** Inferido del .tsi: confirmar con el Monitor o MIDI Learn. */
  inferred?: boolean;
  /** CC relativo (encoder / jog): 1..63 = +, 65..127 = - */
  relative?: boolean;
}

const DECK_ACTION_NAMES = [
  'play',
  'cue',
  'sync',
  'pfl',
  'jog',
  'jogTouch',
  'pitch',
  'volume',
  'hotcue1',
  'hotcue2',
  'hotcue3',
  'hotcue4',
  'loopIn',
  'loopOut',
  'loopHalf',
  'loopDouble',
  'beatjumpBack',
  'beatjumpFwd',
  'fx1',
  'fx2',
  'fx3',
  'fx4',
  'load',
] as const;
export type DeckActionName = (typeof DECK_ACTION_NAMES)[number];

const MASTER_ACTION_NAMES = [
  'browse',
  'browsePush',
  'crossfader',
  'masterVolume',
  'cueMix',
  'cueVolume',
  'sample1',
  'sample2',
  'sample3',
  'sample4',
  'sample5',
  'sample6',
  'sample7',
  'sample8',
] as const;
export type MasterActionName = (typeof MASTER_ACTION_NAMES)[number];

export type ActionId = `${DeckId}.${DeckActionName}` | `M.${MasterActionName}`;

const DECK_LABELS: Record<DeckActionName, string> = {
  play: 'Play / Pausa',
  cue: 'Cue',
  sync: 'Sync',
  pfl: 'Auriculares (PFL)',
  jog: 'Jog wheel',
  jogTouch: 'Jog: tacto (scratch)',
  pitch: 'Pitch fader',
  volume: 'Nivel del canal',
  hotcue1: 'Hot cue 1',
  hotcue2: 'Hot cue 2',
  hotcue3: 'Hot cue 3',
  hotcue4: 'Hot cue 4',
  loopIn: 'Loop in',
  loopOut: 'Loop out / salir',
  loopHalf: 'Loop ÷2',
  loopDouble: 'Loop ×2',
  beatjumpBack: 'Beatjump ←',
  beatjumpFwd: 'Beatjump →',
  fx1: 'FX 1 (eco)',
  fx2: 'FX 2 (reverb)',
  fx3: 'FX 3 (beat roll, mantener)',
  fx4: 'FX 4 (flanger)',
  load: 'Cargar tema',
};

const MASTER_LABELS: Record<MasterActionName, string> = {
  browse: 'Perilla Browse',
  browsePush: 'Botón Browse (agregar a la cola)',
  crossfader: 'Crossfader',
  masterVolume: 'Volumen master',
  cueMix: 'Cue mix (auriculares)',
  cueVolume: 'Volumen auriculares',
  sample1: 'Sampler 1',
  sample2: 'Sampler 2',
  sample3: 'Sampler 3',
  sample4: 'Sampler 4',
  sample5: 'Sampler 5',
  sample6: 'Sampler 6',
  sample7: 'Sampler 7',
  sample8: 'Sampler 8',
};

export const ALL_ACTIONS: ActionId[] = [
  ...(['A', 'B'] as DeckId[]).flatMap((d) => DECK_ACTION_NAMES.map((a) => `${d}.${a}` as ActionId)),
  ...MASTER_ACTION_NAMES.map((a) => `M.${a}` as ActionId),
];

export function actionLabel(id: ActionId): string {
  const [scope, name] = id.split('.') as [string, string];
  if (scope === 'M') return MASTER_LABELS[name as MasterActionName];
  return `Deck ${scope} · ${DECK_LABELS[name as DeckActionName]}`;
}

export function defaultMapping(): Binding[] {
  const out: Binding[] = [];
  const deck = (d: DeckId, ch: number, pads: number) => {
    out.push(
      { action: `${d}.play`, kind: 'note', channel: ch, number: 0, led: true },
      { action: `${d}.cue`, kind: 'note', channel: ch, number: 1, led: true },
      { action: `${d}.sync`, kind: 'note', channel: ch, number: 2, led: true },
      { action: `${d}.pfl`, kind: 'note', channel: ch, number: 27, led: true },
      { action: `${d}.jog`, kind: 'cc', channel: ch, number: 6, relative: true },
      // DJ2GO2 Touch: el jog es sensible al tacto (nota 6: 127 al tocar, 0 al soltar)
      { action: `${d}.jogTouch`, kind: 'note', channel: ch, number: 6 },
      { action: `${d}.pitch`, kind: 'cc', channel: ch, number: 9 },
      { action: `${d}.volume`, kind: 'cc', channel: ch, number: 22 },
      { action: `${d}.hotcue1`, kind: 'note', channel: pads, number: 1, led: true },
      { action: `${d}.hotcue2`, kind: 'note', channel: pads, number: 2, led: true },
      { action: `${d}.hotcue3`, kind: 'note', channel: pads, number: 3, led: true },
      { action: `${d}.hotcue4`, kind: 'note', channel: pads, number: 4, led: true },
      { action: `${d}.loopIn`, kind: 'note', channel: pads, number: 17, led: true },
      { action: `${d}.loopOut`, kind: 'note', channel: pads, number: 18, led: true },
      { action: `${d}.loopHalf`, kind: 'note', channel: pads, number: 19, led: true, inferred: true },
      { action: `${d}.loopDouble`, kind: 'note', channel: pads, number: 20, led: true, inferred: true },
      // Modo sampler de los pads (confirmado con el Monitor): Deck A = 1-4, Deck B = 5-8
      ...[0, 1, 2, 3].map((k) => ({ action: `M.sample${k + 1 + (d === 'B' ? 4 : 0)}` as ActionId, kind: 'note' as const, channel: pads, number: 33 + k, led: true })),
      { action: `${d}.fx1`, kind: 'note', channel: pads, number: 49, led: true },
      { action: `${d}.fx2`, kind: 'note', channel: pads, number: 50, led: true },
      { action: `${d}.fx3`, kind: 'note', channel: pads, number: 51, led: true },
      { action: `${d}.fx4`, kind: 'note', channel: pads, number: 52, led: true },
    );
  };
  deck('A', 1, 5);
  deck('B', 2, 6);
  out.push(
    { action: 'M.browse', kind: 'cc', channel: 16, number: 0, relative: true },
    { action: 'M.browsePush', kind: 'note', channel: 16, number: 6 },
    { action: 'A.load', kind: 'note', channel: 16, number: 2 },
    { action: 'B.load', kind: 'note', channel: 16, number: 3 },
    { action: 'M.crossfader', kind: 'cc', channel: 16, number: 8 },
    { action: 'M.masterVolume', kind: 'cc', channel: 16, number: 10 },
    { action: 'M.cueMix', kind: 'cc', channel: 16, number: 12 },
  );
  return out;
}

const STORAGE_KEY = 'djv.midiMapping.v1';

export function loadMapping(): Binding[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Binding[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch {
    /* sin storage: usamos el mapeo por defecto */
  }
  return defaultMapping();
}

export function saveMapping(map: Binding[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignorar */
  }
}

export function resetMapping(): Binding[] {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignorar */
  }
  return defaultMapping();
}

/** MIDI Learn: asigna un control a una acción, reemplazando lo que hubiera. */
export function learnBinding(map: Binding[], action: ActionId, kind: MidiKind, channel: number, number: number, relative: boolean): Binding[] {
  const prevLed = map.find((b) => b.action === action)?.led;
  const next = map.filter((b) => b.action !== action && !(b.kind === kind && b.channel === channel && b.number === number));
  next.push({ action, kind, channel, number, led: kind === 'note' ? (prevLed ?? true) : undefined, relative: relative || undefined });
  return next;
}

export function findBinding(map: Binding[], kind: MidiKind, channel: number, number: number): Binding | undefined {
  return map.find((b) => b.kind === kind && b.channel === channel && b.number === number);
}

export function bindingLabel(b: Pick<Binding, 'kind' | 'channel' | 'number'>): string {
  const status = (b.kind === 'note' ? 0x90 : 0xb0) + b.channel - 1;
  return `${b.kind === 'note' ? 'Nota' : 'CC'} ${b.number} · canal ${b.channel} (${hex(status)} ${hex(b.number)})`;
}

export function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}
