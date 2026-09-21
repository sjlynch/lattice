// The Opengrep settings shapes (machine-global + per-project) and the one
// function that turns them into an effective scan configuration.
//
//   globalSettings.opengrep  — which rule packs are enabled (machine-wide, as
//                              the packs themselves are installed once per
//                              machine under ~/.lattice/opengrep/rules/).
//   userSettings.opengrep    — per-project: extra rule paths, exclude globs,
//                              the severity floor and the ignore lists that
//                              shape the digest, and its byte budget.
//
// Both are validated defensively on READ here (a corrupt value degrades to the
// default) — the PATCH routes store what they are given, like the rest of the
// settings files.

import type { DigestFilter, OpengrepSeverity } from './digest.js';
import { DEFAULT_DIGEST_BUDGET_BYTES } from './digest.js';
import { OPENGREP_RULE_PACKS } from './versions.js';

export type OpengrepGlobalSettings = {
  // Per-pack enable override, keyed by pack id. Absent = the pack's
  // `defaultEnabled`.
  packs?: Record<string, boolean>;
};

export type OpengrepProjectSettings = {
  extraRulePaths?: string[];
  excludeGlobs?: string[];
  severityFloor?: OpengrepSeverity;
  // Full check ids or any dot-suffix (`xss.foo`, `foo`).
  ignoreRuleIds?: string[];
  // Full or short fingerprints (see digest.ts).
  ignoreFingerprints?: string[];
  // Digest size ceiling in KB (default 60).
  digestBudgetKb?: number;
};

export type EffectiveOpengrepConfig = {
  packIds: string[];
  extraRulePaths: string[];
  excludeGlobs: string[];
  filter: DigestFilter;
  budgetBytes: number;
};

const SEVERITIES = new Set<OpengrepSeverity>(['ERROR', 'WARNING', 'INFO']);

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean))];
}

export function sanitizeOpengrepGlobalSettings(raw: unknown): OpengrepGlobalSettings {
  const out: OpengrepGlobalSettings = {};
  const r = (raw && typeof raw === 'object' ? raw : {}) as OpengrepGlobalSettings;
  if (r.packs && typeof r.packs === 'object') {
    const packs: Record<string, boolean> = {};
    for (const [id, on] of Object.entries(r.packs)) {
      if (typeof on === 'boolean' && OPENGREP_RULE_PACKS.some((p) => p.id === id)) packs[id] = on;
    }
    out.packs = packs;
  }
  return out;
}

export function sanitizeOpengrepProjectSettings(raw: unknown): OpengrepProjectSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as OpengrepProjectSettings;
  const out: OpengrepProjectSettings = {};
  if (r.extraRulePaths !== undefined) out.extraRulePaths = stringArray(r.extraRulePaths);
  if (r.excludeGlobs !== undefined) out.excludeGlobs = stringArray(r.excludeGlobs);
  if (typeof r.severityFloor === 'string' && SEVERITIES.has(r.severityFloor.toUpperCase() as OpengrepSeverity)) {
    out.severityFloor = r.severityFloor.toUpperCase() as OpengrepSeverity;
  }
  if (r.ignoreRuleIds !== undefined) out.ignoreRuleIds = stringArray(r.ignoreRuleIds);
  if (r.ignoreFingerprints !== undefined) out.ignoreFingerprints = stringArray(r.ignoreFingerprints);
  if (typeof r.digestBudgetKb === 'number' && Number.isFinite(r.digestBudgetKb) && r.digestBudgetKb >= 8) {
    out.digestBudgetKb = Math.min(2048, Math.floor(r.digestBudgetKb));
  }
  return out;
}

// Which packs a scan uses: every pack whose override (or default) is on. The
// scan itself drops packs that are not installed and reports what it used.
export function enabledPackIds(global: OpengrepGlobalSettings | undefined): string[] {
  const overrides = sanitizeOpengrepGlobalSettings(global).packs ?? {};
  return OPENGREP_RULE_PACKS.filter((p) => overrides[p.id] ?? p.defaultEnabled).map((p) => p.id);
}

export function effectiveOpengrepConfig(
  global: OpengrepGlobalSettings | undefined,
  project: OpengrepProjectSettings | undefined,
): EffectiveOpengrepConfig {
  const p = sanitizeOpengrepProjectSettings(project);
  return {
    packIds: enabledPackIds(global),
    extraRulePaths: p.extraRulePaths ?? [],
    excludeGlobs: p.excludeGlobs ?? [],
    filter: {
      severityFloor: p.severityFloor ?? 'WARNING',
      ignoreRuleIds: p.ignoreRuleIds ?? [],
      ignoreFingerprints: p.ignoreFingerprints ?? [],
    },
    budgetBytes: (p.digestBudgetKb ?? DEFAULT_DIGEST_BUDGET_BYTES / 1024) * 1024,
  };
}
