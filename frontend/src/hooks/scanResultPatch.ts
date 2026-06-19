import type { ScanResult } from '../api';

// Pure ScanResult-patch helpers used by useProjectScan to apply live
// health/file-save updates to the in-memory scan result without re-scanning.
// These do data-shape transformations only — no React lifecycle.

type RuntimeLink = { source: unknown; target: unknown };

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
  metrics: NonNullable<ScanResult['nodes'][number]['healthDetails']>,
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

export function removeFile(prev: ScanResult, filePath: string): ScanResult {
  const nextNodes = prev.nodes.filter((n) => n.path !== filePath);
  if (nextNodes.length === prev.nodes.length) return prev;
  const nextLinks = normalizeLinks(prev.links).filter(
    (l) => l.source !== filePath && l.target !== filePath,
  );
  return { ...prev, nodes: nextNodes, links: nextLinks };
}
