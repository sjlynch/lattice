// The facade the routes, the MCP tools and the workflow-step pre-run hook
// call: status snapshot, "scan this project with its configured packs and
// filter", and "render the digest for an existing scan". Everything below it
// (detect / install / rules / scan / digest) is independently testable; this
// file only wires settings into them.

import { getGlobalSettings } from '../globalSettings.js';
import { canonicalProjectPath } from '../projectPath.js';
import { runExclusive } from '../serializeWrites.js';
import { getUserSettings, patchUserSettings } from '../userSettings.js';
import { resolveOpengrep, type OpengrepResolution } from './detect.js';
import {
  buildDigest,
  renderDigestMarkdown,
  type DigestFilter,
  type OpengrepDigest,
  type ParsedOpengrepOutput,
} from './digest.js';
import { getOpengrepInstallJob, type OpengrepInstallJob } from './install.js';
import { chooseAssetForThisMachine, type AssetChoice } from './platform.js';
import { listRulePacks, type RulePackStatus } from './rules.js';
import {
  isOpengrepScanRunning,
  latestOpengrepScan,
  readOpengrepScan,
  runOpengrepScan,
  type OpengrepScanRecord,
} from './scan.js';
import {
  effectiveOpengrepConfig,
  sanitizeOpengrepProjectSettings,
  type EffectiveOpengrepConfig,
} from './settings.js';
import { readOpengrepState } from './state.js';
import { OPENGREP_VERSION } from './versions.js';

export type OpengrepStatus = {
  available: boolean;
  engine: OpengrepResolution | null;
  managedVersion: string;
  managedInstalled: boolean;
  platformAsset: AssetChoice | null;
  installJob: OpengrepInstallJob | null;
  packs: RulePackStatus[];
  // Present when `project` was given: is a scan running, and the last one.
  project?: { path: string; scanning: boolean; lastScan: OpengrepScanRecord | null };
};

export async function getOpengrepStatus(project?: string): Promise<OpengrepStatus> {
  const [engine, state, packs, platformAsset] = await Promise.all([
    resolveOpengrep(),
    readOpengrepState(),
    listRulePacks(),
    chooseAssetForThisMachine(),
  ]);
  const status: OpengrepStatus = {
    available: !!engine,
    engine,
    managedVersion: OPENGREP_VERSION,
    managedInstalled: state.binary?.version === OPENGREP_VERSION,
    platformAsset,
    installJob: getOpengrepInstallJob(),
    packs,
  };
  if (project) {
    const canonical = canonicalProjectPath(project);
    status.project = {
      path: canonical,
      scanning: isOpengrepScanRunning(canonical),
      lastScan: await latestOpengrepScan(canonical),
    };
  }
  return status;
}

export async function loadEffectiveConfig(project: string): Promise<EffectiveOpengrepConfig> {
  const [global, user] = await Promise.all([getGlobalSettings(), getUserSettings(project)]);
  return effectiveOpengrepConfig(global.opengrep, user.opengrep);
}

export type ScanWithDigestResult = {
  record: OpengrepScanRecord;
  digest: OpengrepDigest;
  markdown: string;
  config: EffectiveOpengrepConfig;
};

export type DigestRenderContext = {
  title?: string;
  drillDownHint?: string;
  // Override the project's filter / budget (the API's `?severity=` etc.).
  filter?: Partial<DigestFilter>;
  budgetBytes?: number;
  // Restrict to one rule (drill-down). Matches like ignoreRuleIds does.
  rule?: string;
  // Restrict to one file (project-relative, forward slashes).
  file?: string;
};

export function digestFor(
  parsed: ParsedOpengrepOutput,
  record: OpengrepScanRecord,
  config: EffectiveOpengrepConfig,
  ctx: DigestRenderContext = {},
): { digest: OpengrepDigest; markdown: string } {
  const filter: DigestFilter = { ...config.filter, ...(ctx.filter ?? {}) };
  let scoped = parsed;
  if (ctx.rule || ctx.file) {
    const rule = ctx.rule;
    // Findings carry project-relative forward-slash paths; accept the same
    // path spelled with backslashes, a leading `./` or a trailing `/`.
    const file = ctx.file
      ?.replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/\/+$/, '');
    scoped = {
      ...parsed,
      findings: parsed.findings.filter(
        (f) =>
          (!rule || f.ruleId === rule || f.ruleId.endsWith(`.${rule}`)) &&
          (!file || f.path === file || f.path.startsWith(`${file}/`)),
      ),
    };
  }
  const digest = buildDigest(scoped, filter);
  const markdown = renderDigestMarkdown(digest, {
    budgetBytes: ctx.budgetBytes ?? config.budgetBytes,
    title: ctx.title,
    drillDownHint: ctx.drillDownHint,
    projectPath: record.project,
    scanId: record.id,
    scannedAt: record.startedAt,
    filter,
  });
  return { digest, markdown };
}

// Scan with the project's effective configuration and render its digest.
export async function scanProjectWithDigest(
  project: string,
  opts: { targets?: string[]; timeoutMs?: number; render?: DigestRenderContext } = {},
): Promise<ScanWithDigestResult> {
  const canonical = canonicalProjectPath(project);
  const config = await loadEffectiveConfig(canonical);
  const record = await runOpengrepScan({
    project: canonical,
    packIds: config.packIds,
    extraRulePaths: config.extraRulePaths,
    excludeGlobs: config.excludeGlobs,
    targets: opts.targets,
    timeoutMs: opts.timeoutMs,
  });
  const stored = await readOpengrepScan(canonical, record.id);
  if (!stored) throw new Error(`scan ${record.id} was not stored`);
  const { digest, markdown } = digestFor(stored.parsed, record, config, opts.render);
  return { record, digest, markdown, config };
}

// Digest of a stored scan (latest when `id` is omitted).
export async function digestOfStoredScan(
  project: string,
  id: string | undefined,
  ctx: DigestRenderContext = {},
): Promise<ScanWithDigestResult | null> {
  const canonical = canonicalProjectPath(project);
  const targetId = id ?? (await latestOpengrepScan(canonical))?.id;
  if (!targetId) return null;
  const stored = await readOpengrepScan(canonical, targetId);
  if (!stored) return null;
  const config = await loadEffectiveConfig(canonical);
  const { digest, markdown } = digestFor(stored.parsed, stored.record, config, ctx);
  return { record: stored.record, digest, markdown, config };
}

export type OpengrepIgnoreResult = {
  canonicalProject: string;
  added: { ruleIds: string[]; fingerprints: string[] };
  ignoreRuleIds: string[];
  ignoreFingerprints: string[];
};

// Append rule ids / fingerprints to the project's ignore lists
// (`userSettings.opengrep`). This is the one Lattice-settings write an agent
// may make from a planning step: a rule that is pure noise for a codebase is a
// settings fact, not a task for a human, and filing "please add X to the
// ignore list" tickets just moves the click. Deduplicated; never removes.
export async function addOpengrepIgnores(
  project: string,
  add: { ruleIds?: string[]; fingerprints?: string[] },
): Promise<OpengrepIgnoreResult> {
  const canonical = canonicalProjectPath(project);
  const clean = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean) : [];
  // Accept the task-marker spelling too (`opengrep:<fp>`).
  const fps = [...new Set(clean(add.fingerprints).map((f) => f.replace(/^opengrep:/i, '').trim()).filter(Boolean))];
  const rules = [...new Set(clean(add.ruleIds))];
  // The read → merge → write below is serialized per project: a planning agent
  // that fires several `opengrep_ignore` calls in a row (one per rule group)
  // must not have the later write clobber the earlier one.
  return runExclusive(`opengrep-ignore:${canonical}`, async () => {
    const current = sanitizeOpengrepProjectSettings((await getUserSettings(canonical)).opengrep);
    const ruleSet = new Set(current.ignoreRuleIds ?? []);
    const fpSet = new Set(current.ignoreFingerprints ?? []);
    const addedRules = rules.filter((r) => !ruleSet.has(r));
    const addedFps = fps.filter((f) => !fpSet.has(f));
    for (const r of addedRules) ruleSet.add(r);
    for (const f of addedFps) fpSet.add(f);
    if (addedRules.length || addedFps.length) {
      await patchUserSettings(canonical, {
        opengrep: { ...current, ignoreRuleIds: [...ruleSet], ignoreFingerprints: [...fpSet] },
      });
    }
    return {
      canonicalProject: canonical,
      added: { ruleIds: addedRules, fingerprints: addedFps },
      ignoreRuleIds: [...ruleSet],
      ignoreFingerprints: [...fpSet],
    };
  });
}
