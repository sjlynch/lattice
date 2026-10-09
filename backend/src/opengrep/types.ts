// The Opengrep wire types: what the routes and the status/graph/review
// payloads carry. Types only, and node-free — `frontend/src/api/types/
// opengrep.ts` re-exports them through `../shared/wireTypes.ts`, and the
// frontend type-checks every module reachable from there. Every other module
// in this folder imports node, so each declaration lives HERE and its original
// module re-exports it (`export type { … } from './types.js'`); backend
// importers keep their old paths. Never import a non-type module from here.

import type { AgentHarness } from '../shared/harnesses.js';

// ── Engine + install (detect.ts, platform.ts, versions.ts, install.ts) ─────

export type OpengrepSource = 'path' | 'managed';

export type OpengrepResolution = {
  // Absolute path (or the bare name for a PATH hit that `where`/`which` could
  // not resolve to a file) to spawn with `shell: false`.
  command: string;
  source: OpengrepSource;
  version: string;
};

// The release assets Lattice knows how to install. `OPENGREP_ASSETS` in
// versions.ts is a `Record` over this union, so the two cannot drift.
export type OpengrepAssetName =
  | 'opengrep_windows_x86.exe'
  | 'opengrep_manylinux_x86'
  | 'opengrep_manylinux_aarch64'
  | 'opengrep_musllinux_x86'
  | 'opengrep_musllinux_aarch64'
  | 'opengrep_osx_x86'
  | 'opengrep_osx_arm64';

export type AssetChoice = {
  asset: OpengrepAssetName;
  // Shown on the Settings card when the choice is a fallback the user should
  // know about (Windows on ARM runs the x64 build under emulation).
  note?: string;
};

export type OpengrepInstallPhase = 'downloading' | 'verifying' | 'checking';

export type OpengrepInstallJob = {
  status: 'running' | 'done' | 'failed';
  phase: OpengrepInstallPhase;
  version: string;
  asset: string;
  note?: string;
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
};

// ── Rule packs (versions.ts, state.ts, rules.ts) ───────────────────────────

export type OpengrepRulePackId = 'qodana-mit' | 'opengrep-archived';

export type OpengrepRulePackDef = {
  id: OpengrepRulePackId;
  label: string;
  // git clone URL. Fetched with `git fetch --depth 1 origin <commit>` — a
  // commit is content-addressed, so checking it out verifies the tree by
  // construction (no tarball digest to pin, and tarball bytes drift anyway).
  repo: string;
  homepage: string;
  commit: string;
  // The licence the KEPT files carry after pruning.
  licence: string;
  // One-line note shown beside the pack in Settings; states any condition the
  // user should know before enabling (Commons Clause, archived, …).
  note: string;
  // Enabled for scans by default. A user can still turn a default pack off.
  defaultEnabled: boolean;
  // Top-level paths (relative to the pack root, forward slashes) removed after
  // checkout. Everything that is not a `*.yaml`/`*.yml` rule file is removed
  // regardless (test sources, CI config, scripts) — see rules.ts `prunePackTree`.
  prune: string[];
};

export type OpengrepPackState = {
  commit: string;
  // Rule FILES kept after pruning, and the `- id:` entries counted in them.
  ruleFiles: number;
  ruleCount: number;
  licence: string;
  installedAt: number;
};

export type RulePackJob = {
  status: 'running' | 'done' | 'failed';
  packId: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
};

export type RulePackStatus = OpengrepRulePackDef & {
  dir: string;
  installed: OpengrepPackState | null;
  // True when the installed commit differs from the pinned one (a Lattice
  // upgrade moved the pin) — the Settings card offers "Update".
  outdated: boolean;
  job: RulePackJob | null;
};

// ── Findings, triage, filter (parseOutput.ts, triage.ts, digest.ts) ────────

export type OpengrepSeverity = 'ERROR' | 'WARNING' | 'INFO';

export type FindingDisposition = {
  status: 'open' | 'ignored' | 'deferred';
  scope: 'local' | 'settings' | 'source';
  reason: string;
  updatedAt: number;
  owner?: string;
  reviewAt?: string;
  expired?: boolean;
};

// One local triage decision (`POST /api/opengrep/triage` answers it; `GET`
// lists the history).
export type TriageEvent = FindingDisposition & { fingerprint: string; path: string; ruleId: string };

export type OpengrepFinding = {
  nativeIgnored?: boolean;
  triage?: FindingDisposition;
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

export type DigestFilter = {
  severityFloor: OpengrepSeverity;
  ignoreRuleIds: string[];
  ignoreFingerprints: string[];
};

// What the digest filter dropped, per reason.
export type OpengrepDigestDropped = { belowFloor: number; ignoredRules: number; ignoredFingerprints: number; duplicates: number };

// Per-project `userSettings.opengrep` (settings.ts sanitizes it on read).
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

// ── Scans (scanRecords.ts, service.ts, graph.ts, routes/opengrep.ts) ───────

export type OpengrepScanRecord = {
  id: string;
  project: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  engine: { version: string; source: OpengrepSource };
  packIds: string[];
  rulePaths: string[];
  targets: string[];
  exitCode: number | null;
  // RAW (unfiltered) counts, so the Settings summary and the digest agree on
  // what the engine saw regardless of the project's filter.
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
  engine: OpengrepResolution | null;
  managedVersion: string;
  managedInstalled: boolean;
  platformAsset: AssetChoice | null;
  installJob: OpengrepInstallJob | null;
  packs: RulePackStatus[];
  // Present when `project` was given: is a scan running, and the last one.
  project?: {
    path: string;
    scanning: boolean;
    runningScan: { id: string; startedAt: number } | null;
    lastScan: OpengrepScanRecord | null;
  };
};

// A finished scan's JSON answer (`POST /scan`, `GET /scans/:id`): the record,
// the digest's counts and, when asked for, its markdown.
export type OpengrepScanEnvelope = {
  canonicalProject: string;
  scan: OpengrepScanRecord;
  digest: {
    shown: number;
    total: number;
    bySeverity: Record<OpengrepSeverity, number>;
    rules: number;
    dropped: OpengrepDigestDropped;
    partiallyParsed: number;
    errors: number;
    bytes: number;
  };
  filter: DigestFilter;
  markdown?: string;
};

export type OpengrepGraphFile = {
  path: string;
  severity: OpengrepSeverity | null;
  findings: number;
  incomplete: boolean;
  stale?: boolean;
};

// `buildOpengrepGraph`'s result: complete filtered per-file colors + coverage.
export type OpengrepGraph = {
  canonicalProject: string;
  scan: OpengrepScanRecord;
  files: OpengrepGraphFile[];
  shown: number;
  errors: number;
  partiallyParsed: number;
  skippedRules: number;
  findings: OpengrepFinding[];
  allFindings: OpengrepFinding[];
  bySeverity: Record<OpengrepSeverity, number>;
  total: number;
  dropped: OpengrepDigestDropped;
  filter: DigestFilter;
  caveats: { errors: OpengrepRunError[]; partiallyParsed: string[] };
};

export type OpengrepScanFreshness = {
  state: 'current' | 'changed' | 'unknown';
  changedFiles: number;
  configurationChanged: boolean;
  checkedAt: number;
};

// `GET /api/opengrep/scans/:id?format=graph`.
export type OpengrepGraphResult = OpengrepGraph & { freshness: OpengrepScanFreshness };

// ── Security reviews (reviewStore.ts, review.ts) ───────────────────────────

// Conversation content belongs to the harness, not a second report in Lattice.
export type ReviewRun = {
  id: string; project: string; scanId: string; harness: AgentHarness; piModel?: string;
  status: 'running' | 'awaiting-decision' | 'closed' | 'failed' | 'cancelled';
  createdAt: number; updatedAt: number; lastTurnAt?: number; finishedAt?: number;
  findingCount: number; serverId?: string; terminalId?: string; error?: string;
};

// `GET /api/opengrep/reviews`: an active run also carries its console's state.
export type SecurityReview = ReviewRun & { consoleAvailable?: boolean; restoring?: boolean; needsRestore?: boolean };
