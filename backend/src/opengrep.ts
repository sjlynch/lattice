// Public surface of the Opengrep integration. See ./opengrep/CLAUDE.md.
export {
  OPENGREP_VERSION,
  OPENGREP_RELEASE_TAG,
  OPENGREP_RULE_PACKS,
  findRulePackDef,
  type OpengrepRulePackDef,
  type OpengrepRulePackId,
} from './opengrep/versions.js';
export { resolveOpengrep, resetOpengrepCache, type OpengrepResolution } from './opengrep/detect.js';
export {
  startOpengrepInstall,
  getOpengrepInstallJob,
  awaitOpengrepInstall,
  OpengrepInstallError,
  type OpengrepInstallJob,
} from './opengrep/install.js';
export {
  installRulePack,
  removeRulePack,
  listRulePacks,
  getRulePackJob,
  isRulePackInstalling,
  RulePackError,
  type RulePackStatus,
  type RulePackJob,
} from './opengrep/rules.js';
export { OpengrepRulesBusyError } from './opengrep/rulesGate.js';
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
  cancelOpengrepScan,
  resolveScanTargets,
  OpengrepBadTargetError,
  OpengrepScanAbortedError,
  OpengrepNotInstalledError,
  OpengrepScanBusyError,
  OpengrepNoRulesError,
  OpengrepScanFailedError,
  type OpengrepScanRecord,
  type OpengrepScanRequest,
} from './opengrep/scan.js';
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
} from './opengrep/digest.js';
export {
  effectiveOpengrepConfig,
  enabledPackIds,
  sanitizeOpengrepGlobalSettings,
  sanitizeOpengrepProjectSettings,
  type OpengrepGlobalSettings,
  type OpengrepProjectSettings,
  type EffectiveOpengrepConfig,
} from './opengrep/settings.js';
export {
  getOpengrepStatus,
  scanProjectWithDigest,
  startProjectScanWithDigest,
  digestOfStoredScan,
  graphOfStoredScan,
  loadEffectiveConfig,
  addOpengrepIgnores,
  type OpengrepIgnoreResult,
  type OpengrepStatus,
  type ScanWithDigestResult,
  type DigestRenderContext,
} from './opengrep/service.js';
export { projectRulesDir, PROJECT_RULES_RELATIVE_DIR, projectScansDir } from './opengrep/paths.js';
