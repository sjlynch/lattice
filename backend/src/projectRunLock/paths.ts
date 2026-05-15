import path from 'node:path';
import { homeProjectDir } from '../projectPath.js';

export function projectRunLockFilePath(projectPath: string): string {
  return path.join(homeProjectDir(projectPath), 'run.lock');
}
