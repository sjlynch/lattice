import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

// Disconnect / not-yet-listening codes that fire routinely during dev
// (page refreshes, backend restart cycles, the brief window between vite
// starting and backend listening). They're not actionable — swallow.
const TRANSIENT_PROXY_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
]);

function isTransient(err: unknown): boolean {
  return TRANSIENT_PROXY_CODES.has((err as NodeJS.ErrnoException)?.code ?? '');
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5183,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5184',
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            if (isTransient(err)) return;
            console.error('[api-proxy]', err);
          });
        },
      },
      '/ws': {
        target: 'ws://127.0.0.1:5184',
        ws: true,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            if (isTransient(err)) return;
            console.error('[ws-proxy]', err);
          });
        },
      },
    },
  },
});
