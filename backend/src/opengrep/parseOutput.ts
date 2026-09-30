// Pure: Opengrep's `--json` output → typed findings, plus the fingerprint and
// rule matchers everything downstream keys on. No IO, no engine.
//
// Identity is the FINGERPRINT Opengrep emits per finding (`extra.fingerprint`,
// a hash of rule id + matched code, stable across unrelated edits). Everything
// that stores or compares findings keys on it: dedup in the digest, the
// `opengrep:<fp>` markers the built-in template asks agents to put in tasks,
// `ignoreFingerprints`, and any later baseline diff. The engine's value is
// 128 hex chars + `_N`; the digest prints the SHORT form (first 16 hex + the
// suffix) and every matcher accepts either.

export type OpengrepSeverity = 'ERROR' | 'WARNING' | 'INFO';

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
  // Project-relative paths actually visited by the engine (graph coverage).
  scannedPaths: string[];
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

// `x` may be a full fingerprint, a short one, or any hex prefix of ≥ 8 chars
// (case-insensitive: the engine prints lower-case hex, a hand-typed ignore
// entry may not), optionally spelled with the `opengrep:` task-marker prefix.
export function fingerprintMatches(fp: string, x: string): boolean {
  if (!x) return false;
  const want = x.trim().replace(/^opengrep:/i, '').toLowerCase();
  if (!want) return false;
  const have = fp.toLowerCase();
  if (have === want) return true;
  const short = shortFingerprint(have);
  if (short === want) return true;
  const [hex, suffix] = have.split('_');
  const [xhex, xsuffix] = want.split('_');
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
  return (prefixed ? a.slice(p.length + 1) : a).replace(/^(?:\.\/)+/, '');
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
    scannedPaths: Array.isArray(r.paths?.scanned)
      ? r.paths.scanned.filter((p): p is string => typeof p === 'string').map((p) => toRelativePath(p, projectPath))
      : [],
    skippedRules: Array.isArray(r.skipped_rules) ? r.skipped_rules.length : 0,
  };
}
