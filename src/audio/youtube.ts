// Reproductor de YouTube con la IFrame Player API oficial ("modo básico" del deck).
// Sin acceso al audio: volumen con setVolume, tempo en pasos fijos, sin EQ ni BPM.

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<void> | null = null;

export function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  apiPromise ??= new Promise<void>((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => reject(new Error('No se pudo cargar la API de YouTube (¿sin conexión?)'));
    document.head.appendChild(s);
  });
  return apiPromise;
}

export class YouTubeDeck {
  player: YT.Player | null = null;
  ready = false;
  videoId = '';
  title = '';
  error = '';
  private host: HTMLElement;
  onState: () => void = () => {};

  constructor(host: HTMLElement) {
    this.host = host;
  }

  async load(videoId: string): Promise<void> {
    await loadYouTubeApi();
    this.videoId = videoId;
    this.error = '';
    if (this.player && this.ready) {
      this.player.cueVideoById(videoId);
      return;
    }
    this.host.innerHTML = '';
    const el = document.createElement('div');
    this.host.appendChild(el);
    await new Promise<void>((resolve) => {
      this.player = new YT.Player(el, {
        width: 280,
        height: 200,
        videoId,
        playerVars: { playsinline: 1, controls: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => {
            this.ready = true;
            resolve();
            this.onState();
          },
          onStateChange: () => {
            const data = this.player?.getVideoData?.() as { title?: string } | undefined;
            if (data?.title) this.title = data.title;
            this.onState();
          },
          onError: (e) => {
            const codes: Record<number, string> = {
              2: 'ID de video inválido',
              5: 'error del reproductor HTML5',
              100: 'video no encontrado o privado',
              101: 'el dueño no permite reproducirlo embebido',
              150: 'el dueño no permite reproducirlo embebido',
            };
            this.error = `YouTube: ${codes[e.data] ?? `error ${e.data}`}`;
            this.onState();
            resolve();
          },
        },
      });
    });
  }

  get ended(): boolean {
    return this.player?.getPlayerState?.() === YT.PlayerState.ENDED;
  }

  get playing(): boolean {
    return this.player?.getPlayerState?.() === YT.PlayerState.PLAYING;
  }

  play(): void {
    this.player?.playVideo();
  }

  pause(): void {
    this.player?.pauseVideo();
  }

  seek(sec: number): void {
    this.player?.seekTo(Math.max(0, sec), true);
  }

  get position(): number {
    return this.player?.getCurrentTime?.() ?? 0;
  }

  get duration(): number {
    return this.player?.getDuration?.() ?? 0;
  }

  setVolume(v01: number): void {
    this.player?.setVolume(Math.round(Math.max(0, Math.min(1, v01)) * 100));
  }

  /** Elige el paso de velocidad disponible más cercano al tempo pedido. */
  setTempo(t: number): number {
    if (!this.player?.getAvailablePlaybackRates) return 1;
    const rates = this.player.getAvailablePlaybackRates();
    let best = 1;
    for (const r of rates) if (Math.abs(r - t) < Math.abs(best - t)) best = r;
    if (this.player.getPlaybackRate() !== best) this.player.setPlaybackRate(best);
    return best;
  }

  destroy(): void {
    this.player?.destroy();
    this.player = null;
    this.ready = false;
    this.host.innerHTML = '';
  }
}
