import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildDigest,
  fingerprintMatches,
  parseOpengrepJson,
  renderDigestMarkdown,
  ruleMatches,
  shortFingerprint,
} from '../opengrep/digest.js';

// The fixture is a trimmed copy of a real Opengrep 1.30.0 `--json` scan of
// Lattice with the archived JS/TS packs (paths rewritten to `C:\proj`): 32
// results over 10 rules (7 ERROR incl. one deliberate duplicate, 13 WARNING,
// 12 INFO), 2 engine errors, 40 scanned paths. The digest is the agent-facing
// contract, so what these pin is the FILTERING and the SHAPE, not the engine.

const FIXTURE = fileURLToPath(new URL('./fixtures/opengrep-scan.json', import.meta.url));
const PROJECT = 'C:\\proj';

function parsed() {
  return parseOpengrepJson(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')), PROJECT);
}

test('parse: findings carry project-relative forward-slash paths, severities and fingerprints', () => {
  const p = parsed();
  assert.equal(p.version, '1.30.0');
  assert.equal(p.findings.length, 32);
  assert.equal(p.scannedFiles, 40);
  for (const f of p.findings) {
    assert.ok(!f.path.includes('\\'), `path uses forward slashes: ${f.path}`);
    assert.ok(!/^[A-Za-z]:/.test(f.path), `path is project-relative: ${f.path}`);
    assert.ok(f.path.startsWith('backend/') || f.path.startsWith('frontend/'), f.path);
    assert.ok(['ERROR', 'WARNING', 'INFO'].includes(f.severity));
    assert.match(f.fingerprint, /^[0-9a-f]{128}_\d+$/);
    assert.equal(f.shortFingerprint, shortFingerprint(f.fingerprint));
    assert.ok(f.line > 0);
  }
  // Engine errors split into partially-parsed files vs. everything else.
  assert.equal(p.partiallyParsed.length + p.errors.length, 2);
  for (const path of p.partiallyParsed) assert.ok(!path.includes('\\'));
});

test('digest: default WARNING floor drops INFO, dedupes by fingerprint, groups rule → file, orders ERROR first', () => {
  const d = buildDigest(parsed());
  assert.equal(d.total, 32);
  assert.equal(d.dropped.belowFloor, 12);
  assert.equal(d.dropped.duplicates, 1);
  assert.equal(d.shown, 19);
  assert.deepEqual(d.bySeverity, { ERROR: 6, WARNING: 13, INFO: 0 });
  assert.equal(d.groups.length, 8);
  const sevs = d.groups.map((g) => g.severity);
  assert.deepEqual(sevs.slice(0, 4), ['ERROR', 'ERROR', 'ERROR', 'ERROR']);
  assert.deepEqual(sevs.slice(4), ['WARNING', 'WARNING', 'WARNING', 'WARNING']);
  // Within a severity, the noisiest rule comes first.
  const errCounts = d.groups.slice(0, 4).map((g) => g.count);
  assert.deepEqual([...errCounts].sort((a, b) => b - a), errCounts);
  // Every group's occurrence total equals its count, and files are sorted.
  for (const g of d.groups) {
    assert.equal(g.files.reduce((n, f) => n + f.occurrences.length, 0), g.count);
    const paths = g.files.map((f) => f.path);
    assert.deepEqual([...paths].sort(), paths);
  }
});

test('digest: INFO floor shows every unique finding', () => {
  const d = buildDigest(parsed(), { severityFloor: 'INFO', ignoreRuleIds: [], ignoreFingerprints: [] });
  assert.equal(d.shown, 31);
  assert.equal(d.groups.length, 10);
  assert.equal(d.dropped.belowFloor, 0);
});

test('digest: ignoreRuleIds matches full ids and dot-suffixes; ignoreFingerprints accepts the short form', () => {
  const p = parsed();
  const bySuffix = buildDigest(p, { severityFloor: 'WARNING', ignoreRuleIds: ['useless-ternary'], ignoreFingerprints: [] });
  assert.ok(!bySuffix.groups.some((g) => g.ruleId.endsWith('.useless-ternary')));
  // The fixture's one duplicated finding is a useless-ternary one (1 real + 1
  // copy), so ignoring the rule swallows both before dedup ever sees them.
  assert.equal(bySuffix.dropped.ignoredRules, 2);
  assert.equal(bySuffix.dropped.duplicates, 0);

  const full = p.findings.find((f) => f.ruleId.endsWith('.detect-redos'))!;
  const byFull = buildDigest(p, { severityFloor: 'WARNING', ignoreRuleIds: [full.ruleId], ignoreFingerprints: [] });
  assert.ok(!byFull.groups.some((g) => g.ruleId === full.ruleId));

  const byShortFp = buildDigest(p, {
    severityFloor: 'WARNING',
    ignoreRuleIds: [],
    ignoreFingerprints: [full.shortFingerprint],
  });
  assert.equal(byShortFp.dropped.ignoredFingerprints, 1);
  assert.ok(!byShortFp.groups.some((g) => g.ruleId === full.ruleId));
});

test('fingerprint + rule matchers', () => {
  const fp = `${'ab'.repeat(64)}_3`;
  assert.equal(shortFingerprint(fp), `${'ab'.repeat(8)}_3`);
  assert.ok(fingerprintMatches(fp, fp));
  assert.ok(fingerprintMatches(fp, shortFingerprint(fp)));
  assert.ok(fingerprintMatches(fp, 'abababab'));
  assert.ok(!fingerprintMatches(fp, `${'ab'.repeat(8)}_4`), 'suffix must agree when given');
  assert.ok(!fingerprintMatches(fp, 'abab'), 'too short a prefix never matches');
  assert.ok(!fingerprintMatches(fp, ''));
  assert.ok(ruleMatches('pack.javascript.lang.security.foo', 'foo'));
  assert.ok(ruleMatches('pack.javascript.lang.security.foo', 'security.foo'));
  assert.ok(ruleMatches('pack.javascript.lang.security.foo', 'pack.javascript.lang.security.foo'));
  assert.ok(!ruleMatches('pack.javascript.lang.security.foo', 'oo'));
  assert.ok(!ruleMatches('pack.javascript.lang.security.foo', ''));
});

test('render: markdown carries the header, fingerprint guidance, ERROR groups first and the caveats section', () => {
  const p = parsed();
  const d = buildDigest(p);
  const md = renderDigestMarkdown(d, {
    budgetBytes: 60 * 1024,
    projectPath: PROJECT,
    scanId: 'og_test',
    scannedAt: Date.UTC(2026, 8, 21),
    filter: { severityFloor: 'WARNING', ignoreRuleIds: [], ignoreFingerprints: [] },
    drillDownHint: 'DRILL-DOWN-HINT',
  });
  assert.match(md, /^# Opengrep findings/);
  assert.match(md, /19 findings shown/);
  assert.match(md, /opengrep:<fp>/);
  assert.match(md, /12 below the WARNING floor/);
  assert.match(md, /1 duplicates/);
  const firstError = md.indexOf('### ERROR');
  const firstWarning = md.indexOf('### WARNING');
  assert.ok(firstError > 0 && firstWarning > firstError, 'ERROR groups precede WARNING groups');
  assert.ok(!md.includes('### INFO'));
  assert.match(md, /fp `[0-9a-f]{16}_\d+`/, 'each occurrence shows its short fingerprint');
  assert.match(md, /DRILL-DOWN-HINT/);
  assert.match(md, /## Scan caveats/);
  assert.match(md, /PARTIALLY parsed|rule.* skipped|error/i);
  // File bullets are project-relative (the engine's own error text in the
  // caveats section may still quote an absolute path — that is its message).
  const fileBullets = [...md.matchAll(/^- `([^`]+)`:/gm)].map((m) => m[1]);
  assert.ok(fileBullets.length >= 8, `file bullets rendered (${fileBullets.length})`);
  for (const p of fileBullets) assert.ok(!/^[A-Za-z]:|\\/.test(p), `relative forward-slash path: ${p}`);
});

test('render: the byte budget is honoured with a "budget reached" tail naming what was cut', () => {
  const d = buildDigest(parsed(), { severityFloor: 'INFO', ignoreRuleIds: [], ignoreFingerprints: [] });
  const small = renderDigestMarkdown(d, { budgetBytes: 2 * 1024 });
  assert.ok(Buffer.byteLength(small, 'utf8') < 4 * 1024, `small digest stays small (${small.length})`);
  assert.match(small, /Budget reached:\*\* \d+ more rules? \(\d+ findings\)/);
  const big = renderDigestMarkdown(d, { budgetBytes: 512 * 1024 });
  assert.ok(!big.includes('Budget reached'));
  for (const g of d.groups) assert.ok(big.includes(`\`${g.ruleId}\``), `all groups rendered: ${g.ruleId}`);
});

test('render: an empty digest says so instead of rendering nothing', () => {
  const d = buildDigest(parsed(), {
    severityFloor: 'ERROR',
    ignoreRuleIds: ['useless-ternary', 'detect-child-process', 'spawn-shell-true', 'detect-insecure-websocket'],
    ignoreFingerprints: [],
  });
  assert.equal(d.shown, 0);
  const md = renderDigestMarkdown(d, { budgetBytes: 4096 });
  assert.match(md, /No findings at or above/);
});
