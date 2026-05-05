// Pure helpers for the timeline scrubber. Given the loaded git history
// and a [leftIdx, rightIdx] tick range (rightmost tick = working tree),
// derive the per-file "change kind" map that drives the rings, plus a
// stable list of ghost nodes for files that no longer exist in the
// current scan but appeared in the loaded history.
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

// Build ghost nodes for paths that appear anywhere in the loaded
// history but aren't in the current scan. We do this once per (scan,
// history) pair so that scrubbing doesn't allocate or perturb the
// physics — visibility is later toggled via nodeVisibility.
export function buildGhostGraphData(
  scan: ScanResult,
  commits: GitCommit[],
  uncommitted: GitUncommitted,
): { ghostNodes: (GraphNode & { __ghost: true })[]; ghostLinks: GraphLink[] } {
  const existingFileRel = new Set<string>();
  const existingDirRel = new Map<string, string>(); // rel -> id
  for (const n of scan.nodes) {
    const rel = relForward(n.path, scan.root);
    if (n.kind === 'dir') existingDirRel.set(rel, n.id);
    else existingFileRel.add(rel);
  }
  const seen = new Set<string>();
  function add(rel: string) {
    if (existingFileRel.has(rel)) return;
    seen.add(rel);
  }
  for (const c of commits) for (const ch of c.changes) add(ch.path);
  for (const ch of uncommitted.changes) add(ch.path);

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
