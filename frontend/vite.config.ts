import { defineConfig, createLogger } from 'vite';
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

// Vite's proxy middleware logs errors directly via `config.logger.error`
// before our `proxy.on('error', ...)` handler runs. Wrap the default
// logger so the boot-race / restart-window proxy noise doesn't reach the
// terminal — actionable errors still go through.
const baseLogger = createLogger();
const logger = {
  ...baseLogger,
  error(msg: string, options?: Parameters<typeof baseLogger.error>[1]) {
    if (
      typeof msg === 'string' &&
      /\[vite\]\s+(ws|http) proxy (?:socket )?error/i.test(msg)
    ) {
      return;
    }
    return baseLogger.error(msg, options);
  },
};

export default defineConfig({
  plugins: [react()],
  customLogger: logger,
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
