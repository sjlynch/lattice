import type { ScanResult } from '../api';

// Pure ScanResult-patch helpers used by useProjectScan to apply live
// health/file-save updates to the in-memory scan result without re-scanning.
// These do data-shape transformations only — no React lifecycle.

type RuntimeLink = { source: unknown; target: unknown };

type FileMetrics = NonNullable<ScanResult['nodes'][number]['healthDetails']>;

export type MetricUpdate = { filePath: string; metrics: FileMetrics };

export function linkEndpointId(endpoint: unknown): string | null {
  if (typeof endpoint === 'string') return endpoint;
  if (endpoint && typeof endpoint === 'object') {
    const node = endpoint as { id?: unknown; path?: unknown };
    if (typeof node.id === 'string') return node.id;
    if (typeof node.path === 'string') return node.path;
  }
  return null;
}

export function normalizeLinks(links: ScanResult['links']): ScanResult['links'] {
  const normalized: ScanResult['links'] = [];
  for (const link of links) {
    const runtimeLink = link as unknown as RuntimeLink;
    const source = linkEndpointId(runtimeLink.source);
    const target = linkEndpointId(runtimeLink.target);
    if (source && target) normalized.push({ source, target });
  }
  return normalized;
}

export function patchUpdatedFile(
  prev: ScanResult,
  filePath: string,
  metrics: FileMetrics,
): ScanResult | null {
  const idx = prev.nodes.findIndex(
    (n) => n.kind === 'file' && n.path === filePath,
  );
  if (idx === -1) return null;
  const nextNodes = prev.nodes.slice();
  nextNodes[idx] = {
    ...nextNodes[idx],
    health: metrics.score,
    healthDetails: metrics,
    loc: metrics.loc,
  };
  return { ...prev, nodes: nextNodes };
}

// Batch form of `patchUpdatedFile` used by the metric-update queue: applies a
// whole burst of `updated` events in one pass. Builds the path→index map once
// (instead of an O(N) findIndex per file), clones only the nodes whose metric
// fields actually changed, and — critically — keeps `prev.links` by reference
// so the graph's fast-patch path can detect "metric-only" by links identity.
// Returns `prev` unchanged when nothing moved (no-op → no React render).
// `missing` is true when a queued file isn't in the current scan (added after
// the last scan), so the caller can fall back to a structural rescan.
export function patchUpdatedFiles(
  prev: ScanResult,
  updates: ReadonlyArray<MetricUpdate>,
): { result: ScanResult; missing: boolean } {
  if (updates.length === 0) return { result: prev, missing: false };
  const indexByPath = new Map<string, number>();
  for (let i = 0; i < prev.nodes.length; i++) {
    const n = prev.nodes[i];
    if (n.kind === 'file') indexByPath.set(n.path, i);
  }
  let nextNodes: ScanResult['nodes'] | null = null;
  let missing = false;
  for (const { filePath, metrics } of updates) {
    const idx = indexByPath.get(filePath);
    if (idx === undefined) {
      missing = true;
      continue;
    }
    const base = (nextNodes ?? prev.nodes)[idx];
    // Skip the clone when this file's metrics are already current.
    if (
      base.health === metrics.score &&
      base.healthDetails === metrics &&
      base.loc === metrics.loc
    ) {
      continue;
    }
    if (!nextNodes) nextNodes = prev.nodes.slice();
    nextNodes[idx] = {
      ...base,
      health: metrics.score,
      healthDetails: metrics,
      loc: metrics.loc,
    };
  }
  // `{ ...prev, nodes }` keeps `prev.links` by reference (spread copies the same
  // array) — that identity is what the graph's metric fast-path keys on.
  return { result: nextNodes ? { ...prev, nodes: nextNodes } : prev, missing };
}

export function removeFile(prev: ScanResult, filePath: string): ScanResult {
  const nextNodes = prev.nodes.filter((n) => n.path !== filePath);
  if (nextNodes.length === prev.nodes.length) return prev;
  const nextLinks = normalizeLinks(prev.links).filter(
    (l) => l.source !== filePath && l.target !== filePath,
  );
  return { ...prev, nodes: nextNodes, links: nextLinks };
}
