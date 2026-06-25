// Install directory + package-entry resolution for the shared Lattice-owned
// `@tintinweb/pi-subagents` install.
//
// Why a *shared, project-local* install (`pi install <src> -l` with cwd =
// `~/.lattice/pi-extensions/`) and not a plain `pi install`:
//
//   - `pi install npm:@tintinweb/pi-subagents` (no `-l`) writes the GLOBAL
//     `~/.pi/agent/settings.json` `packages` array → the extension then loads
//     in EVERY pi session on the machine. That global pollution is exactly what
//     we must avoid.
//   - `pi install <src> -l` instead writes a project-local `<cwd>/.pi/settings.json`
//     and installs the package (plus deps) under `<cwd>/.pi/npm/node_modules/`.
//     We run it ONCE with cwd = `~/.lattice/pi-extensions/`, so there is a single
//     shared copy on the machine and the user's global config stays `packages: []`.

import path from 'node:path';
import fs from 'node:fs/promises';
import { latticeHomeDir } from '../projectPath.js';

export const PI_SUBAGENTS_SPEC = 'npm:@tintinweb/pi-subagents';

// The shared, Lattice-owned install root. Home-scoped and OUTSIDE any project
// tree on purpose (same rule as worktrees / scratch). `pi install -l` here
// writes `<dir>/.pi/settings.json` + `<dir>/.pi/npm/node_modules/...`.
export function installDir(): string {
  return path.join(latticeHomeDir(), 'pi-extensions');
}

export function packageDir(): string {
  return path.join(
    installDir(),
    '.pi',
    'npm',
    'node_modules',
    '@tintinweb',
    'pi-subagents',
  );
}

// Pick the entry file the package declares (`pi.extensions[0]`, currently
// `./src/index.ts`), falling back to the compiled `dist/index.js` then `src`.
// All three are verified to load via the shim; we prefer the author-declared
// one so a future package restructure keeps working. Returns a forward-slashed
// absolute path (works in Node's `require` on every platform and sidesteps
// backslash-escaping in the generated shim source), or null until the shared
// install has been resolved.
export async function resolveEntry(pkgDir: string): Promise<string | null> {
  let declared: string | null = null;
  try {
    const pj = JSON.parse(
      await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8'),
    ) as { pi?: { extensions?: unknown } };
    const list = pj?.pi?.extensions;
    if (Array.isArray(list) && typeof list[0] === 'string') declared = list[0];
  } catch {
    return null; // package not present / unreadable → not installed yet
  }
  const candidates = [declared, 'dist/index.js', 'src/index.ts'].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );
  for (const rel of candidates) {
    const abs = path.resolve(pkgDir, rel);
    try {
      await fs.access(abs);
      return abs.replace(/\\/g, '/');
    } catch {
      /* try next */
    }
  }
  return null;
}
