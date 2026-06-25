import type { ForceGraph3DInstance } from '3d-force-graph';
import type { MutableRefObject } from 'react';
import { applyChangeRingDelta } from './changeRingSync';
import type { ChangeKind } from './changeRing';
import type { GraphSettings } from './graphSettings';

// Called on every active-folder change (project switch, including → empty).
// Drops the previous project's change-ring state so the new project's graph can
// never transiently show A's rings/ghosts during the async window before B's
// git history resolves:
//   - empties `changeMapRef` — it's read live by `buildNodeObject` whenever the
//     graph rebuilds, so a stale A map would paint A's rings on B's shared paths
//     (package.json, tsconfig.json, src/index.ts) the moment B's scan swaps in;
//   - strips any change rings already mounted and hides A's deleted-file ghost
//     discs in place (the incoming project's git fetch hasn't landed yet to do
//     this via the reconcile delta).
// Returns whether a mounted ring/ghost was actually touched, so the caller can
// wake a refresh frame (the render loop is otherwise paused once settled).
export function resetChangeRingsForProjectSwitch(
  graph: ForceGraph3DInstance | null,
  changeMapRef: MutableRefObject<Map<string, ChangeKind>>,
  settings: GraphSettings,
  scanRoot: string,
): boolean {
  const prev = changeMapRef.current;
  const next = new Map<string, ChangeKind>();
  changeMapRef.current = next;
  if (!graph || prev.size === 0) return false;
  return applyChangeRingDelta(graph, prev, next, settings, scanRoot);
}
