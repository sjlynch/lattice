// Root of Lattice's home-scoped state: `~/.lattice`, or `$LATTICE_HOME` when
// set. A second instance on other ports (an experiment runner, a soak) points
// LATTICE_HOME elsewhere instead of HOME, so its agents keep the user's real
// harness auth (`~/.claude`, `~/.codex`, `~/.pi`) while its tasks, worktrees,
// tokens and logs stay apart. Leaf module on node builtins only: projectPath,
// projectIdentity and the terminal-server's import graph all read it.

import os from 'node:os';
import path from 'node:path';

export function latticeHomeDir(): string {
  const override = process.env.LATTICE_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.lattice');
}
