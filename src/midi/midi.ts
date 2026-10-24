// Acceso a Web MIDI (Chrome / Edge). En Windows los puertos MIDI son exclusivos:
// si Serato DJ Lite está abierto, el DJ2GO2 aparece pero no se puede abrir.

export interface MidiMessage {
  type: 'noteon' | 'noteoff' | 'cc' | 'other';
  channel: number; // 1..16
  number: number;
  value: number;
  data: Uint8Array;
  port: string;
  time: number;
}

export function decodeMidi(data: Uint8Array, port: string, time: number): MidiMessage {
  const status = data[0] ?? 0;
  const hi = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  const number = data[1] ?? 0;
  const value = data[2] ?? 0;
  let type: MidiMessage['type'] = 'other';
  if (hi === 0x90) type = value === 0 ? 'noteoff' : 'noteon';
  else if (hi === 0x80) type = 'noteoff';
  else if (hi === 0xb0) type = 'cc';
  return { type, channel, number, value, data, port, time };
}

/** CC relativo de 7 bits en complemento a dos (1 = +1, 127 = -1). */
export function relativeDelta(value: number): number {
  return value < 64 ? value : value - 128;
}

export type MidiStatus =
  | { state: 'unsupported' }
  | { state: 'denied'; error: string }
  | { state: 'ready'; inputs: PortInfo[]; outputs: PortInfo[]; controllerFound: boolean; errors: string[] };

export interface PortInfo {
  id: string;
  name: string;
  manufacturer: string;
  state: string;
  connection: string;
}

const CONTROLLER_RE = /dj2go2|dj2go|numark/i;

export class MidiManager {
  access: MIDIAccess | null = null;
  output: MIDIOutput | null = null;
  status: MidiStatus = { state: 'unsupported' };
  private listeners = new Set<(m: MidiMessage) => void>();
  private statusListeners = new Set<(s: MidiStatus) => void>();
  private errors: string[] = [];

  async init(): Promise<MidiStatus> {
    if (!('requestMIDIAccess' in navigator)) {
      this.setStatus({ state: 'unsupported' });
      return this.status;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      this.setStatus({ state: 'denied', error: String(e) });
      return this.status;
    }
    this.access.onstatechange = () => void this.connectAll();
    await this.connectAll();
    return this.status;
  }

  onMessage(cb: (m: MidiMessage) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onStatus(cb: (s: MidiStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  send(bytes: number[]): void {
    try {
      this.output?.send(bytes);
    } catch {
      /* el puerto pudo haberse desconectado */
    }
  }

  /** LED: misma nota de vuelta, velocity 127 encendido / 0 apagado. */
  led(channel: number, note: number, on: boolean): void {
    this.send([0x90 + channel - 1, note, on ? 0x7f : 0x00]);
  }

  private async connectAll(): Promise<void> {
    if (!this.access) return;
    this.errors = [];
    for (const input of this.access.inputs.values()) {
      if (input.state !== 'connected') continue;
      if (input.connection !== 'open') {
        try {
          await input.open();
        } catch (e) {
          this.errors.push(`No pude abrir la entrada "${input.name}" (${String(e)}). ¿Está abierto Serato DJ Lite u otro programa DJ?`);
        }
      }
      input.onmidimessage = (ev: MIDIMessageEvent) => {
        if (!ev.data) return;
        const msg = decodeMidi(ev.data, input.name ?? '?', ev.timeStamp);
        for (const l of this.listeners) l(msg);
      };
    }
    const outputs = [...this.access.outputs.values()].filter((o) => o.state === 'connected');
    const preferred = outputs.find((o) => CONTROLLER_RE.test(o.name ?? '')) ?? null;
    if (preferred && preferred !== this.output) {
      try {
        await preferred.open();
        this.output = preferred;
      } catch (e) {
        this.errors.push(`No pude abrir la salida "${preferred.name}" para los LEDs (${String(e)}).`);
        this.output = null;
      }
    } else if (!preferred) {
      this.output = null;
    }
    const info = (p: MIDIPort): PortInfo => ({
      id: p.id,
      name: p.name ?? '?',
      manufacturer: p.manufacturer ?? '',
      state: p.state,
      connection: p.connection,
    });
    const inputs = [...this.access.inputs.values()].map(info);
    this.setStatus({
      state: 'ready',
      inputs,
      outputs: [...this.access.outputs.values()].map(info),
      controllerFound: inputs.some((i) => CONTROLLER_RE.test(i.name) && i.state === 'connected'),
      errors: [...this.errors],
    });
  }

  private setStatus(s: MidiStatus): void {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }
}
