// Public surface of the Opengrep integration. See ./CLAUDE.md.
export {
  OPENGREP_VERSION,
  OPENGREP_RELEASE_TAG,
  OPENGREP_RULE_PACKS,
  findRulePackDef,
  type OpengrepRulePackDef,
  type OpengrepRulePackId,
} from './versions.js';
export { resolveOpengrep, resetOpengrepCache, type OpengrepResolution } from './detect.js';
export {
  startOpengrepInstall,
  getOpengrepInstallJob,
  awaitOpengrepInstall,
  OpengrepInstallError,
  type OpengrepInstallJob,
} from './install.js';
export {
  installRulePack,
  removeRulePack,
  listRulePacks,
  getRulePackJob,
  isRulePackInstalling,
  RulePackError,
  type RulePackStatus,
  type RulePackJob,
} from './rules.js';
export { OpengrepRulesBusyError } from './rulesGate.js';
export {
  runOpengrepScan,
  startOpengrepScan,
  opengrepScanRunState,
  type OpengrepScanRunState,
  listOpengrepScans,
  readOpengrepScan,
  latestOpengrepScan,
  isOpengrepScanRunning,
  isAnyOpengrepScanRunning,
  abortOpengrepScan,
  resolveScanTargets,
  OpengrepBadTargetError,
  OpengrepScanAbortedError,
  OpengrepNotInstalledError,
  OpengrepScanBusyError,
  OpengrepNoRulesError,
  OpengrepScanFailedError,
  type OpengrepScanRecord,
  type OpengrepScanRequest,
} from './scan.js';
export {
  parseOpengrepJson,
  buildDigest,
  renderDigestMarkdown,
  shortFingerprint,
  fingerprintMatches,
  ruleMatches,
  DEFAULT_DIGEST_BUDGET_BYTES,
  type OpengrepDigest,
  type OpengrepFinding,
  type OpengrepSeverity,
  type DigestFilter,
} from './digest.js';
export {
  effectiveOpengrepConfig,
  enabledPackIds,
  sanitizeOpengrepGlobalSettings,
  sanitizeOpengrepProjectSettings,
  type OpengrepGlobalSettings,
  type OpengrepProjectSettings,
  type EffectiveOpengrepConfig,
} from './settings.js';
export {
  getOpengrepStatus,
  scanProjectWithDigest,
  startProjectScanWithDigest,
  digestOfStoredScan,
  loadEffectiveConfig,
  addOpengrepIgnores,
  type OpengrepIgnoreResult,
  type OpengrepStatus,
  type ScanWithDigestResult,
  type DigestRenderContext,
} from './service.js';
export { projectRulesDir, PROJECT_RULES_RELATIVE_DIR, projectScansDir } from './paths.js';
