// Rueda Camelot: tonalidad → código (8A, 8B, ...) y compatibilidad armónica.

const MAJOR: Record<string, number> = { B: 1, 'F#': 2, Gb: 2, Db: 3, 'C#': 3, Ab: 4, 'G#': 4, Eb: 5, 'D#': 5, Bb: 6, 'A#': 6, F: 7, C: 8, G: 9, D: 10, A: 11, E: 12 };
const MINOR: Record<string, number> = { 'G#': 1, Ab: 1, 'D#': 2, Eb: 2, Bb: 3, 'A#': 3, F: 4, C: 5, G: 6, D: 7, A: 8, E: 9, B: 10, 'F#': 11, Gb: 11, 'C#': 12, Db: 12 };

export function toCamelot(key: string, scale: string): string {
  const minor = scale.toLowerCase().startsWith('min');
  const n = (minor ? MINOR : MAJOR)[key];
  return n ? `${n}${minor ? 'A' : 'B'}` : '?';
}

export function keyLabel(key: string, scale: string): string {
  return `${key}${scale.toLowerCase().startsWith('min') ? 'm' : ''}`;
}

function parse(c: string): { n: number; l: string } | null {
  const m = /^(\d{1,2})([AB])$/.exec(c);
  return m ? { n: Number(m[1]), l: m[2] } : null;
}

/**
 * Costo armónico de pasar de a → b (0 = perfecto).
 * Mismo código 0 · ±1 o relativo (A↔B) 1 · ±2 / diagonal 2.5 · resto 4.
 */
export function camelotCost(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 2;
  const d = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
  if (x.l === y.l) {
    if (d === 0) return 0;
    if (d === 1) return 1;
    if (d === 2) return 2.5;
    return 4;
  }
  if (d === 0) return 1;
  if (d === 1) return 2.5;
  return 4;
}

export function camelotCompatible(a: string, b: string): boolean {
  return camelotCost(a, b) <= 1;
}
