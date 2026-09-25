import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalProjectPath } from '../projectPath.js';

export type BackendServerConfig = {
  port: number;
  defaultRoot: string;
  backendOrigin: string;
};

/** The port this backend binds: `PORT`, else 5184. */
export function backendPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.PORT) || 5184;
}

export function getBackendServerConfig(): BackendServerConfig {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const port = backendPort();
  // `LATTICE_DEFAULT_ROOT` points an isolated instance (the Playwright e2e
  // webServer) at a scratch project, so the UI's first-open instrumentation
  // never writes hooks for that instance into this repo's own
  // `.claude/settings.local.json`. Default: the Lattice checkout itself.
  const defaultRoot = canonicalProjectPath(
    process.env.LATTICE_DEFAULT_ROOT
      ? path.resolve(process.env.LATTICE_DEFAULT_ROOT)
      : path.resolve(moduleDir, '..', '..', '..'),
  );
  const backendOrigin = `http://127.0.0.1:${port}`;
  return { port, defaultRoot, backendOrigin };
}
