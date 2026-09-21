// Opengrep (SAST) integration — engine status / install, rule packs, and
// project scans. Backend: src/routes/opengrep.ts over src/opengrep/.

import { asJson, deleteJson, postJson } from './http';
import type { OpengrepSeverity } from './types';

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
  project?: { path: string; scanning: boolean; lastScan: OpengrepScanRecord | null };
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

export async function fetchOpengrepStatus(project?: string): Promise<OpengrepStatus> {
  const q = project ? `?project=${encodeURIComponent(project)}` : '';
  return asJson<OpengrepStatus>(await fetch(`/api/opengrep/status${q}`));
}

export async function startOpengrepInstall(): Promise<{ job: OpengrepInstallJob }> {
  return postJson<{ job: OpengrepInstallJob }>('/api/opengrep/install');
}

export async function installOpengrepRulePack(
  packId: string,
): Promise<{ packs: OpengrepRulePackStatus[] }> {
  return postJson<{ packs: OpengrepRulePackStatus[] }>('/api/opengrep/rules/install', { packId });
}

export async function removeOpengrepRulePack(
  packId: string,
): Promise<{ packs: OpengrepRulePackStatus[] }> {
  return deleteJson<{ packs: OpengrepRulePackStatus[] }>(
    `/api/opengrep/rules/${encodeURIComponent(packId)}`,
  );
}

// Runs a scan with the project's configured packs + filter. Throws an
// `HttpError` with `.code` `busy` / `not-installed` / `no-rules` on a 409.
export async function runOpengrepScan(
  project: string,
  opts: { targets?: string[]; includeMarkdown?: boolean } = {},
): Promise<OpengrepScanEnvelope> {
  return postJson<OpengrepScanEnvelope>('/api/opengrep/scan', { project, ...opts });
}

export async function fetchOpengrepScans(project: string): Promise<OpengrepScanRecord[]> {
  const r = await asJson<{ scans: OpengrepScanRecord[] }>(
    await fetch(`/api/opengrep/scans?project=${encodeURIComponent(project)}`),
  );
  return r.scans ?? [];
}

// The digest markdown of a stored scan (`latest` allowed), optionally narrowed.
export async function fetchOpengrepDigest(
  project: string,
  id = 'latest',
  opts: { rule?: string; file?: string; severity?: OpengrepSeverity; budgetKb?: number } = {},
): Promise<string> {
  const params = new URLSearchParams({ project, format: 'md' });
  if (opts.rule) params.set('rule', opts.rule);
  if (opts.file) params.set('file', opts.file);
  if (opts.severity) params.set('severity', opts.severity);
  if (opts.budgetKb) params.set('budgetKb', String(opts.budgetKb));
  const r = await fetch(`/api/opengrep/scans/${encodeURIComponent(id)}?${params.toString()}`);
  if (!r.ok) {
    // Reuse asJson's error extraction for the JSON error envelope.
    await asJson<never>(r);
  }
  return r.text();
}
