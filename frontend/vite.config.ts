import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5183,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:5184',
      '/ws': {
        target: 'ws://127.0.0.1:5184',
        ws: true,
        configure: (proxy) => {
          // http-proxy fires `error` whenever a side of the WebSocket
          // closes mid-write. ECONNABORTED / ECONNRESET / EPIPE are the
          // routine "client navigated away / refreshed" codes — surface
          // anything else, swallow the rest so the dev log stays useful.
          proxy.on('error', (err) => {
            const code = (err as NodeJS.ErrnoException).code;
            if (
              code === 'ECONNABORTED' ||
              code === 'ECONNRESET' ||
              code === 'EPIPE'
            ) {
              return;
            }
            console.error('[ws-proxy]', err);
          });
        },
      },
    },
  },
});
