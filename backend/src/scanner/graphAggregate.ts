import path from 'node:path';
import { applyCrossFile, type HealthMetrics } from '../health/index.js';
import type { DirectoryEntry } from './collectSourceTree.js';
import type { FileMetric } from './fileMetrics.js';
import type { CouplingMap } from './coupling.js';

export type GraphNode = {
  id: string;
  name: string;
  path: string;
  kind: 'dir' | 'file';
  ext?: string;
  size?: number;
  health?: number;
  healthDetails?: HealthMetrics;
  loc?: number;
};

export type GraphLink = {
  source: string;
  target: string;
};

export type ScanResult = {
  root: string;
  nodes: GraphNode[];
  links: GraphLink[];
};

export type TreeAnalysis = ScanResult;

export function commonRoot(files: string[]): string {
  if (files.length === 0) return process.cwd();
  let root = path.dirname(files[0]);
  while (
    root !== path.dirname(root) &&
    files.some((file) => path.relative(root, file).startsWith('..'))
  ) {
    root = path.dirname(root);
  }
  return root;
}

export function ensureDirectoryNode(
  dir: string,
  root: string,
  nodes: GraphNode[],
  links: GraphLink[],
  seenDirs: Set<string>,
): void {
  if (seenDirs.has(dir)) return;
  const parent = path.dirname(dir);
  if (dir !== root) ensureDirectoryNode(parent, root, nodes, links, seenDirs);
  seenDirs.add(dir);
  nodes.push({ id: dir, name: path.basename(dir) || dir, path: dir, kind: 'dir' });
  if (dir !== root) links.push({ source: parent, target: dir });
}

export function aggregate(
  metrics: FileMetric[],
  coupling: CouplingMap,
  options: { root?: string; directories?: DirectoryEntry[] } = {},
): TreeAnalysis {
  const root = options.root ?? commonRoot(metrics.map((metric) => metric.filePath));
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const seenDirs = new Set<string>();
  const metricsByPath = new Map<string, HealthMetrics>();

  for (const metric of metrics) {
    if (metric.healthDetails) metricsByPath.set(metric.filePath, metric.healthDetails);
  }
  applyCrossFile(metricsByPath, coupling);

  ensureDirectoryNode(root, root, nodes, links, seenDirs);

  if (options.directories) {
    for (const dir of options.directories) {
      if (seenDirs.has(dir.id)) continue;
      seenDirs.add(dir.id);
      nodes.push({ id: dir.id, name: dir.name, path: dir.path, kind: 'dir' });
      links.push({ source: dir.parentId, target: dir.id });
    }
  }

  for (const metric of metrics) {
    const parent = path.dirname(metric.filePath);
    ensureDirectoryNode(parent, root, nodes, links, seenDirs);
    nodes.push({
      id: metric.filePath,
      name: metric.name,
      path: metric.filePath,
      kind: 'file',
      ext: metric.ext,
      size: metric.size,
      health: metric.healthDetails?.score,
      healthDetails: metric.healthDetails,
      loc: metric.loc,
    });
    links.push({ source: parent, target: metric.filePath });
  }

  return { root, nodes, links };
}
