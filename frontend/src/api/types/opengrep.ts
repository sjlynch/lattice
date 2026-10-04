import type { OpengrepSeverity } from './settings';

export type OpengrepInstallJob = {
  status: 'running' | 'done' | 'failed';
  phase: 'downloading' | 'verifying' | 'checking';
  version: string;
  asset: string;
  note?: string;
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
};

export type OpengrepRulePackJob = {
  status: 'running' | 'done' | 'failed';
  packId: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
};

export type OpengrepRulePackStatus = {
  id: string;
  label: string;
  repo: string;
  homepage: string;
  commit: string;
  licence: string;
  note: string;
  defaultEnabled: boolean;
  dir: string;
  installed: {
    commit: string;
    ruleFiles: number;
    ruleCount: number;
    licence: string;
    installedAt: number;
  } | null;
  outdated: boolean;
  job: OpengrepRulePackJob | null;
};

export type OpengrepScanRecord = {
  id: string;
  project: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  engine: { version: string; source: 'path' | 'managed' };
  packIds: string[];
  rulePaths: string[];
  targets: string[];
  exitCode: number | null;
  findings: number;
  bySeverity: Record<OpengrepSeverity, number>;
  scannedFiles: number;
  errors: number;
  partiallyParsed: number;
  jsonFile: string;
  update?: { mode: 'full' | 'incremental'; reusedFiles: number; analyzedFiles: number; reason?: string };
};

export type OpengrepStatus = {
  available: boolean;
  engine: { command: string; source: 'path' | 'managed'; version: string } | null;
  managedVersion: string;
  managedInstalled: boolean;
  platformAsset: { asset: string; note?: string } | null;
  installJob: OpengrepInstallJob | null;
  packs: OpengrepRulePackStatus[];
  project?: {
    path: string;
    scanning: boolean;
    runningScan?: { id: string; startedAt: number } | null;
    lastScan: OpengrepScanRecord | null;
  };
};

export type OpengrepScanEnvelope = {
  canonicalProject: string;
  scan: OpengrepScanRecord;
  digest: {
    shown: number;
    total: number;
    bySeverity: Record<OpengrepSeverity, number>;
    rules: number;
    dropped: { belowFloor: number; ignoredRules: number; ignoredFingerprints: number; duplicates: number };
    partiallyParsed: number;
    errors: number;
    bytes: number;
  };
  filter: { severityFloor: OpengrepSeverity; ignoreRuleIds: string[]; ignoreFingerprints: string[] };
  markdown?: string;
};

export type OpengrepGraphFile = {
  path: string;
  severity: OpengrepSeverity | null;
  findings: number;
  incomplete: boolean;
  stale?: boolean;
};

export type OpengrepFinding = {
  nativeIgnored?: boolean;
  triage?: FindingDisposition;
  fingerprint: string; shortFingerprint: string; ruleId: string; severity: OpengrepSeverity;
  message: string; path: string; line: number; endLine: number; col: number; snippet: string;
  category?: string; cwe: string[]; references: string[];
};

export type OpengrepGraphResult = {
  canonicalProject: string;
  scan: OpengrepScanRecord;
  files: OpengrepGraphFile[];
  shown: number;
  errors: number;
  partiallyParsed: number;
  skippedRules: number;
  findings?: OpengrepFinding[];
  allFindings?: OpengrepFinding[];
  bySeverity?: Record<OpengrepSeverity, number>;
  total?: number;
  dropped?: { belowFloor: number; ignoredRules: number; ignoredFingerprints: number; duplicates: number };
  filter?: { severityFloor: OpengrepSeverity; ignoreRuleIds: string[]; ignoreFingerprints: string[] };
  freshness?: { state: 'current' | 'changed' | 'unknown'; changedFiles: number; configurationChanged: boolean; checkedAt: number };
  caveats?: { errors: { kind: string; level: string; message: string; path?: string }[]; partiallyParsed: string[] };
};

export type FindingDisposition = {
  status: 'open' | 'ignored' | 'deferred'; scope: 'local' | 'settings' | 'source';
  reason: string; updatedAt: number; owner?: string; reviewAt?: string; expired?: boolean;
};
export type SecurityRecommendation = {
  findingId: string; action: 'fix' | 'suppress' | 'defer' | 'needs-review';
  confidence: 'high' | 'medium' | 'low'; rationale: string; evidence: string;
  proposedChange: string; checks: string[]; assumptions: string[]; contextFiles: string[];
  group: string; owner?: string; reviewAt?: string; stale?: boolean;
  applied?: { at: number; taskId?: string; action: string };
};
export type SecurityReview = {
  id: string; project: string; scanId: string; harness: 'claude' | 'codex' | 'pi'; piModel?: string;
  status: 'running' | 'done' | 'failed' | 'cancelled'; createdAt: number; finishedAt?: number;
  error?: string; serverId?: string; terminalId?: string; findings: OpengrepFinding[];
  recommendations: SecurityRecommendation[];
};
export type RecommendationSelection = { findingId: string; scope?: 'local' | 'shared'; owner?: string; reviewAt?: string };
export type SecurityApplyPreview = {
  counts: { fixes: number; sharedIgnores: number; localIgnores: number; deferred: number };
  tasks: { title: string; description: string; kind: 'fix' | 'shared-ignore' }[];
  taskIds: string[];
};
