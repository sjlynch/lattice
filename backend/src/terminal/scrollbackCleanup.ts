import fs from 'node:fs';
import path from 'node:path';
import { latticeHomeDir, terminalScrollbackDir } from '../projectPath.js';

// Wipe the scrollback directory. Called once at terminal-server boot: a
// restart loses every in-memory session (attach with a stale id returns
// session_lost), so any log left on disk is an orphan. Path-guarded to the
// dedicated home-scoped directory so it can never touch a project tree.
export function clearTerminalScrollback(): void {
  const dir = path.resolve(terminalScrollbackDir());
  const home = path.resolve(latticeHomeDir());
  if (
    path.basename(dir) !== 'terminal-scrollback' ||
    !(dir === path.join(home, 'terminal-scrollback'))
  ) {
    return;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}
