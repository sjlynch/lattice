import fs from 'node:fs/promises';
import path from 'node:path';
import { renderStopHookJson } from '../stopHook.js';

// Validate (and repair if needed) the worktree's Stop-hook config.
//
// The resolver Claude reads .claude/settings.local.json at startup. If
// merge conflict markers landed inside the JSON, Claude's parser fails
// with a "Settings Error" prompt before the user prompt is processed —
// the resolver can't even read the merge instructions. Layer 2 auto-
// resolve should mean this is always clean by the time we get here, but
// a stale state from before this code shipped (or a hand-edit) could
// still leave the file broken. Repair from Lattice's known-good template
// — the worktree's task ID is the correct Stop-hook target either way.
export async function ensureValidStopHook(
  worktreePath: string,
  taskId: string,
  backendOrigin: string,
): Promise<void> {
  const file = path.join(worktreePath, '.claude', 'settings.local.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[instructions] could not read ${file}:`, err);
      return;
    }
    // File missing — the resolver Claude will just have no Stop hook
    // (the resolver's `/merged` and `/merge-aborted` callbacks still
    // work). Recreate from the template so the auto-callback works.
    raw = '';
  }
  let valid = false;
  if (raw) {
    try {
      JSON.parse(raw);
      valid = true;
    } catch {
      valid = false;
    }
  }
  if (valid) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, renderStopHookJson(taskId, backendOrigin), 'utf8');
  console.warn(
    `[instructions] repaired malformed ${file} for task ${taskId} ` +
      `(would have broken Claude bootstrap)`,
  );
}
