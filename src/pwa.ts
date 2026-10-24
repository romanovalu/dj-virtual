// App instalable: registra el service worker (sólo en producción) y maneja el botón "Instalar".

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function registerPwa(installButton?: HTMLElement | null): void {
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {
        /* sin service worker la app igual funciona online */
      });
    });
  }
  if (!installButton) return;
  let deferred: InstallPrompt | null = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    installButton.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    installButton.hidden = true;
    deferred = null;
  });
  installButton.addEventListener('click', async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    installButton.hidden = true;
  });
}
