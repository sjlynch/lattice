// Pure helpers for the timeline scrubber. Given the loaded git history
// and a [leftIdx, rightIdx] tick range (rightmost tick = working tree),
// derive the per-file "change kind" map that drives the rings, plus a
// stable list of ghost nodes for the files the backend reports as deleted
// (`GitHistoryResult.deletedPaths`).
//
// All matching is done in forward-slash relative-to-root path space so
// it works the same on Windows and POSIX.

import type {
  GitCommit,
  GitFileStatus,
  GitUncommitted,
  GraphLink,
  GraphNode,
  ScanResult,
} from '../../api';
import type { ChangeKind } from './changeRing';

export const GHOST_PREFIX = '__ghost__:';

export function relForward(absPath: string, root: string): string {
  if (!root) return absPath.split('\\').join('/');
  if (absPath.startsWith(root)) {
    let rest = absPath.slice(root.length);
    if (rest.startsWith('/') || rest.startsWith('\\')) rest = rest.slice(1);
    return rest.split('\\').join('/');
  }
  return absPath.split('\\').join('/');
}

// `buildForceGraphData` (useGraphDataSync) stashes each file node's forward-
// relative path under this key when it mints fresh sim-node clones on a
// structural swap. `node.path` and the scan root are invariant for the life of
// a scan, so this lets `buildNodeObject` read the precomputed value instead of
// recomputing `relForward` (2 string allocs + an array) for every node on every
// `graph.refresh()` (each H/Z/D overlay toggle / metric refresh). A new scan
// produces new clones, naturally recomputing it.
export const REL_FORWARD_KEY = '__latticeRelForward';

export function readRelForward(node: GraphNode, root: string): string {
  const cached = (node as Record<string, unknown>)[REL_FORWARD_KEY];
  return typeof cached === 'string' ? cached : relForward(node.path, root);
}

// rightIdx is in tick space: 0..commits.length, where commits.length is
// the working-tree slot.
export function computeChangeMap(
  commits: GitCommit[],
  uncommitted: GitUncommitted,
  leftIdx: number,
  rightIdx: number,
): Map<string, ChangeKind> {
  const out = new Map<string, ChangeKind>();
  const wtIdx = commits.length;
  const lo = Math.max(0, Math.min(wtIdx, leftIdx));
  const hi = Math.max(0, Math.min(wtIdx, rightIdx));
  if (hi < lo) return out;

  const first = new Map<string, GitFileStatus>();
  const last = new Map<string, GitFileStatus>();

  function consume(changes: { path: string; status: GitFileStatus }[]) {
    for (const ch of changes) {
      if (!first.has(ch.path)) first.set(ch.path, ch.status);
      last.set(ch.path, ch.status);
    }
  }

  for (let i = lo; i < Math.min(hi + 1, commits.length); i++) {
    consume(commits[i].changes);
  }
  if (hi === wtIdx && uncommitted) consume(uncommitted.changes);

  for (const [p, l] of last) {
    const f = first.get(p)!;
    if (l === 'D') out.set(p, 'deleted');
    else if (f === 'A') out.set(p, 'added');
    else out.set(p, 'modified');
  }
  return out;
}

// Build ghost nodes for the files git says were deleted. `deletedPaths` comes
// from the backend (`gitHistory/deletedPaths.ts`), which derives it from
// `git ls-files` — the tree's actual contents. We do this once per (scan,
// history) pair so that scrubbing doesn't allocate or perturb the physics —
// visibility is later toggled via nodeVisibility.
//
// This used to ghost every history path missing from the current scan, which
// was wrong: the scan collects only `SOURCE_EXTS` files while
// `git log --name-status` is unfiltered, so every tracked image, font, `.ico`,
// and extension-less name (`.gitignore` — `path.extname` returns '' for a
// leading-dot basename) got minted as a ghost. `decideSpriteState`
// short-circuits ghosts to the deleted rendering (grey disc + red ring)
// regardless of change kind, so scrubbing to the commit that ADDED those assets
// drew every one of them as a deletion.
//
// The scan check stays as a cheap consistency guard — scan and history are
// fetched independently, so a file can briefly be in both.
export function buildGhostGraphData(
  scan: ScanResult,
  deletedPaths: string[],
): { ghostNodes: (GraphNode & { __ghost: true })[]; ghostLinks: GraphLink[] } {
  const existingFileRel = new Set<string>();
  const existingDirRel = new Map<string, string>(); // rel -> id
  for (const n of scan.nodes) {
    const rel = relForward(n.path, scan.root);
    if (n.kind === 'dir') existingDirRel.set(rel, n.id);
    else existingFileRel.add(rel);
  }
  const seen = new Set<string>();
  for (const rel of deletedPaths) {
    if (existingFileRel.has(rel)) continue;
    seen.add(rel);
  }

  const ghostNodes: (GraphNode & { __ghost: true })[] = [];
  const ghostLinks: GraphLink[] = [];
  for (const rel of seen) {
    const id = `${GHOST_PREFIX}${rel}`;
    const name = rel.split('/').pop() || rel;
    const dotIdx = name.lastIndexOf('.');
    const ext = dotIdx >= 0 ? name.slice(dotIdx).toLowerCase() : '';
    ghostNodes.push({
      id,
      name,
      path: rel,
      kind: 'file',
      ext,
      __ghost: true,
    });
    // Walk up directory components looking for the nearest dir that
    // already exists in the scan. Falls back to root.
    let parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    let parentId: string | null = null;
    while (parent) {
      const found = existingDirRel.get(parent);
      if (found) {
        parentId = found;
        break;
      }
      parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : '';
    }
    if (!parentId) parentId = scan.root;
    ghostLinks.push({ source: parentId, target: id });
  }
  return { ghostNodes, ghostLinks };
}

export function isGhost(node: GraphNode): boolean {
  return typeof node.id === 'string' && node.id.startsWith(GHOST_PREFIX);
}
