import type { DeadCodeStatus } from '../types.js';
import { extLower } from './importGraph.js';
import { RESOLVABLE_IMPORT_EXTS } from './roots.js';

export type DeadCodeStats = {
  // Resolvable-language (TS/JS/Py) files that aren't roots — the population
  // that *can* be confidently classified dead.
  resolvable: number;
  // How many of those were classified `dead` (before the confidence guard).
  dead: number;
  // True when the guard tripped: an implausibly high dead fraction (the
  // fingerprint of a module-resolution gap) downgraded every `dead` to
  // `uncertain` so a resolver blind spot can't paint a whole project red.
  downgraded: boolean;
};

// If more than this fraction of resolvable non-root files come back dead, we
// assume the import resolver is failing for this project's style rather than
// that the project is genuinely mostly-dead, and downgrade to `uncertain`.
// A resolver bug typically yields >95% dead; a genuinely dead-heavy real
// project rarely exceeds ~50%, so 0.7 separates the two with margin.
const MAX_PLAUSIBLE_DEAD_FRACTION = 0.7;
const MIN_FILES_FOR_DEAD_GUARD = 20;

export function classifyDeadCode(
  presentFiles: Set<string>,
  roots: Set<string>,
  reachable: Set<string>,
): { deadCode: Map<string, DeadCodeStatus>; deadCodeStats: DeadCodeStats } {
  const out = new Map<string, DeadCodeStatus>();
  let resolvable = 0;
  let dead = 0;
  for (const f of presentFiles) {
    if (roots.has(f)) {
      out.set(f, 'entry');
    } else if (reachable.has(f)) {
      out.set(f, 'live');
    } else if (RESOLVABLE_IMPORT_EXTS.has(extLower(f))) {
      out.set(f, 'dead');
      resolvable++;
      dead++;
    } else {
      out.set(f, 'uncertain');
    }
  }
  // The reachable resolvable files count toward the population too, so the
  // fraction reflects "of the code we can analyze, how much looks dead".
  for (const f of reachable) {
    if (!roots.has(f) && RESOLVABLE_IMPORT_EXTS.has(extLower(f))) resolvable++;
  }

  let downgraded = false;
  if (
    resolvable >= MIN_FILES_FOR_DEAD_GUARD &&
    dead / resolvable > MAX_PLAUSIBLE_DEAD_FRACTION
  ) {
    // Almost certainly a resolution gap, not a genuinely dead codebase.
    // Demote red → grey so we never confidently mislabel a whole project.
    for (const [f, status] of out) {
      if (status === 'dead') out.set(f, 'uncertain');
    }
    downgraded = true;
  }

  return { deadCode: out, deadCodeStats: { resolvable, dead, downgraded } };
}
