import type { OpengrepFinding, OpengrepGraphResult } from '../../api/opengrep';
import type { OpengrepSeverity } from '../../api';

export type SecurityCategory = 'all' | 'security' | 'quality';
export type SecurityFilter = { category: SecurityCategory; severity: OpengrepSeverity | 'all' };
export const DEFAULT_SECURITY_FILTER: SecurityFilter = { category: 'all', severity: 'all' };
export function passesSecurityFloor(f: OpengrepFinding, floor: OpengrepSeverity = 'INFO') {
  const rank = { ERROR: 0, WARNING: 1, INFO: 2 };
  return rank[f.severity] <= rank[floor];
}
export function isSecurityFinding(finding: OpengrepFinding): boolean {
  return finding.category === 'security' || finding.cwe.length > 0 || /(^|\.)security\./.test(finding.ruleId);
}
export function matchesSecurityFinding(f: OpengrepFinding, filter: SecurityFilter, query: string, status: 'all' | 'open' | 'ignored' | 'deferred', file?: string | null) {
  return (!file || f.path === file) &&
    (status === 'all' || (f.triage?.status ?? 'open') === status) &&
    (filter.severity === 'all' || filter.severity === f.severity) &&
    (filter.category === 'all' || isSecurityFinding(f) === (filter.category === 'security')) &&
    `${f.path} ${f.ruleId} ${f.message} ${f.cwe.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase());
}
export function filteredSecurityResult(result: OpengrepGraphResult, filter: SecurityFilter): OpengrepGraphResult {
  if (!result.findings) return result;
  const rank = { ERROR: 0, WARNING: 1, INFO: 2 };
  const findings = result.findings.filter((f) => (filter.severity === 'all' || f.severity === filter.severity) &&
    (filter.category === 'all' || isSecurityFinding(f) === (filter.category === 'security')))
    .sort((a, b) => rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path) || a.line - b.line);
  const byFile = new Map<string, OpengrepFinding[]>();
  const bySeverity = { ERROR: 0, WARNING: 0, INFO: 0 };
  for (const finding of findings) {
    bySeverity[finding.severity]++;
    const list = byFile.get(finding.path) ?? [];
    list.push(finding); byFile.set(finding.path, list);
  }
  return { ...result, findings, shown: findings.length, bySeverity,
    files: result.files.map((file) => ({ ...file, findings: byFile.get(file.path)?.length ?? 0,
      severity: byFile.get(file.path)?.[0]?.severity ?? null })) };
}
export function securityFreshnessLabel(result: OpengrepGraphResult): string {
  const freshness = result.freshness;
  if (!freshness || freshness.state === 'unknown') return 'Freshness unknown';
  if (freshness.configurationChanged) return 'Rules or configuration changed';
  return freshness.changedFiles ? `${freshness.changedFiles} file${freshness.changedFiles === 1 ? '' : 's'} changed` : 'Up to date';
}
export function findingEditorUrl(project: string, finding: OpengrepFinding): string {
  const absolute = `${project.replace(/[\\/]+$/, '')}/${finding.path}`.replace(/\\/g, '/');
  return `vscode://file/${absolute.split('/').map((part) => encodeURIComponent(part)).join('/')}:${finding.line}:${finding.col}`;
}

export function groupSecurityFindings(findings: OpengrepFinding[], by: 'file' | 'rule') {
  const groups = new Map<string, OpengrepFinding[]>();
  const rank = { ERROR: 0, WARNING: 1, INFO: 2 };
  for (const finding of findings) {
    const key = by === 'file' ? finding.path : finding.ruleId;
    const group = groups.get(key) ?? []; group.push(finding); groups.set(key, group);
  }
  return [...groups].map(([key, items]) => ({ key, findings: items.sort((a, b) => rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path) || a.line - b.line) }))
    .sort((a, b) => rank[a.findings[0].severity] - rank[b.findings[0].severity] || a.key.localeCompare(b.key));
}
