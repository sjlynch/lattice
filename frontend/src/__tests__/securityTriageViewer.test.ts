import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesSecurityFinding, passesSecurityFloor, DEFAULT_SECURITY_FILTER } from '../components/forceGraph/securityFindings';
import { securityVisibleRange } from '../components/forceGraph/SecurityFindingList';
import type { OpengrepFinding } from '../api/opengrep';
const f: OpengrepFinding = { fingerprint: 'fp', shortFingerprint: 'fp', path: 'src/Auth.ts', line: 2, endLine: 2, col: 1, severity: 'ERROR', ruleId: 'security.input', message: 'Unsanitized input', snippet: '', cwe: ['CWE-78'], references: [] };
test('finding filters combine severity, category, search, file scope and disposition', () => {
  assert.equal(matchesSecurityFinding(f, DEFAULT_SECURITY_FILTER, ' AUTH ', 'open'), true);
  assert.equal(matchesSecurityFinding(f, DEFAULT_SECURITY_FILTER, 'CWE-78', 'open'), true);
  assert.equal(matchesSecurityFinding(f, { category: 'quality', severity: 'all' }, '', 'open'), false);
  assert.equal(matchesSecurityFinding(f, { category: 'security', severity: 'WARNING' }, '', 'open'), false);
  assert.equal(matchesSecurityFinding(f, DEFAULT_SECURITY_FILTER, '', 'open', 'src/Other.ts'), false);
  const ignored = { ...f, triage: { status: 'ignored' as const, scope: 'local' as const, reason: 'Test', updatedAt: 1 } };
  assert.equal(matchesSecurityFinding(ignored, DEFAULT_SECURITY_FILTER, '', 'open'), false);
  assert.equal(matchesSecurityFinding(ignored, DEFAULT_SECURITY_FILTER, '', 'ignored'), true);
  assert.equal(matchesSecurityFinding(ignored, DEFAULT_SECURITY_FILTER, '', 'all'), true);
  assert.equal(matchesSecurityFinding(f, DEFAULT_SECURITY_FILTER, 'defer', 'open', null, 'defer'), true);
  assert.equal(passesSecurityFloor({ ...f, severity: 'INFO' }, 'WARNING'), false);
  assert.equal(passesSecurityFloor(f, 'WARNING'), true);
});
test('virtual scrolling renders a bounded window and can reach the last finding', () => {
  assert.deepEqual(securityVisibleRange(10_000, 0, 360), { start: 0, end: 10 });
  assert.deepEqual(securityVisibleRange(10_000, 7200, 360), { start: 95, end: 110 });
  assert.deepEqual(securityVisibleRange(314, 314 * 72 - 360, 360), { start: 304, end: 314 });
  assert.deepEqual(securityVisibleRange(0, 0, 360), { start: 0, end: 0 });
  assert.deepEqual(securityVisibleRange(3, 10000, 360), { start: 3, end: 3 });
});
