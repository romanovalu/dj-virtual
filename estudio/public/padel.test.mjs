import assert from 'node:assert/strict';
import { newMatch, addPoint, pointLabels, setsWon } from './padel.mjs';

const play = (m, seq) => [...seq].reduce((acc, c) => addPoint(acc, Number(c)), m);

// Juego simple
let m = play(newMatch(), '0000');
assert.deepEqual(m.games, [1, 0]);
assert.deepEqual(m.points, [0, 0]);

// Punto de oro en 40-40
m = play(newMatch(), '000111' + '1');
assert.deepEqual(m.games, [0, 1]);

// Ventaja sin punto de oro: AD, vuelve a iguales, después gana
m = play(newMatch({ goldenPoint: false }), '000111');
assert.deepEqual(pointLabels(m), ['40', '40']);
m = play(m, '0');
assert.deepEqual(pointLabels(m), ['AD', '40']);
m = play(m, '1');
assert.deepEqual(pointLabels(m), ['40', '40']);
m = play(m, '11');
assert.deepEqual(m.games, [0, 1]);

// Set 6-4
const game = (t) => String(t).repeat(4);
m = newMatch();
for (const t of [0, 1, 0, 1, 0, 1, 0, 1, 0, 0]) m = play(m, game(t));
assert.deepEqual(m.sets, [[6, 4]]);
assert.deepEqual(m.games, [0, 0]);

// 6-6 entra en tie-break y se gana 7-5 en puntos => set 7-6
m = newMatch();
for (let i = 0; i < 6; i++) m = play(m, game(0) + game(1));
assert.equal(m.tiebreak, true);
m = play(m, '0101010101' + '00');
assert.deepEqual(m.sets, [[7, 6]]);
assert.equal(m.tiebreak, false);

// Partido al mejor de 3
m = newMatch();
for (let s = 0; s < 2; s++) for (let i = 0; i < 6; i++) m = play(m, game(1));
assert.equal(m.winner, 1);
assert.deepEqual(setsWon(m), [0, 2]);
assert.equal(addPoint(m, 0), m, 'después del final no suma');

// El saque cambia cada juego
m = newMatch();
assert.equal(m.server, 0);
m = play(m, game(0));
assert.equal(m.server, 1);

console.log('padel: ok');
