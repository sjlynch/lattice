// Pure: Opengrep's `--json` output → a filtered, deduplicated, grouped digest
// → the markdown an agent actually reads. No IO, no engine — unit-tested on a
// trimmed copy of a real scan.
//
// The DIGEST is the agent-facing contract, not the JSON. A full-pack scan of a
// mature repo yields hundreds of findings and megabytes of JSON; the digest
// applies the project's severity floor + ignore lists FIRST, groups rule →
// file → occurrence (an agent triages 17 rule groups fine and 339 flat items
// badly), collapses repeats to `path:line` after the first snippet, and stays
// under a hard byte budget with "N more …" tails and a drill-down pointer.
//
// This module is the filter/build step. Parsing lives in `parseOutput.ts`,
// markdown rendering in `renderDigest.ts`; both are re-exported here so
// callers keep importing from `./digest.js`.

import {
  fingerprintMatches,
  ruleMatches,
  type OpengrepRunError,
  type OpengrepSeverity,
  type ParsedOpengrepOutput,
} from './parseOutput.js';

export {
  fingerprintMatches,
  parseOpengrepJson,
  ruleMatches,
  shortFingerprint,
  type OpengrepFinding,
  type OpengrepRunError,
  type OpengrepSeverity,
  type ParsedOpengrepOutput,
} from './parseOutput.js';
export { DEFAULT_DIGEST_BUDGET_BYTES, renderDigestMarkdown, type RenderOptions } from './renderDigest.js';

const SEVERITY_RANK: Record<OpengrepSeverity, number> = { ERROR: 0, WARNING: 1, INFO: 2 };

export type DigestFilter = {
  severityFloor: OpengrepSeverity;
  ignoreRuleIds: string[];
  ignoreFingerprints: string[];
};

export const DEFAULT_DIGEST_FILTER: DigestFilter = {
  severityFloor: 'WARNING',
  ignoreRuleIds: [],
  ignoreFingerprints: [],
};

export type DigestOccurrence = {
  line: number;
  endLine: number;
  snippet: string;
  fingerprint: string;
  shortFingerprint: string;
};

export type DigestFile = { path: string; occurrences: DigestOccurrence[] };

export type DigestGroup = {
  ruleId: string;
  severity: OpengrepSeverity;
  message: string;
  category?: string;
  cwe: string[];
  references: string[];
  count: number;
  files: DigestFile[];
};

export type OpengrepDigest = {
  version: string;
  scannedFiles: number;
  // Every finding the engine reported, before filtering.
  total: number;
  // What survived the filter (and dedup).
  shown: number;
  bySeverity: Record<OpengrepSeverity, number>;
  dropped: { belowFloor: number; ignoredRules: number; ignoredFingerprints: number; duplicates: number };
  groups: DigestGroup[];
  errors: OpengrepRunError[];
  partiallyParsed: string[];
  skippedRules: number;
};

export function buildDigest(parsed: ParsedOpengrepOutput, filter: DigestFilter = DEFAULT_DIGEST_FILTER): OpengrepDigest {
  const floor = SEVERITY_RANK[filter.severityFloor] ?? SEVERITY_RANK.WARNING;
  const dropped = { belowFloor: 0, ignoredRules: 0, ignoredFingerprints: 0, duplicates: 0 };
  const seen = new Set<string>();
  const byRule = new Map<string, DigestGroup>();
  // Per-group `path → DigestFile` index so a rule with thousands of hits does
  // not pay a linear file lookup per finding (a broad pack over a mature repo
  // easily reaches 10^3 findings on one rule).
  const filesByRule = new Map<string, Map<string, DigestFile>>();
  const bySeverity: Record<OpengrepSeverity, number> = { ERROR: 0, WARNING: 0, INFO: 0 };
  let shown = 0;

  for (const f of parsed.findings) {
    if (SEVERITY_RANK[f.severity] > floor) {
      dropped.belowFloor += 1;
      continue;
    }
    if (filter.ignoreRuleIds.some((x) => ruleMatches(f.ruleId, x))) {
      dropped.ignoredRules += 1;
      continue;
    }
    if (filter.ignoreFingerprints.some((x) => fingerprintMatches(f.fingerprint, x))) {
      dropped.ignoredFingerprints += 1;
      continue;
    }
    if (seen.has(f.fingerprint)) {
      dropped.duplicates += 1;
      continue;
    }
    seen.add(f.fingerprint);
    shown += 1;
    bySeverity[f.severity] += 1;
    let group = byRule.get(f.ruleId);
    let fileIndex = filesByRule.get(f.ruleId);
    if (!group || !fileIndex) {
      group = {
        ruleId: f.ruleId,
        severity: f.severity,
        message: f.message,
        category: f.category,
        cwe: f.cwe,
        references: f.references,
        count: 0,
        files: [],
      };
      fileIndex = new Map();
      byRule.set(f.ruleId, group);
      filesByRule.set(f.ruleId, fileIndex);
    }
    group.count += 1;
    // The group's severity is the worst any occurrence carries.
    if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[group.severity]) group.severity = f.severity;
    let file = fileIndex.get(f.path);
    if (!file) {
      file = { path: f.path, occurrences: [] };
      group.files.push(file);
      fileIndex.set(f.path, file);
    }
    file.occurrences.push({
      line: f.line,
      endLine: f.endLine,
      snippet: f.snippet,
      fingerprint: f.fingerprint,
      shortFingerprint: f.shortFingerprint,
    });
  }

  const groups = [...byRule.values()];
  for (const g of groups) {
    g.files.sort((a, b) => a.path.localeCompare(b.path));
    for (const file of g.files) file.occurrences.sort((a, b) => a.line - b.line);
  }
  groups.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.count - a.count ||
      a.ruleId.localeCompare(b.ruleId),
  );

  return {
    version: parsed.version,
    scannedFiles: parsed.scannedFiles,
    total: parsed.findings.length,
    shown,
    bySeverity,
    dropped,
    groups,
    errors: parsed.errors,
    partiallyParsed: parsed.partiallyParsed,
    skippedRules: parsed.skippedRules,
  };
}
