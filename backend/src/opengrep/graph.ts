// Compact per-file colors from the complete filtered findings, independent of
// the markdown byte budget. Only visited files without scan caveats can be green.
import { buildDigest, type DigestFilter, type OpengrepSeverity, type ParsedOpengrepOutput } from './digest.js';
import type { OpengrepScanRecord } from './scanRecords.js';

export type OpengrepGraphFile = {
  path: string;
  severity: OpengrepSeverity | null;
  findings: number;
  incomplete: boolean;
};

export function buildOpengrepGraph(
  parsed: ParsedOpengrepOutput,
  scan: OpengrepScanRecord,
  filter: DigestFilter,
) {
  const digest = buildDigest(parsed, filter);
  const pathKey = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
  const uncertainPaths = [
    ...parsed.partiallyParsed,
    ...parsed.errors.flatMap((e) => e.path ? [e.path] : []),
  ];
  const uncertainKeys = new Set(uncertainPaths.map(pathKey));
  const incompleteScan = parsed.skippedRules > 0 || parsed.errors.some((e) => !e.path) ||
    scan.exitCode === null || scan.exitCode > 1;
  const visited = new Set(parsed.scannedPaths.map(pathKey));
  const files = new Map<string, OpengrepGraphFile>();
  const fileFor = (filePath: string): OpengrepGraphFile => {
    const key = pathKey(filePath);
    let file = files.get(key);
    if (!file) {
      file = {
        path: filePath,
        severity: null,
        findings: 0,
        incomplete: incompleteScan || uncertainKeys.has(key) || !visited.has(key),
      };
      files.set(key, file);
    }
    return file;
  };
  for (const filePath of parsed.scannedPaths) fileFor(filePath);
  for (const filePath of uncertainPaths) fileFor(filePath);
  const rank = { ERROR: 0, WARNING: 1, INFO: 2 };
  for (const group of digest.groups) {
    for (const match of group.files) {
      const file = fileFor(match.path);
      file.findings += match.occurrences.length;
      for (const occurrence of match.occurrences) {
        // A rule group's worst severity can come from a different file.
        if (file.severity === null || rank[occurrence.severity] < rank[file.severity]) {
          file.severity = occurrence.severity;
        }
      }
    }
  }
  return {
    canonicalProject: scan.project,
    scan,
    files: [...files.values()],
    shown: digest.shown,
    errors: parsed.errors.length,
    partiallyParsed: parsed.partiallyParsed.length,
    skippedRules: parsed.skippedRules,
  };
}
