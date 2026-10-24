// Control con la Numark DJ2GO2. Mismos números MIDI que usa el DJ virtual (src/midi/mapping.ts).
// En Windows la controladora la puede abrir una sola app a la vez: cerrá el DJ virtual o Serato antes.
import { emit } from './state.js';

const CONTROLLER_RE = /dj2go2|dj2go|numark/i;
let output = null;
export const midiStatus = { state: 'off', name: '' };

/** Qué hace cada control, para mostrarlo en pantalla. */
export const MIDI_HELP = [
  ['Pads deck A (1-4)', 'Escenas 1 a 4'],
  ['Pads deck B (1-4)', 'Escenas 5 a 8'],
  ['Play A', 'Corte (pasa la vista previa al aire)'],
  ['Play B', 'Fundido'],
  ['Crossfader', 'Transición manual'],
  ['Perilla Browse', 'Elegir escena para la vista previa (apretar = fundido)'],
  ['Cue A / Cue B', 'Punto para Equipo 1 / Equipo 2'],
  ['Sync A', 'Deshacer el último punto'],
  ['Sync B', 'Mostrar u ocultar el marcador'],
  ['Auriculares A / B', 'Mostrar zócalo / logo'],
  ['Fader A / Fader B', 'Volumen de los canales asignados a A / B'],
  ['Volumen master', 'Volumen master'],
  ['Load A (2 veces)', 'Empezar o cortar la grabación'],
  ['Load B (2 veces)', 'Salir al aire o terminar la transmisión'],
];

/**
 * @param {(action: string, value?: number) => void} onAction
 */
export async function initMidi(onAction) {
  if (!('requestMIDIAccess' in navigator)) {
    midiStatus.state = 'unsupported';
    emit('midi');
    return;
  }
  let access;
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
  } catch {
    midiStatus.state = 'denied';
    emit('midi');
    return;
  }
  const connect = async () => {
    midiStatus.state = 'none';
    output = null;
    for (const input of access.inputs.values()) {
      if (!CONTROLLER_RE.test(input.name ?? '')) continue;
      try {
        await input.open();
        input.onmidimessage = (e) => handle(e.data, onAction);
        midiStatus.state = 'ready';
        midiStatus.name = input.name;
      } catch {
        midiStatus.state = 'busy';
        midiStatus.name = input.name;
      }
    }
    for (const out of access.outputs.values()) {
      if (CONTROLLER_RE.test(out.name ?? '')) {
        try {
          await out.open();
          output = out;
        } catch {
          /* sin LEDs */
        }
      }
    }
    emit('midi');
  };
  access.onstatechange = (e) => {
    if (e.port.state === 'connected' && e.port.connection === 'open') return;
    connect();
  };
  await connect();
}

const lastPress = new Map();
/** Botones peligrosos (grabar, transmitir) piden dos toques en menos de 1,5 s. */
function doublePress(key) {
  const now = performance.now();
  const prev = lastPress.get(key) ?? 0;
  lastPress.set(key, now);
  if (now - prev < 1500) {
    lastPress.delete(key);
    return true;
  }
  return false;
}

function handle(data, act) {
  const status = data[0] & 0xf0;
  const ch = (data[0] & 0x0f) + 1;
  const num = data[1];
  const val = data[2];
  const noteOn = status === 0x90 && val > 0;

  if (status === 0xb0) {
    const v = val / 127;
    if (ch === 16 && num === 8) act('tbar', v);
    else if (ch === 16 && num === 10) act('fader', { which: 'M', v });
    else if ((ch === 1 || ch === 2) && num === 22) act('fader', { which: ch === 1 ? 'A' : 'B', v });
    else if (ch === 16 && num === 0) act('browse', val < 64 ? 1 : -1);
    return;
  }
  if (!noteOn) return;

  // Pads: en cualquier modo (hot cue, loop, sampler, efectos) el pad k manda la nota k, 16+k, 32+k o 48+k.
  if (ch === 5 || ch === 6) {
    const pad = (num - 1) % 16;
    if (pad >= 0 && pad < 4) act('scene', pad + (ch === 6 ? 4 : 0));
    return;
  }
  if (ch === 1 || ch === 2) {
    const A = ch === 1;
    if (num === 0) act(A ? 'cut' : 'fade');
    else if (num === 1) act('point', A ? 0 : 1);
    else if (num === 2) act(A ? 'undo' : 'toggleScore');
    else if (num === 27) act(A ? 'toggleLower' : 'toggleLogo');
    return;
  }
  if (ch === 16) {
    if (num === 6) act('fade');
    else if (num === 2 && doublePress('rec')) act('toggleRec');
    else if (num === 3 && doublePress('live')) act('toggleLive');
    else if (num === 2 || num === 3) act('hint', num === 2 ? 'Tocá Load A otra vez para grabar / cortar' : 'Tocá Load B otra vez para salir al aire / terminar');
  }
}

/** Prende el pad de la escena al aire y apaga el resto. */
export function setPadLeds(programIndex, previewIndex) {
  if (!output) return;
  for (let i = 0; i < 8; i++) {
    const ch = i < 4 ? 5 : 6;
    const v = i === programIndex ? 127 : i === previewIndex ? 1 : 0;
    output.send([0x90 + ch - 1, (i % 4) + 1, v]);
  }
}
