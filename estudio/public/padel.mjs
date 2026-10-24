// Tanteador de padel: puntos 0-15-30-40, ventaja o punto de oro, tie-break a 7 en 6-6, partido al mejor de 3 sets.

export function newMatch(opts = {}) {
  return {
    teams: opts.teams ?? ['Equipo 1', 'Equipo 2'],
    goldenPoint: opts.goldenPoint ?? true,
    setsToWin: opts.setsToWin ?? 2,
    sets: [], // sets terminados: [[6,4],[3,6]]
    games: [0, 0],
    points: [0, 0], // en juego normal: 0..4 (4 = ventaja); en tie-break: puntos corridos
    tiebreak: false,
    server: 0,
    winner: null,
  };
}

const LABELS = ['0', '15', '30', '40', 'AD'];

/** Texto de los puntos del juego en curso para cada equipo. */
export function pointLabels(m) {
  if (m.tiebreak) return m.points.map(String);
  return m.points.map((p) => LABELS[p]);
}

export function setsWon(m) {
  const won = [0, 0];
  for (const [a, b] of m.sets) won[a > b ? 0 : 1]++;
  return won;
}

/** Suma un punto al equipo `t` (0 o 1). Devuelve un partido nuevo, no modifica el anterior. */
export function addPoint(match, t) {
  if (match.winner !== null) return match;
  const m = structuredClone(match);
  const o = 1 - t;
  const p = m.points;

  if (m.tiebreak) {
    p[t]++;
    if (p[t] >= 7 && p[t] - p[o] >= 2) return winGame(m, t);
    // En el tie-break cambia el saque en el primer punto y después cada dos.
    if ((p[0] + p[1]) % 2 === 1) m.server = 1 - m.server;
    return m;
  }

  if (p[t] === 3 && p[o] === 3) {
    if (m.goldenPoint) return winGame(m, t);
    p[t] = 4;
    return m;
  }
  if (p[t] === 3 && p[o] === 4) {
    p[o] = 3; // vuelve a iguales
    return m;
  }
  if (p[t] === 4 || (p[t] === 3 && p[o] < 3)) return winGame(m, t);
  p[t]++;
  return m;
}

function winGame(m, t) {
  const o = 1 - t;
  const g = m.games;
  g[t]++;
  m.points = [0, 0];
  const wasTiebreak = m.tiebreak;
  m.tiebreak = false;
  if (!wasTiebreak) m.server = 1 - m.server;

  if ((g[t] >= 6 && g[t] - g[o] >= 2) || wasTiebreak) {
    m.sets.push([g[0], g[1]]);
    m.games = [0, 0];
    if (setsWon(m)[t] >= m.setsToWin) m.winner = t;
    return m;
  }
  if (g[0] === 6 && g[1] === 6) m.tiebreak = true;
  return m;
}
