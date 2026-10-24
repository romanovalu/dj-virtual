// Biblioteca persistente: guarda en IndexedDB los "accesos" (FileSystemHandle) a tus archivos y
// carpetas, más los links de YouTube. No copia la música. Al volver, Chrome/Edge pide un click
// para reconectar el permiso de lectura. Las carpetas se vuelven a leer: lo nuevo aparece solo.

export type Entry =
  | { key: string; kind: 'file'; name: string; handle: FileSystemFileHandle; addedAt: number }
  | { key: string; kind: 'dir'; name: string; handle: FileSystemDirectoryHandle; addedAt: number }
  | { key: string; kind: 'yt'; name: string; videoId: string; addedAt: number };

type PermHandle = FileSystemHandle & {
  queryPermission?(o: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'read' }): Promise<PermissionState>;
};

const DB = 'djv-library';
const STORE = 'entries';
const HIDDEN_KEY = 'djv.library.hidden';

export const fsSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window && 'showOpenFilePicker' in window;

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'key' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req ? (req.result as T) : undefined);
    t.onerror = () => rej(t.error);
  });
}

export async function listEntries(): Promise<Entry[]> {
  try {
    const all = ((await tx<Entry[]>('readonly', (s) => s.getAll() as IDBRequest<Entry[]>)) ?? []) as Entry[];
    return all.sort((a, b) => a.addedAt - b.addedAt);
  } catch {
    return [];
  }
}

export async function putEntry(e: Entry): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put(e));
  } catch {
    /* sin IndexedDB: la biblioteca no se recuerda */
  }
}

export async function removeEntry(key: string): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(key));
  } catch {
    /* ignorar */
  }
}

/** Clave estable de un archivo para no duplicarlo. */
export function fileKey(f: File): string {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

/** ¿Hay permiso de lectura? Con `ask` lo pide (necesita un click del usuario). */
export async function hasPermission(h: FileSystemHandle, ask: boolean): Promise<boolean> {
  const p = h as PermHandle;
  if (!p.queryPermission) return true;
  if ((await p.queryPermission({ mode: 'read' })) === 'granted') return true;
  if (!ask || !p.requestPermission) return false;
  return (await p.requestPermission({ mode: 'read' })) === 'granted';
}

const AUDIO_RE = /\.(mp3|wav|flac|ogg|m4a|aac|aiff?|opus)$/i;

/** Lista los audios de una carpeta (y subcarpetas, hasta 4 niveles). */
export async function filesInDir(dir: FileSystemDirectoryHandle, depth = 4): Promise<{ file: File; handle: FileSystemFileHandle }[]> {
  const out: { file: File; handle: FileSystemFileHandle }[] = [];
  const walk = async (d: FileSystemDirectoryHandle, level: number) => {
    for await (const h of (d as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
      if (h.kind === 'file' && AUDIO_RE.test(h.name)) {
        try {
          const fh = h as FileSystemFileHandle;
          out.push({ file: await fh.getFile(), handle: fh });
        } catch {
          /* archivo ilegible: lo salteamos */
        }
      } else if (h.kind === 'directory' && level < depth) {
        await walk(h as FileSystemDirectoryHandle, level + 1);
      }
    }
  };
  await walk(dir, 0);
  return out.sort((a, b) => a.file.name.localeCompare(b.file.name));
}

export async function pickFiles(): Promise<FileSystemFileHandle[]> {
  const w = window as unknown as { showOpenFilePicker(o: unknown): Promise<FileSystemFileHandle[]> };
  return w.showOpenFilePicker({
    multiple: true,
    types: [{ description: 'Audio', accept: { 'audio/*': ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.aiff', '.opus'] } }],
  });
}

export async function pickFolder(): Promise<FileSystemDirectoryHandle> {
  const w = window as unknown as { showDirectoryPicker(o: unknown): Promise<FileSystemDirectoryHandle> };
  return w.showDirectoryPicker({ mode: 'read', id: 'djv-musica' });
}

/** Archivos que sacaste de la biblioteca aunque estén en una carpeta guardada. */
export function hiddenKeys(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function hideKey(k: string): void {
  const s = hiddenKeys();
  s.add(k);
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...s]));
  } catch {
    /* ignorar */
  }
}

export function unhideKey(k: string): void {
  const s = hiddenKeys();
  if (!s.delete(k)) return;
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...s]));
  } catch {
    /* ignorar */
  }
}
