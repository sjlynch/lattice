import type { WorkflowStep } from '../../api';
import type { SourceTree, SourceArea } from '../../../../backend/src/shared/sourceAreas';
import { areaPathMatches, sourceAreaLabel } from '../../../../backend/src/shared/sourceAreas';
export type CustomArea = { label: string; paths: string[] };
export function toggleStepSplit(step: WorkflowStep): WorkflowStep {
  return (step.kind ?? 'agent') === 'agent' ? { ...step, split: step.split ? undefined : { mode: 'auto', count: 10 } } : step;
}
export function renameArea(areas: readonly CustomArea[], index: number, label: string): CustomArea[] {
  return areas.map((a, i) => i === index ? { ...a, label: label.slice(0, 80) } : a);
}
export function mergeArea(areas: readonly CustomArea[], index: number): CustomArea[] {
  if (!areas[index + 1]) return [...areas];
  return areas.flatMap((a, i) => i === index ? [{ label: a.label, paths: [...new Set([...a.paths, ...areas[i + 1].paths])] }] : i === index + 1 ? [] : [a]);
}
function findSourceFolder(tree: SourceTree, path: string): SourceTree | undefined {
  if (tree.path === path) return tree;
  for (const child of tree.children) { const found = findSourceFolder(child, path); if (found) return found; }
}
export function canSplitArea(area: CustomArea, tree?: SourceTree): boolean {
  if (area.paths.length > 1) return true;
  const node = tree && area.paths[0] ? findSourceFolder(tree, area.paths[0]) : undefined;
  return !!node && node.children.length + (node.files ? 1 : 0) > 1;
}
export function splitArea(areas: readonly CustomArea[], index: number, tree?: SourceTree): CustomArea[] {
  if (areas.length >= 16 || !areas[index]) return [...areas];
  let paths = areas[index].paths;
  if (paths.length === 1 && tree) {
    const node = findSourceFolder(tree, paths[0]);
    if (node) paths = [...(node.files ? [`${node.path}/*`] : []), ...node.children.map((c) => c.path)];
  }
  if (paths.length < 2) return [...areas];
  const half = Math.ceil(paths.length / 2), parts = [paths.slice(0, half), paths.slice(half)];
  return areas.flatMap((a, i) => i === index ? parts.map((p) => ({ label: sourceAreaLabel(p, !!tree && p.every((path) => !path.endsWith('/*') && !findSourceFolder(tree, path))), paths: p })) : [a]);
}
export function folderFileCount(tree: SourceTree): number {
  return tree.files + tree.children.reduce((sum, c) => sum + folderFileCount(c), 0);
}

// Every area that already covers part of this folder (or all of it). A
// folder that spans several areas can't be picked without overlapping them.
export function folderAreaOwners(path: string, areas: readonly CustomArea[]): CustomArea[] {
  return areas.filter((a) => a.paths.some((p) => p.endsWith('/*')
    ? areaPathMatches(path, p.slice(0, -2))
    : areaPathMatches(p, path) || areaPathMatches(path, p)));
}

// Resolver output keeps authored order but drops empty scopes; labels need not
// be unique, so pair by both label and intersecting scope rather than name alone.
export function customAreaCounts(wanted: readonly CustomArea[], resolved: readonly SourceArea[], tree?: SourceTree): number[] {
  let next = 0;
  return wanted.map((area) => {
    const result = resolved[next];
    const intersects = (a: string, b: string): boolean => {
      if (a === b) return true;
      if (b.endsWith('/*') && !a.endsWith('/*')) return intersects(b, a);
      if (a.endsWith('/*')) {
        if (b.endsWith('/*')) return false;
        const dir = a.slice(0, -2);
        if (b === '.' || (tree && findSourceFolder(tree, b))) return areaPathMatches(b, dir);
        return areaPathMatches(a, b);
      }
      return areaPathMatches(a, b) || areaPathMatches(b, a);
    };
    if (!result || result.label !== area.label.trim() || !result.paths.some((p) => area.paths.some((q) => intersects(p, q)))) return 0;
    next++;
    return result.files;
  });
}
