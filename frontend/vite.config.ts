import type { ServerResponse } from 'node:http';
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

// Vite's default proxy `error` behavior turns any upstream hiccup into a
// 500 back to the browser — confusing because it suggests a backend
// error when really the connection just got reset (a refresh, a tsc-w
// backend respawn, …). Replace the response with a structured 502 so
// the toast surface in the UI can distinguish "proxy couldn't reach
// backend" from "backend handled the request and returned 500."
function endWithProxyError(
  res: ServerResponse | undefined,
  err: NodeJS.ErrnoException,
  label: string,
): void {
  if (!res || res.writableEnded || res.headersSent) return;
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: `${label}: ${err.code ?? 'proxy error'} (${err.message ?? 'no message'})`,
    }),
  );
}

// Vite's proxy middleware also logs errors directly via
// `config.logger.error`. Filter the boot-race / restart-window noise but
// keep anything our own handlers re-emit (we tag those `[api-proxy]` /
// `[ws-proxy]` and surface code + url for triage).
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
          proxy.on('error', (err, _req, res) => {
            if (!isTransient(err)) console.error('[api-proxy]', err);
            // Always replace vite's default-500 with a structured 502 so
            // the UI can tell "proxy couldn't reach backend" apart from
            // "backend handled the request and returned 500."
            endWithProxyError(res as ServerResponse | undefined, err, '[api-proxy]');
          });
        },
      },
      '/ws': {
        target: 'ws://127.0.0.1:5184',
        ws: true,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            if (!isTransient(err)) console.error('[ws-proxy]', err);
          });
        },
      },
    },
  },
});
