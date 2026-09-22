// Shim installation: drop the re-export shim into a session cwd's
// `.pi/extensions/` so Pi loads the shared `@tintinweb/pi-subagents` install
// there (and nowhere else).
//
// Net scope: the extension is active in exactly the cwds Lattice drops the shim
// into — every Lattice-spawned Pi session (worktree task, workflow step,
// post-merge hook, prompt customization) PLUS the project root (so a `pi` the
// user launches in the Lattice terminal panel, cwd = project root, gets it too).
// `-e` would only reach command lines Lattice itself builds; a discovery shim is
// what reaches a manually-typed `pi`.

import path from 'node:path';
import fs from 'node:fs/promises';
import { atomicWriteFile } from '../claudeTrust/configFile.js';
import { getPiSubagentsEntry } from './ensure.js';
import { PI_SUBAGENTS_SHIM_FILENAME, renderPiSubagentsShim } from './render.js';

// Drop the re-export shim into `<dir>/.pi/extensions/lattice-subagents.ts`.
// No-op (graceful) until the shared install has resolved — a shim pointing at a
// missing entry would make Pi error at startup ("Failed to load extension"), so
// we only write it once the target exists. Idempotent: skips the write when the
// on-disk contents already match, so a worktree reconcile doesn't dirty
// `git status`.
export async function installPiSubagentsShim(args: {
  dir: string;
}): Promise<void> {
  const entry = getPiSubagentsEntry();
  if (!entry) return;
  const extDir = path.join(args.dir, '.pi', 'extensions');
  const shimFile = path.join(extDir, PI_SUBAGENTS_SHIM_FILENAME);
  const expected = renderPiSubagentsShim(entry);
  try {
    const existing = await fs.readFile(shimFile, 'utf8');
    if (existing === expected) return;
  } catch {
    /* absent — fall through to write */
  }
  await fs.mkdir(extDir, { recursive: true });
  // Temp + rename: concurrent Pi spawns share the project-root shim, and a
  // truncate-then-write lets a starting Pi load an empty/torn file.
  await atomicWriteFile(shimFile, expected);
  console.log(`[pi-subagents] installed subagents shim at ${shimFile}`);
}
