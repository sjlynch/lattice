import type http from 'node:http';
import { detectHarnesses } from '../harnessDetect.js';
import { recoverOrphanedTasks, resumeInterruptedMergeRuns } from '../recovery.js';
import { ensureTerminalServer } from '../terminalProxy.js';
import { createBackendApp } from './app.js';
import {
  getBackendServerConfig,
  type BackendServerConfig,
} from './config.js';
import { createHttpServerWithWebSockets } from './http.js';

export async function startBackend(
  config: BackendServerConfig = getBackendServerConfig(),
): Promise<http.Server> {
  const server = createBackendHttpServer(config);
  startHarnessDetection();
  await runPreListenStartupRecovery();
  await listenForRequests(server, config);
  resumeMergeRunsAfterListen(config.backendOrigin);
  return server;
}

export function createBackendHttpServer(
  config: BackendServerConfig,
): http.Server {
  const app = createBackendApp({
    defaultRoot: config.defaultRoot,
    backendOrigin: config.backendOrigin,
  });
  return createHttpServerWithWebSockets(app);
}

export function startHarnessDetection(): void {
  // Kick off harness CLI detection now so its result is ready when the
  // frontend's /ws/harnesses connection lands. Probe failures are
  // swallowed inside the module's cache.
  detectHarnesses().catch(() => {});
}

export async function runPreListenStartupRecovery(): Promise<void> {
  await ensureTerminalServer();
  await recoverOrphanedTasks();
}

export function listenForRequests(
  server: http.Server,
  config: Pick<BackendServerConfig, 'port' | 'defaultRoot'>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      console.log(`[lattice-backend] listening on http://localhost:${config.port}`);
      console.log(`[lattice-backend] default root: ${config.defaultRoot}`);
      resolve();
    };
    server.once('error', onError);
    server.listen(config.port, onListening);
  });
}

export function resumeMergeRunsAfterListen(backendOrigin: string): void {
  // Now that the API is up, resume any merge run a previous process was
  // running when it got restarted (resolver Claudes it may spawn need
  // the API listening to call back).
  resumeInterruptedMergeRuns(backendOrigin).catch((err) =>
    console.error('[startup] resumeInterruptedMergeRuns failed:', err),
  );
}
