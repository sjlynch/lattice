import type { WorkflowStep } from '../workflows/types.js';

export function normalizeAreaPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((p): p is string => typeof p === 'string').map((p) => p.trim().replace(/\/$/, '')).filter((p) => {
    if (p === '.' || p === './*') return true;
    if (!p || p === '*' || /[\\:\x00-\x1f]/.test(p) || p.startsWith('/')) return false;
    const parts = p.split('/');
    return parts.every((s, i) => s !== '' && s !== '.' && s !== '..' && (!s.includes('*') || (s === '*' && i === parts.length - 1)));
  }))];
}
export function normalizeWorkflowSplit(value: unknown): WorkflowStep['split'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.mode === 'auto') {
    const n = Number(raw.count ?? 10);
    return { mode: 'auto', count: Number.isFinite(n) ? Math.max(2, Math.min(16, Math.trunc(n))) : 10 };
  }
  if (raw.mode !== 'custom') return undefined;
  const areas = (Array.isArray(raw.areas) ? raw.areas : []).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const a = item as Record<string, unknown>, paths = normalizeAreaPaths(a.paths);
    const label = typeof a.label === 'string' ? a.label.trim().slice(0, 80) : '';
    return label && paths.length ? [{ label, paths }] : [];
  }).slice(0, 16);
  return { mode: 'custom', areas, includeRest: raw.includeRest !== false };
}
