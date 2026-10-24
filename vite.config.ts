import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // Rutas relativas: funciona en https://usuario.github.io/dj-virtual/ o en cualquier carpeta.
  base: './',
  server: { port: 5173 },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        monitor: resolve(__dirname, 'midi-monitor.html'),
      },
    },
  },
  optimizeDeps: { exclude: ['essentia.js'] },
});
