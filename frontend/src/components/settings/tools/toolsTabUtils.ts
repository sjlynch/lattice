import type { OpengrepProjectSettings, OpengrepScanRecord, OpengrepSeverity } from '../../../api';

// Packs whose licence carries a use condition (the Commons Clause forbids
// SELLING a product whose value derives substantially from the rules) get a
// confirmation before the download so the install click is an informed one.
// Lattice's own licence is unaffected either way — the rules are only ever
// downloaded here, never redistributed.
export const needsLicenceAcknowledgement = (licence: string): boolean => /commons clause/i.test(licence);

// Status polling cadence while an install / pack fetch / scan is in flight.
export const POLL_MS = 1500;
export const SEVERITIES: OpengrepSeverity[] = ['ERROR', 'WARNING', 'INFO'];

export type ProjectDraft = {
  severityFloor: OpengrepSeverity;
  ignoreRuleIds: string;
  ignoreFingerprints: string;
  extraRulePaths: string;
  excludeGlobs: string;
  digestBudgetKb: string;
};

export const EMPTY_DRAFT: ProjectDraft = {
  severityFloor: 'WARNING',
  ignoreRuleIds: '',
  ignoreFingerprints: '',
  extraRulePaths: '',
  excludeGlobs: '',
  digestBudgetKb: '60',
};

export function lines(v: string): string[] {
  return [...new Set(v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
}

export function draftFromSettings(s: OpengrepProjectSettings | undefined): ProjectDraft {
  return {
    severityFloor: s?.severityFloor ?? 'WARNING',
    ignoreRuleIds: (s?.ignoreRuleIds ?? []).join('\n'),
    ignoreFingerprints: (s?.ignoreFingerprints ?? []).join('\n'),
    extraRulePaths: (s?.extraRulePaths ?? []).join('\n'),
    excludeGlobs: (s?.excludeGlobs ?? []).join('\n'),
    digestBudgetKb: String(s?.digestBudgetKb ?? 60),
  };
}

export function settingsFromDraft(d: ProjectDraft): OpengrepProjectSettings {
  const kb = Number(d.digestBudgetKb);
  return {
    severityFloor: d.severityFloor,
    ignoreRuleIds: lines(d.ignoreRuleIds),
    ignoreFingerprints: lines(d.ignoreFingerprints),
    extraRulePaths: lines(d.extraRulePaths),
    excludeGlobs: lines(d.excludeGlobs),
    // Same clamp as the backend's read-side sanitizer (8 … 2048 KB).
    digestBudgetKb: Number.isFinite(kb) && kb >= 8 ? Math.min(2048, Math.floor(kb)) : 60,
  };
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function describeScan(s: OpengrepScanRecord): string {
  return (
    `${s.findings} finding${s.findings === 1 ? '' : 's'} ` +
    `(${s.bySeverity.ERROR} ERROR / ${s.bySeverity.WARNING} WARNING / ${s.bySeverity.INFO} INFO) ` +
    `in ${s.scannedFiles} files, ${Math.round(s.durationMs / 1000)}s, ` +
    `${s.packIds.length ? s.packIds.join(' + ') : 'project rules only'}`
  );
}
