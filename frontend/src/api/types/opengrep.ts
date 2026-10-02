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
};

export type OpengrepGraphResult = {
  canonicalProject: string;
  scan: OpengrepScanRecord;
  files: OpengrepGraphFile[];
  shown: number;
  errors: number;
  partiallyParsed: number;
  skippedRules: number;
};
