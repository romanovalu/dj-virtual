// Orden del set: BPM (con half/double time), compatibilidad Camelot y curva de energía.
import { camelotCost } from '../analysis/camelot.ts';

export interface SetItem {
  id: string;
  bpm: number;
  camelot: string;
  energy: number;
}

/** Diferencia de BPM en % considerando half/double time. */
export function bpmDistancePct(a: number, b: number): number {
  let best = Infinity;
  for (const m of [0.5, 1, 2]) best = Math.min(best, Math.abs(Math.log((b * m) / a)));
  return (Math.exp(best) - 1) * 100;
}

/** Costo de transición a → b. Más bajo = mejor mezcla. */
export function transitionCost(a: SetItem, b: SetItem): number {
  const dBpm = bpmDistancePct(a.bpm, b.bpm);
  // Hasta ~4 % se beatmatchea sin que se note; más allá crece rápido, > 10 % casi prohibido.
  const bpmCost = dBpm <= 4 ? dBpm * 0.4 : 1.6 + (dBpm - 4) * 1.2 + (dBpm > 10 ? 15 : 0);
  const keyCost = camelotCost(a.camelot, b.camelot) * 1.1;
  // Energía: preferimos mantener o subir de a poco; bajar mucho o saltar mucho penaliza.
  const dE = b.energy - a.energy;
  const energyCost = dE < 0 ? -dE * 0.9 : dE > 2 ? (dE - 2) * 0.6 : 0;
  // Preferimos que el BPM vaya subiendo levemente a lo largo del set.
  const dir = b.bpm * (b.bpm < a.bpm * 0.75 ? 2 : 1) < a.bpm ? 0.3 : 0;
  return bpmCost + keyCost + energyCost + dir;
}

function pathCost(path: SetItem[]): number {
  let c = 0;
  for (let i = 1; i < path.length; i++) c += transitionCost(path[i - 1], path[i]);
  return c;
}

/**
 * Orden greedy (vecino más cercano) desde el tema de menor energía (o el que se indique como
 * primero), y luego mejora con 2-opt sobre los tramos internos.
 */
export function orderSet<T extends SetItem>(items: T[], first?: T): T[] {
  if (items.length <= 2) return first ? [first, ...items.filter((i) => i !== first)] : [...items];
  const rest = [...items];
  let cur = first ?? rest.reduce((m, x) => (x.energy < m.energy || (x.energy === m.energy && x.bpm < m.bpm) ? x : m));
  rest.splice(rest.indexOf(cur), 1);
  const path: T[] = [cur];
  while (rest.length) {
    let bi = 0;
    let bc = Infinity;
    for (let i = 0; i < rest.length; i++) {
      const c = transitionCost(cur, rest[i]);
      if (c < bc) {
        bc = c;
        bi = i;
      }
    }
    cur = rest.splice(bi, 1)[0];
    path.push(cur);
  }
  // 2-opt (el primero queda fijo)
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 1; i < path.length - 1; i++) {
      for (let j = i + 1; j < path.length; j++) {
        const cand = [...path.slice(0, i), ...path.slice(i, j + 1).reverse(), ...path.slice(j + 1)];
        if (pathCost(cand) + 1e-9 < pathCost(path)) {
          path.splice(0, path.length, ...cand);
          improved = true;
        }
      }
    }
  }
  return path;
}

export function describeTransition(a: SetItem, b: SetItem): string {
  const d = bpmDistancePct(a.bpm, b.bpm);
  const k = camelotCost(a.camelot, b.camelot);
  const key = k === 0 ? 'misma tonalidad' : k <= 1 ? 'armónica' : k <= 2.5 ? 'tensión leve' : 'choque de tonalidad';
  return `${d.toFixed(1)} % BPM · ${a.camelot}→${b.camelot} (${key}) · energía ${a.energy.toFixed(1)}→${b.energy.toFixed(1)}`;
}

export type Grade = 'green' | 'yellow' | 'red';

/** Semáforo de una transición: verde mezcla perfecto, amarillo se puede, rojo conviene cambiarla. */
export function transitionGrade(a: SetItem, b: SetItem): Grade {
  const c = transitionCost(a, b);
  return c <= 2.2 ? 'green' : c <= 4.5 ? 'yellow' : 'red';
}

/** Curva de energía (1..10) muestreada en 5 puntos: 0 %, 25 %, 50 %, 75 % y 100 % del set. */
export type EnergyCurve = [number, number, number, number, number];

export function curveAt(c: EnergyCurve, x: number): number {
  const f = Math.max(0, Math.min(1, x)) * 4;
  const i = Math.min(3, Math.floor(f));
  return c[i] + (c[i + 1] - c[i]) * (f - i);
}

/**
 * Ordena siguiendo una curva de energía: la curva (1..10) se lleva al rango de energía real de los
 * temas, y en cada lugar del set se elige el tema que mejor combina mezcla + energía buscada.
 */
export function orderToCurve<T extends SetItem & { duration: number }>(items: T[], curve: EnergyCurve, first?: SetItem): T[] {
  if (!items.length) return [];
  const es = items.map((i) => i.energy);
  const lo = Math.min(...es);
  const hi = Math.max(...es);
  const target = (x: number) => (hi - lo < 0.5 ? lo : lo + ((curveAt(curve, x) - 1) / 9) * (hi - lo));
  const total = items.reduce((s, i) => s + (i.duration || 240), 0);
  const rest = [...items];
  const out: T[] = [];
  let prev: SetItem | undefined = first;
  let elapsed = 0;
  while (rest.length) {
    const x = (elapsed + 60) / total;
    let bi = 0;
    let bc = Infinity;
    for (let i = 0; i < rest.length; i++) {
      const c = (prev ? transitionCost(prev, rest[i]) * 0.6 : 0) + Math.abs(rest[i].energy - target(x)) * 1.5;
      if (c < bc) {
        bc = c;
        bi = i;
      }
    }
    const t = rest.splice(bi, 1)[0];
    out.push(t);
    elapsed += t.duration || 240;
    prev = t;
  }
  return out;
}

/** Ordena favoreciendo subir (bias > 0) o bajar (bias < 0) la energía desde el tema actual. */
export function orderWithBias<T extends SetItem>(items: T[], from: SetItem, bias: number): T[] {
  const rest = [...items];
  const out: T[] = [];
  let prev = from;
  // Sólo los próximos 3 lugares siguen el bias; después se ordena normal.
  while (rest.length) {
    let bi = 0;
    let bc = Infinity;
    for (let i = 0; i < rest.length; i++) {
      const dE = rest[i].energy - prev.energy;
      const c = transitionCost(prev, rest[i]) * 0.5 + (out.length < 3 ? -bias * dE * 1.2 : 0);
      if (c < bc) {
        bc = c;
        bi = i;
      }
    }
    prev = rest.splice(bi, 1)[0];
    out.push(prev as T);
  }
  return out;
}
