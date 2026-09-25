// Where a project's generated API docs live — and nothing else. Split out of
// `../latticeApiDocs.ts` so the detached terminal-server can name the doc in
// its human-facing banner WITHOUT carrying the generator and its two templates
// in its import graph: those change with every new route (the docs drift test
// holds them to the live router), and every byte in the terminal-server's graph
// is fingerprinted — each API tweak used to mark the live terminal-server stale
// ("update pending until all terminals close"). Generation now happens only in
// the main backend, before it creates a session (see
// `terminalServerClient/createSession.ts` and `terminalWsRelay.ts`).

import fs from 'node:fs';
import path from 'node:path';

export const LATTICE_DIR = '.lattice';
export const LATTICE_API_DOC_FILENAME = 'LATTICE_API.md';
export const LATTICE_API_RECIPES_DOC_FILENAME = 'LATTICE_API_RECIPES.md';

// The project's `.lattice/LATTICE_API.md` when it exists, else null (a project
// without a `.lattice/` dir never gets one). Read-only.
export function existingLatticeApiDocPath(projectPath: string): string | null {
  if (!projectPath) return null;
  const doc = path.join(projectPath, LATTICE_DIR, LATTICE_API_DOC_FILENAME);
  try {
    return fs.existsSync(doc) ? doc : null;
  } catch {
    return null;
  }
}
