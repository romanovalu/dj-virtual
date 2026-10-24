// Planificación de una transición: en qué frase del tema saliente arrancar, desde dónde entra el
// entrante y a qué tempo. Puro (sin Web Audio) para poder testearlo.
import { barStartBeat, beatTime, firstDownbeat, type Analysis } from '../library.ts';

export interface MixPlan {
  /** Inicio de la mezcla en el tema saliente (s, tiempo del tema). */
  outStart: number;
  /** Compases de la transición. */
  bars: number;
  /** Duración de la mezcla en segundos reales (con el tempo del saliente). */
  realDuration: number;
  /** Punto de entrada del tema entrante (s): su primer downbeat. */
  inCue: number;
  /** Tempo a aplicar al entrante para igualar BPM. */
  tempoIn: number;
  /** Multiplicador half/double time aplicado al BPM del entrante. */
  mult: number;
  /** Si la diferencia de BPM es razonable para beatmatchear (≤ 10 %). */
  beatmatch: boolean;
}

export const MAX_TEMPO_CHANGE = 0.1;

export function bpmMultiplier(from: number, to: number): number {
  let best = 1;
  for (const m of [0.5, 1, 2]) if (Math.abs(Math.log((from * m) / to)) < Math.abs(Math.log((from * best) / to))) best = m;
  return best;
}

/**
 * Elige la última frase (cada 16 compases desde el primer downbeat; si no entra, cada 8) tal que
 * la transición de `bars` compases termine antes del final del audio del saliente.
 */
export function planMix(out: Analysis, outTempo: number, outPos: number, inc: Analysis, bars: number, minLead = 4): MixPlan {
  const outBpmEff = out.bpm * outTempo;
  const mult = bpmMultiplier(inc.bpm, outBpmEff);
  let tempoIn = outBpmEff / (inc.bpm * mult);
  const beatmatch = Math.abs(tempoIn - 1) <= MAX_TEMPO_CHANGE;
  if (!beatmatch) tempoIn = 1;

  const beatSec = 60 / out.bpm;
  const end = out.audioEnd;
  const tryBars = [bars, bars / 2, 8, 4].filter((b, i, arr) => b >= 4 && arr.indexOf(b) === i);
  for (const b of tryBars) {
    const dur = b * 4 * beatSec;
    for (const step of [16, 8, 4]) {
      // Recorremos frases desde el final hacia atrás.
      const d0 = barStartBeat(out, 0);
      const lastBar = Math.floor((end - beatTime(out, d0)) / (4 * beatSec));
      for (let bar = Math.floor(lastBar / step) * step; bar >= 0; bar -= step) {
        const t = beatTime(out, d0 + bar * 4);
        if (t + dur > end + beatSec) continue;
        if (t < outPos + minLead) break;
        return { outStart: t, bars: b, realDuration: dur / outTempo, inCue: firstDownbeat(inc), tempoIn, mult, beatmatch };
      }
    }
  }
  // No entra ninguna frase: mezclamos cuanto antes, alineado al próximo compás.
  const d0 = barStartBeat(out, 0);
  const nextBar = Math.ceil((outPos + minLead - beatTime(out, d0)) / (4 * beatSec));
  const t = beatTime(out, d0 + Math.max(0, nextBar) * 4);
  const remainingBars = Math.max(1, Math.floor((end - t) / (4 * beatSec)));
  const b = Math.max(1, Math.min(4, remainingBars));
  return { outStart: t, bars: b, realDuration: (b * 4 * beatSec) / outTempo, inCue: firstDownbeat(inc), tempoIn, mult, beatmatch };
}

/** Diferencia de fase en beats (−0.5..0.5) entre el entrante y el saliente. */
export function phaseError(outBeat: number, inBeat: number, mult: number): number {
  let d = (inBeat * mult - outBeat) % 1;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
}

/**
 * Bend (fracción de velocidad) para corregir un error de fase: proporcional, con zona muerta de
 * 2 ms y tope de ±3 %, de modo que el pitch casi no se note.
 */
export function bendForPhaseError(errBeats: number, beatSec: number): number {
  const errSec = errBeats * beatSec;
  if (Math.abs(errSec) < 0.002) return 0;
  return Math.max(-0.03, Math.min(0.03, -errSec / 0.5));
}

/**
 * Mezcla "cuanto antes": arranca en el próximo límite de `gridBars` compases (al menos `minLead`
 * segundos adelante) y dura hasta `bars` compases, recortando si el tema se termina antes.
 */
export function planSoon(out: Analysis, outTempo: number, outPos: number, inc: Analysis | undefined, bars = 8, gridBars = 4, minLead = 1): MixPlan {
  const beatSec = 60 / out.bpm;
  const d0 = barStartBeat(out, 0);
  const barNow = (outPos + minLead * outTempo - beatTime(out, d0)) / (4 * beatSec);
  const bar = Math.max(0, Math.ceil(barNow / gridBars) * gridBars);
  const t = beatTime(out, d0 + bar * 4);
  const remainingBars = Math.floor((out.audioEnd - t) / (4 * beatSec));
  const b = Math.max(2, Math.min(bars, remainingBars));
  let tempoIn = 1;
  let mult = 1;
  let beatmatch = false;
  if (inc) {
    const outBpmEff = out.bpm * outTempo;
    mult = bpmMultiplier(inc.bpm, outBpmEff);
    tempoIn = outBpmEff / (inc.bpm * mult);
    beatmatch = Math.abs(tempoIn - 1) <= MAX_TEMPO_CHANGE;
    if (!beatmatch) tempoIn = 1;
  }
  return { outStart: t, bars: b, realDuration: (b * 4 * beatSec) / outTempo, inCue: inc ? firstDownbeat(inc) : 0, tempoIn, mult, beatmatch };
}
