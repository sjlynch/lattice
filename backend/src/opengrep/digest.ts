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
// Identity is the FINGERPRINT Opengrep emits per finding (`extra.fingerprint`,
// a hash of rule id + matched code, stable across unrelated edits). Everything
// that stores or compares findings keys on it: dedup here, the
// `opengrep:<fp>` markers the built-in template asks agents to put in tasks,
// `ignoreFingerprints`, and any later baseline diff. The engine's value is
// 128 hex chars + `_N`; the digest prints the SHORT form (first 16 hex + the
// suffix) and every matcher accepts either.

export type OpengrepSeverity = 'ERROR' | 'WARNING' | 'INFO';

const SEVERITY_RANK: Record<OpengrepSeverity, number> = { ERROR: 0, WARNING: 1, INFO: 2 };

export type OpengrepFinding = {
  fingerprint: string;
  shortFingerprint: string;
  ruleId: string;
  severity: OpengrepSeverity;
  message: string;
  // Project-relative, forward slashes.
  path: string;
  line: number;
  endLine: number;
  col: number;
  snippet: string;
  category?: string;
  cwe: string[];
  references: string[];
};

export type OpengrepRunError = {
  kind: string;
  level: string;
  message: string;
  path?: string;
};

export type ParsedOpengrepOutput = {
  version: string;
  findings: OpengrepFinding[];
  errors: OpengrepRunError[];
  partiallyParsed: string[];
  scannedFiles: number;
  skippedRules: number;
};

type RawResult = {
  check_id?: string;
  path?: string;
  start?: { line?: number; col?: number };
  end?: { line?: number };
  extra?: {
    message?: string;
    severity?: string;
    fingerprint?: string;
    lines?: string;
    metadata?: Record<string, unknown>;
  };
};

type RawError = {
  level?: string;
  message?: string;
  path?: string;
  type?: unknown;
};

export function shortFingerprint(fp: string): string {
  const m = /^([0-9a-f]{16})[0-9a-f]*(_\d+)?$/i.exec(fp);
  return m ? `${m[1]}${m[2] ?? ''}` : fp;
}

// `x` may be a full fingerprint, a short one, or any hex prefix of ≥ 8 chars.
export function fingerprintMatches(fp: string, x: string): boolean {
  if (!x) return false;
  if (fp === x) return true;
  const short = shortFingerprint(fp);
  if (short === x) return true;
  const [hex, suffix] = fp.split('_');
  const [xhex, xsuffix] = x.split('_');
  if (xhex.length < 8 || !hex.startsWith(xhex)) return false;
  return xsuffix === undefined || xsuffix === suffix;
}

// A rule may be given as the full check id (`qodana-mit.javascript.xss.foo`)
// or any dot-suffix of it (`xss.foo`, `foo`).
export function ruleMatches(ruleId: string, x: string): boolean {
  if (!x) return false;
  return ruleId === x || ruleId.endsWith(`.${x}`);
}

function toRelativePath(abs: string, projectPath: string): string {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = norm(abs);
  const p = norm(projectPath);
  const lower = process.platform === 'win32';
  const prefixed = lower ? a.toLowerCase().startsWith(`${p.toLowerCase()}/`) : a.startsWith(`${p}/`);
  return prefixed ? a.slice(p.length + 1) : a;
}

function normalizeSeverity(s: unknown): OpengrepSeverity {
  const u = String(s ?? '').toUpperCase();
  if (u === 'ERROR' || u === 'WARNING' || u === 'INFO') return u;
  // Opengrep also knows CRITICAL/HIGH/MEDIUM/LOW on newer rules.
  if (u === 'CRITICAL' || u === 'HIGH') return 'ERROR';
  if (u === 'MEDIUM') return 'WARNING';
  return 'INFO';
}

function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return typeof v === 'string' ? [v] : [];
}

export function parseOpengrepJson(raw: unknown, projectPath: string): ParsedOpengrepOutput {
  const r = (raw && typeof raw === 'object' ? raw : {}) as {
    version?: string;
    results?: RawResult[];
    errors?: RawError[];
    paths?: { scanned?: unknown[] };
    skipped_rules?: unknown[];
  };
  const findings: OpengrepFinding[] = [];
  for (const res of r.results ?? []) {
    const extra = res.extra ?? {};
    const fp = typeof extra.fingerprint === 'string' && extra.fingerprint ? extra.fingerprint : '';
    const ruleId = typeof res.check_id === 'string' ? res.check_id : 'unknown-rule';
    const rel = toRelativePath(String(res.path ?? ''), projectPath);
    const line = Number(res.start?.line ?? 0);
    const meta = (extra.metadata ?? {}) as Record<string, unknown>;
    findings.push({
      // A finding without a fingerprint (should not happen on Opengrep ≥1.x)
      // gets a positional synthetic one so dedup/markers still work.
      fingerprint: fp || `synthetic:${ruleId}:${rel}:${line}`,
      shortFingerprint: fp ? shortFingerprint(fp) : `synthetic:${ruleId}:${rel}:${line}`,
      ruleId,
      severity: normalizeSeverity(extra.severity),
      message: String(extra.message ?? '').replace(/\s+/g, ' ').trim(),
      path: rel,
      line,
      endLine: Number(res.end?.line ?? line),
      col: Number(res.start?.col ?? 0),
      snippet: String(extra.lines ?? '').replace(/\r/g, ''),
      category: typeof meta.category === 'string' ? meta.category : undefined,
      cwe: stringList(meta.cwe),
      references: stringList(meta.references),
    });
  }
  const errors: OpengrepRunError[] = [];
  const partiallyParsed = new Set<string>();
  for (const e of r.errors ?? []) {
    const kind = Array.isArray(e.type) ? String(e.type[0]) : String(e.type ?? 'error');
    const p = typeof e.path === 'string' ? toRelativePath(e.path, projectPath) : undefined;
    if (kind === 'PartialParsing' && p) {
      partiallyParsed.add(p);
      continue;
    }
    errors.push({
      kind,
      level: String(e.level ?? 'error'),
      message: String(e.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
      path: p,
    });
  }
  return {
    version: String(r.version ?? ''),
    findings,
    errors,
    partiallyParsed: [...partiallyParsed].sort(),
    scannedFiles: Array.isArray(r.paths?.scanned) ? r.paths!.scanned!.length : 0,
    skippedRules: Array.isArray(r.skipped_rules) ? r.skipped_rules.length : 0,
  };
}

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
    if (!group) {
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
      byRule.set(f.ruleId, group);
    }
    group.count += 1;
    // The group's severity is the worst any occurrence carries.
    if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[group.severity]) group.severity = f.severity;
    let file = group.files.find((x) => x.path === f.path);
    if (!file) {
      file = { path: f.path, occurrences: [] };
      group.files.push(file);
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

export type RenderOptions = {
  // Hard ceiling on the rendered markdown. Groups past it are summarised.
  budgetBytes: number;
  // Per-group caps so one noisy rule cannot consume the whole budget.
  maxFilesPerGroup?: number;
  maxOccurrencesPerFile?: number;
  // Where the reader can fetch what was cut (an API URL or an MCP tool hint).
  drillDownHint?: string;
  title?: string;
  // Labels for the header.
  projectPath?: string;
  scanId?: string;
  scannedAt?: number;
  filter?: DigestFilter;
};

export const DEFAULT_DIGEST_BUDGET_BYTES = 60 * 1024;

function fence(snippet: string, maxLines = 3): string {
  const lines = snippet.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l.trim() === ''));
  const shown = lines.slice(0, maxLines).map((l) => (l.length > 160 ? `${l.slice(0, 157)}…` : l));
  const tail = lines.length > maxLines ? `\n… (+${lines.length - maxLines} lines)` : '';
  return '```\n' + shown.join('\n') + tail + '\n```';
}

function renderGroup(g: DigestGroup, opts: RenderOptions): string {
  const maxFiles = opts.maxFilesPerGroup ?? 20;
  const maxOcc = opts.maxOccurrencesPerFile ?? 5;
  const out: string[] = [];
  const fileCount = g.files.length;
  out.push(`### ${g.severity} · \`${g.ruleId}\` — ${g.count} finding${g.count === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`);
  out.push('');
  if (g.message) out.push(g.message.length > 400 ? `${g.message.slice(0, 397)}…` : g.message);
  const meta: string[] = [];
  if (g.category) meta.push(`category: ${g.category}`);
  if (g.cwe.length) meta.push(`CWE: ${g.cwe.slice(0, 3).join('; ')}`);
  if (g.references.length) meta.push(`refs: ${g.references.slice(0, 2).join(' , ')}`);
  if (meta.length) {
    out.push('');
    out.push(`_${meta.join(' · ')}_`);
  }
  out.push('');
  let firstSnippetShown = false;
  g.files.slice(0, maxFiles).forEach((file) => {
    const occ = file.occurrences;
    const shownOcc = occ.slice(0, maxOcc);
    out.push(`- \`${file.path}\`: ${shownOcc.map((o) => `L${o.line} (fp \`${o.shortFingerprint}\`)`).join(', ')}${occ.length > maxOcc ? ` … +${occ.length - maxOcc} more in this file (same rule; narrow the digest with file=\`${file.path}\` to list them all)` : ''}`);
    if (!firstSnippetShown && shownOcc[0]?.snippet.trim()) {
      out.push('');
      out.push(`  ${file.path}:${shownOcc[0].line}`);
      out.push(fence(shownOcc[0].snippet).split('\n').map((l) => `  ${l}`).join('\n'));
      out.push('');
      firstSnippetShown = true;
    }
  });
  if (fileCount > maxFiles) {
    const rest = g.files.slice(maxFiles).reduce((n, f) => n + f.occurrences.length, 0);
    out.push(`- … ${fileCount - maxFiles} more files (${rest} findings) — see the drill-down below`);
  }
  out.push('');
  return out.join('\n');
}

export function renderDigestMarkdown(digest: OpengrepDigest, opts: RenderOptions): string {
  const budget = opts.budgetBytes > 0 ? opts.budgetBytes : DEFAULT_DIGEST_BUDGET_BYTES;
  const head: string[] = [];
  head.push(`# ${opts.title ?? 'Opengrep findings'}`);
  head.push('');
  const stamp: string[] = [];
  if (opts.projectPath) stamp.push(`project: \`${opts.projectPath}\``);
  if (opts.scanId) stamp.push(`scan: \`${opts.scanId}\``);
  if (opts.scannedAt) stamp.push(`at: ${new Date(opts.scannedAt).toISOString()}`);
  if (digest.version) stamp.push(`opengrep ${digest.version}`);
  if (stamp.length) head.push(stamp.join(' · '));
  head.push('');
  head.push(
    `**${digest.shown} finding${digest.shown === 1 ? '' : 's'} shown** across ${digest.groups.length} rule${digest.groups.length === 1 ? '' : 's'} ` +
      `(${digest.bySeverity.ERROR} ERROR, ${digest.bySeverity.WARNING} WARNING, ${digest.bySeverity.INFO} INFO) · ` +
      `${digest.scannedFiles} files scanned · ${digest.total} raw findings.`,
  );
  const f = opts.filter;
  const droppedBits: string[] = [];
  if (digest.dropped.belowFloor) droppedBits.push(`${digest.dropped.belowFloor} below the ${f?.severityFloor ?? 'severity'} floor`);
  if (digest.dropped.ignoredRules) droppedBits.push(`${digest.dropped.ignoredRules} from ignored rules`);
  if (digest.dropped.ignoredFingerprints) droppedBits.push(`${digest.dropped.ignoredFingerprints} ignored by fingerprint`);
  if (digest.dropped.duplicates) droppedBits.push(`${digest.dropped.duplicates} duplicates`);
  if (droppedBits.length) head.push(`Filtered out before this digest: ${droppedBits.join(', ')}.`);
  head.push('');
  head.push(
    'Each finding carries a short fingerprint (`fp`). Fingerprints are stable across unrelated edits: ' +
      'when you file a task for a finding, put `opengrep:<fp>` on its own line in the task description and ' +
      'search the board for that marker first so a re-run does not file the same finding twice.',
  );
  head.push('');
  if (digest.groups.length === 0) {
    head.push('_No findings at or above the configured severity floor. Nothing to triage._');
    head.push('');
  }

  const sections: string[] = [];
  let used = Buffer.byteLength(head.join('\n'), 'utf8');
  let cutGroups = 0;
  let cutFindings = 0;
  const tailReserve = 600;
  for (const g of digest.groups) {
    const text = renderGroup(g, opts);
    const size = Buffer.byteLength(text, 'utf8');
    if (used + size + tailReserve > budget) {
      cutGroups += 1;
      cutFindings += g.count;
      continue;
    }
    sections.push(text);
    used += size;
  }

  const tail: string[] = [];
  if (cutGroups > 0) {
    tail.push(
      `> **Budget reached:** ${cutGroups} more rule${cutGroups === 1 ? '' : 's'} (${cutFindings} findings) were left out of this digest to stay under ${Math.round(budget / 1024)} KB.` +
        (opts.drillDownHint ? ` ${opts.drillDownHint}` : ''),
    );
    tail.push('');
  } else if (opts.drillDownHint) {
    tail.push(`> ${opts.drillDownHint}`);
    tail.push('');
  }
  if (digest.partiallyParsed.length || digest.errors.length || digest.skippedRules) {
    tail.push('## Scan caveats');
    tail.push('');
    if (digest.partiallyParsed.length) {
      const shown = digest.partiallyParsed.slice(0, 15);
      tail.push(
        `- ${digest.partiallyParsed.length} file${digest.partiallyParsed.length === 1 ? ' was' : 's were'} only PARTIALLY parsed (a syntax the engine's parser does not support yet); findings in the unparsed regions are missing: ${shown.map((p) => `\`${p}\``).join(', ')}${digest.partiallyParsed.length > shown.length ? ` … +${digest.partiallyParsed.length - shown.length} more` : ''}`,
      );
    }
    if (digest.skippedRules) tail.push(`- ${digest.skippedRules} rule${digest.skippedRules === 1 ? '' : 's'} skipped by the engine (unsupported features or invalid definitions).`);
    for (const e of digest.errors.slice(0, 10)) {
      tail.push(`- ${e.level} ${e.kind}${e.path ? ` in \`${e.path}\`` : ''}: ${e.message}`);
    }
    if (digest.errors.length > 10) tail.push(`- … +${digest.errors.length - 10} more errors`);
    tail.push('');
  }

  return [head.join('\n'), ...sections, tail.join('\n')].join('\n').replace(/\n{3,}/g, '\n\n');
}
