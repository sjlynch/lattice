import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpengrepFinding, OpengrepGraphResult } from '../api/opengrep.ts';
import { filteredSecurityResult, groupSecurityFindings, findingEditorUrl, securityFreshnessLabel } from '../components/forceGraph/securityFindings.ts';
import { securityColor, SECURITY_COLORS } from '../components/forceGraph/securityOverlay.ts';

function finding(path: string, severity: OpengrepFinding['severity'], category: string): OpengrepFinding {
  return { path, severity, category, fingerprint: `${path}-${severity}`, shortFingerprint: `${path}-${severity}`,
    ruleId: `rules.${category}.test`, message: 'Review this code', line: 12, endLine: 12, col: 3,
    snippet: 'test()', cwe: [], references: [] };
}
const findings = [finding('src/quality.ts', 'WARNING', 'portability'), finding('src/mixed.ts', 'ERROR', 'security'), finding('src/mixed.ts', 'WARNING', 'correctness')];
const result = { findings, shown: 3, files: [
  { path: 'src/quality.ts', severity: 'WARNING', findings: 1, incomplete: false },
  { path: 'src/mixed.ts', severity: 'ERROR', findings: 2, incomplete: false },
  { path: 'clean.ts', severity: null, findings: 0, incomplete: false },
  { path: 'partial.ts', severity: null, findings: 0, incomplete: true },
] } as OpengrepGraphResult;

test('category and severity filtering recolor the same file set and preserve coverage', () => {
  const security = filteredSecurityResult(result, { category: 'security', severity: 'all' });
  assert.equal(security.shown, 1);
  assert.equal(security.files.length, result.files.length, 'filters never hide files');
  assert.equal(security.files[0].severity, null);
  assert.equal(security.files[1].severity, 'ERROR');
  assert.equal(security.files[3].incomplete, true);
  const quality = filteredSecurityResult(result, { category: 'quality', severity: 'WARNING' });
  assert.equal(quality.shown, 2);
  assert.equal(quality.files[1].severity, 'WARNING');
  assert.deepEqual(quality.bySeverity, { ERROR: 0, WARNING: 2, INFO: 0 });
  assert.equal(result.files[1].severity, 'ERROR', 'filtering leaves the saved snapshot intact');
});

test('grouping prioritizes groups with errors; editor links encode spaces and preserve the line', () => {
  const groups = groupSecurityFindings(findings, 'file');
  assert.equal(groups[0].key, 'src/mixed.ts');
  assert.equal(groups[0].findings.length, 2);
  assert.equal(groupSecurityFindings(findings, 'rule')[0].key, 'rules.security.test');
  assert.equal(findingEditorUrl('C:\\My Project', { ...findings[0], path: 'src/a #?.ts' }), 'vscode://file/C%3A/My%20Project/src/a%20%23%3F.ts:12:3');
});

test('unknown, changed and incomplete results never appear as a fresh clean result', () => {
  assert.equal(securityFreshnessLabel(result), 'Freshness unknown');
  assert.equal(securityFreshnessLabel({ ...result, freshness: { state: 'changed', changedFiles: 3, configurationChanged: false, checkedAt: 0 } }), '3 files changed');
  assert.equal(securityColor({ path: 'clean.ts', severity: null, findings: 0, incomplete: false, stale: true }), SECURITY_COLORS.unknown);
  assert.equal(securityColor(result.files[3]), SECURITY_COLORS.unknown);
});
