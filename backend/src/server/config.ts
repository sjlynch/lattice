import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalProjectPath } from '../projectPath.js';

export type BackendServerConfig = {
  port: number;
  defaultRoot: string;
  backendOrigin: string;
};

export function getBackendServerConfig(): BackendServerConfig {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const port = Number(process.env.PORT) || 5184;
  const defaultRoot = canonicalProjectPath(path.resolve(moduleDir, '..', '..', '..'));
  const backendOrigin = `http://127.0.0.1:${port}`;
  return { port, defaultRoot, backendOrigin };
}
