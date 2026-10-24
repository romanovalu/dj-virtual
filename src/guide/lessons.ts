// Lecciones del Modo Aprender. Cada paso se ubica en compases relativos al inicio de la mezcla
// (negativo = antes). Si no llegás antes del plazo, la IA lo hace y te lo cuenta.
import type { Deck } from '../audio/deck';
import type { ActionId } from '../midi/mapping';

export interface LessonCtx {
  out: Deck;
  inc: Deck;
  /** Compás relativo al inicio de la mezcla. */
  bar: number;
  /** Progreso de la mezcla 0..1 (null antes de que arranque). */
  p: number | null;
  /** Error de entrada en ms del último Play (lección 2). */
  entryMs: number | null;
  entryByAi: boolean;
  /** Crossfader (−1..1). */
  xf: number;
  /** Pads del sampler disparados desde que empezó la lección. */
  samplerHits: number;
  /** Lo que el usuario tenía que hacer lo hizo la IA (para notas). */
  mark(note: string): void;
  ungrant(param: string): void;
}

export interface Step {
  id: string;
  /** Compás en que aparece. */
  from: number;
  /** Compás límite: después lo hace la IA (o se da por visto si es informativo). */
  until: number;
  text(c: LessonCtx): string;
  why?: string;
  /** Selectores de la pantalla a resaltar. */
  ui?(c: LessonCtx): string[];
  /** Controles del DJ2GO2 cuyo LED titila. */
  midi?(c: LessonCtx): ActionId[];
  /** Compás al que apunta la cuenta regresiva. */
  countdownTo?: number;
  /** Marca de objetivo para el crossfader (−1..1). */
  xfTarget?(c: LessonCtx): number | null;
  /** Paso cumplido por el usuario. Sin `done`, el paso es informativo. */
  done?(c: LessonCtx): boolean;
  /** Parámetro que el usuario tiene que seguir manejando; si la IA lo tomó, el paso se saltea. */
  requires?: string;
  /** Lo que hace la IA si se vence el plazo. */
  fallback?(c: LessonCtx): void;
  /** Nota para la devolución cuando se cumple. */
  grade?(c: LessonCtx): string;
}

export interface Lesson {
  level: number;
  title: string;
  goal: string;
  /** Parámetros que maneja el usuario en esta lección. */
  grants(out: Deck, inc: Deck): string[];
  /** Pads del DJ2GO2 que cambian de función en esta lección. */
  pads?(out: Deck, inc: Deck): Partial<Record<ActionId, () => void>>;
  steps: Step[];
}

const pflUi = (d: Deck) => [`.chan[data-deck="${d.id}"] .pfl`];
const deckUi = (d: Deck, sel: string) => [`.deck[data-deck="${d.id}"] ${sel}`];

/** Curva que usa la IA para el crossfader, en términos de "cuánto del entrante" (0..1). */
function smooth(p: number, a: number, b: number): number {
  if (p <= a) return 0;
  if (p >= b) return 1;
  const x = (p - a) / (b - a);
  return x * x * (3 - 2 * x);
}
export function xfTargetFor(p: number, inc: Deck): number {
  const s = 0.5 * smooth(p, 0, 0.45) + 0.5 * smooth(p, 0.7, 1);
  const sIn = inc.id === 'A' ? -1 : 1;
  return (2 * s - 1) * sIn;
}
export function incShare(xf: number, inc: Deck): number {
  const sIn = inc.id === 'A' ? -1 : 1;
  return Math.max(0, Math.min(1, (xf * sIn + 1) / 2));
}

const pflStep: Step = {
  id: 'pfl',
  from: -12,
  until: -3,
  text: (c) => `Escuchá el próximo tema en los auriculares: tocá 🎧 CUE del Deck ${c.inc.id}.`,
  why: 'La preescucha te deja oír el tema que viene sin que lo escuche la pista.',
  ui: (c) => pflUi(c.inc),
  midi: (c) => [`${c.inc.id}.pfl`],
  done: (c) => c.inc.pfl,
  fallback: (c) => c.inc.setPfl(true),
};

const pflOffStep: Step = {
  id: 'pfl-off',
  from: 2,
  until: 12,
  text: (c) => `Ya entró: sacá 🎧 CUE del Deck ${c.inc.id} para volver a escuchar lo que suena.`,
  ui: (c) => pflUi(c.inc),
  midi: (c) => [`${c.inc.id}.pfl`],
  done: (c) => !c.inc.pfl,
  fallback: (c) => c.inc.setPfl(false),
};

export const LESSONS: Lesson[] = [
  {
    level: 1,
    title: 'Preescuchar',
    goal: 'Escuchar el próximo tema en los auriculares antes de que suene en la pista.',
    grants: (_o, inc) => [`${inc.id}.pfl`],
    steps: [
      pflStep,
      {
        id: 'cue-preview',
        from: -9,
        until: -2,
        text: (c) => `Mantené apretado CUE del Deck ${c.inc.id}: suena el arranque sólo en tus auriculares. Al soltarlo vuelve solo al compás 1.`,
        why: 'Así chequeás que el tema arranque donde querés, sin que nadie lo note.',
        ui: (c) => deckUi(c.inc, '.cue'),
        midi: (c) => [`${c.inc.id}.cue`],
        done: (c) => c.inc.cuePreviewCount > 0,
      },
      {
        id: 'watch',
        from: -1,
        until: 3,
        text: (c) => `Mirá y escuchá: la IA arranca el Deck ${c.inc.id} justo en el compás 1 y lo va subiendo.`,
        countdownTo: 0,
      },
      pflOffStep,
    ],
  },
  {
    level: 2,
    title: 'Entrar en el compás 1',
    goal: 'Darle Play al próximo tema justo cuando arranca la frase.',
    grants: (_o, inc) => [`${inc.id}.play`, `${inc.id}.pfl`],
    steps: [
      pflStep,
      {
        id: 'ready',
        from: -4,
        until: -1,
        text: (c) => `Preparate: vas a darle Play al Deck ${c.inc.id} cuando termine este compás. Contá con la música: 1, 2, 3, 4…`,
        why: 'La música bailable va en frases de 8 o 16 compases. Entrar en el "1" hace que todo encaje.',
        ui: (c) => deckUi(c.inc, '.play'),
        midi: (c) => [`${c.inc.id}.play`],
        countdownTo: 0,
      },
      {
        id: 'play',
        from: -1,
        until: 0.5,
        text: (c) => `¡Play al Deck ${c.inc.id} en el 1!`,
        ui: (c) => deckUi(c.inc, '.play'),
        midi: (c) => [`${c.inc.id}.play`],
        countdownTo: 0,
        done: (c) => c.entryMs !== null && !c.entryByAi,
        grade: (c) => {
          const e = c.entryMs ?? 0;
          if (Math.abs(e) < 70) return `Entrada a tiempo (${Math.round(e)} ms)`;
          return `Entraste ${Math.abs(Math.round(e))} ms ${e > 0 ? 'tarde' : 'temprano'}; lo acomodé yo. ${Math.abs(e) < 250 ? 'Casi.' : 'Probá anticiparte un poquito.'}`;
        },
      },
      pflOffStep,
    ],
  },
  {
    level: 3,
    title: 'Crossfader',
    goal: 'Pasar de un tema al otro con el crossfader, a la velocidad justa.',
    grants: () => ['xf'],
    steps: [
      {
        id: 'xf-ready',
        from: -4,
        until: 0,
        text: (c) => `Cuando entre el Deck ${c.inc.id} vas a mover vos el crossfader. Seguí la marca violeta.`,
        why: 'El crossfader decide cuánto se escucha de cada tema. Si lo movés de golpe se nota el corte.',
        ui: () => ['#xfader'],
        midi: () => [],
        countdownTo: 0,
      },
      {
        id: 'xf-center',
        from: 0,
        until: 4,
        requires: 'xf',
        text: () => 'Llevá el crossfader despacio hasta la marca violeta. Seguila mientras se mueve.',
        ui: () => ['#xfader'],
        xfTarget: (c) => (c.p === null ? null : xfTargetFor(c.p, c.inc)),
        // Alcanza con que empiece a moverlo: seguir la marca se evalúa al final.
        done: (c) => incShare(c.xf, c.inc) > 0.06,
        fallback: (c) => {
          c.ungrant('xf');
          c.mark('El crossfader no se movió a tiempo: lo moví yo esta vez.');
        },
      },
      {
        id: 'xf-follow',
        requires: 'xf',
        from: 3,
        until: 11,
        text: () => 'Bien. Quedate cerca de la marca: el tema nuevo va ganando de a poco.',
        ui: () => ['#xfader'],
        xfTarget: (c) => (c.p === null ? null : xfTargetFor(c.p, c.inc)),
      },
      {
        id: 'xf-end',
        requires: 'xf',
        from: 11,
        until: 16,
        text: (c) => `Ahora terminá de pasarlo del todo al Deck ${c.inc.id}.`,
        ui: () => ['#xfader'],
        xfTarget: (c) => (c.p === null ? null : xfTargetFor(c.p, c.inc)),
        done: (c) => incShare(c.xf, c.inc) > 0.95,
        fallback: (c) => {
          c.ungrant('xf');
          c.mark('El final del crossfade lo terminé yo.');
        },
      },
    ],
  },
  {
    level: 4,
    title: 'Igualar el tempo',
    goal: 'Poner los dos temas a la misma velocidad con el pitch fader.',
    grants: (_o, inc) => [`${inc.id}.tempo`],
    steps: [
      {
        id: 'pitch',
        from: -14,
        until: -1,
        text: (c) => {
          const target = c.out.bpm;
          const now = c.inc.analysis ? c.inc.analysis.bpm * c.inc.tempo : 0;
          const m = target / now > 1.5 ? 2 : now / target > 1.5 ? 0.5 : 1;
          const diff = target - now * m;
          const arrow = Math.abs(diff) < 0.25 ? '✔ ¡igualados!' : diff > 0 ? '▲ más rápido' : '▼ más lento';
          return `Mové el pitch del Deck ${c.inc.id}: está a ${(now * m).toFixed(1)} BPM y el que suena a ${target.toFixed(1)}. ${arrow}`;
        },
        why: 'Si los dos temas no van a la misma velocidad, los bombos se separan y suena como un galope.',
        ui: (c) => deckUi(c.inc, '.pitch'),
        midi: () => [],
        done: (c) => {
          const now = c.inc.analysis ? c.inc.analysis.bpm * c.inc.tempo : 0;
          const target = c.out.bpm;
          const m = target / now > 1.5 ? 2 : now / target > 1.5 ? 0.5 : 1;
          return Math.abs(target - now * m) < 0.25;
        },
        fallback: (c) => {
          c.ungrant(`${c.inc.id}.tempo`);
          const a = c.inc.analysis;
          if (a) c.inc.setTempo(c.out.bpm / a.bpm);
          c.mark('Igualé el tempo yo esta vez.');
        },
        grade: () => 'Tempo igualado (la IA corrige la fase fina mientras mezcla)',
      },
      {
        id: 'watch',
        from: -1,
        until: 4,
        text: () => 'Con el mismo tempo, los bombos de los dos temas caen juntos. Escuchalo en la mezcla.',
        countdownTo: 0,
      },
    ],
  },
  {
    level: 5,
    title: 'Cambio de graves',
    goal: 'Hacer el bass swap: pasar el bajo de un tema al otro en el momento justo.',
    grants: (out, inc) => [`${out.id}.low`, `${inc.id}.low`],
    pads: (out, inc) => ({
      [`${out.id}.hotcue1`]: () => out.setEq('low', out.eq.low <= -30 ? 0 : -40),
      [`${inc.id}.hotcue1`]: () => inc.setEq('low', inc.eq.low <= -30 ? 0 : -40),
    }),
    steps: [
      {
        id: 'explain',
        from: -6,
        until: 2,
        text: (c) => `El Deck ${c.inc.id} va a entrar sin graves (perilla GRAVES al mínimo). En la mitad de la mezcla vas a cambiar los graves vos.`,
        why: 'Dos bajos sonando juntos chocan y suena embarrado. Por eso se usa uno por vez.',
        ui: (c) => [`.chan[data-deck="${c.inc.id}"] .k-low`],
      },
      {
        id: 'swap',
        from: 5,
        until: 9.5,
        text: (c) =>
          `En el compás 8 (mitad de la mezcla): sacá los graves del Deck ${c.out.id} y devolvé los del Deck ${c.inc.id}. Usá las perillas GRAVES o el pad 1 de cada deck.`,
        ui: (c) => [`.chan[data-deck="${c.out.id}"] .k-low`, `.chan[data-deck="${c.inc.id}"] .k-low`],
        midi: (c) => [`${c.out.id}.hotcue1`, `${c.inc.id}.hotcue1`],
        countdownTo: 8,
        done: (c) => c.out.eq.low <= -30 && c.inc.eq.low >= -6,
        fallback: (c) => {
          c.ungrant(`${c.out.id}.low`);
          c.ungrant(`${c.inc.id}.low`);
          c.mark('El cambio de graves lo hice yo esta vez.');
        },
        grade: (c) => {
          const d = c.bar - 8;
          return Math.abs(d) < 0.5 ? 'Cambio de graves justo en el 8' : `Cambio de graves ${Math.abs(d).toFixed(1)} compases ${d > 0 ? 'tarde' : 'temprano'}.`;
        },
      },
    ],
  },
  {
    level: 6,
    title: 'Efectos con onda',
    goal: 'Usar efectos al ritmo: un roll antes de la frase, una sirena y un eco de salida.',
    grants: () => [],
    steps: [
      {
        id: 'roll',
        from: -2,
        until: 0.25,
        text: (c) => `En el último compás antes de la mezcla, mantené ROLL ¼ del Deck ${c.out.id} (o el pad 3 de FX) y soltalo justo en el 1.`,
        why: 'El roll repite un pedacito cada vez más rápido y crea tensión. Al soltarlo en el 1, el tema sigue como si nada.',
        ui: (c) => deckUi(c.out, '.roll[data-roll="0.25"]'),
        midi: (c) => [`${c.out.id}.fx3`],
        countdownTo: 0,
        done: (c) => c.out.rollCount > 0 && c.out.fx.roll === 0 && c.bar > -1.05,
        grade: (c) => (Math.abs(c.bar) < 0.3 ? 'Roll soltado en el 1' : 'Roll hecho; la próxima soltalo más justo en el 1'),
      },
      {
        id: 'sample',
        from: 0,
        until: 6,
        text: () => 'Tirá la 🚨 Sirena del sampler (pad 1). No te preocupes por el tiempo: la app la hace caer en el beat.',
        why: 'Un sample al empezar la mezcla avisa que viene algo nuevo. Uno por frase alcanza.',
        ui: () => ['.sampler-pads button[data-pad="0"]'],
        midi: () => ['M.sample1'],
        done: (c) => c.samplerHits > 0,
      },
      {
        id: 'echo',
        from: 11,
        until: 15.5,
        text: (c) => `Ahora activá el ECO del Deck ${c.out.id}: el tema viejo se va rebotando.`,
        why: 'El eco de salida tapa el corte del tema que se va y queda muy de DJ.',
        ui: (c) => deckUi(c.out, '.fx[data-fx="echo"]'),
        midi: (c) => [`${c.out.id}.fx1`],
        done: (c) => c.out.fx.echo,
      },
    ],
  },
];
