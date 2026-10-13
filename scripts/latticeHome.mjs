// Root of Lattice's home-scoped state for the dev-runner scripts: `~/.lattice`,
// or `$LATTICE_HOME` when set. Mirrors backend/src/latticeHome.ts (the scripts
// must not load compiled `dist/` modules).
import os from 'node:os';
import path from 'node:path';

export function latticeHomeDir() {
  const override = process.env.LATTICE_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.lattice');
}
