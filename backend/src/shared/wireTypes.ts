// Types that cross the HTTP/WS boundary, re-exported for the frontend
// (`frontend/src/api/types/*` re-export these instead of hand-copying them).
// Type-only: nothing here exists at runtime. Every module these resolve to must
// stay node-free — the frontend type-checks them (`sharedFolderBoundary` test).
export type { Task, TaskStatus } from '../taskCache/types.js';
export type {
  AgentSessionRef,
  AgentSessionSource,
  RestoreDropped,
  RestoreSummary,
  TerminalEndReason,
  TerminalEnded,
  TerminalLaunch,
  TerminalOwner,
  TerminalRecord,
} from '../terminalRegistry/types.js';
export type {
  ProjectGitProbe,
  ProjectGitState,
  ProjectInitPreview,
  ProjectInitResult,
} from '../projectInit/types.js';
export type {
  GitCommit,
  GitCommitChange,
  GitFileStatus,
  GitHistoryResult,
  GitUncommitted,
} from '../gitHistory/types.js';
export type {
  HarnessSystemPromptEditorEntry,
  HarnessSystemPromptKind,
} from '../harnessSystemPrompts/defs.js';
export type {
  InstructionTemplateEditorEntry,
  InstructionTemplateToken,
} from '../instructionTemplates/defs.js';
export type {
  DeadCodeStatus,
  HalsteadMetrics,
  HealthLanguage,
  HealthMetrics,
  HealthSmell,
  HealthSmellId,
  HealthUpdate,
} from '../health/types.js';
export type {
  PostMergeHookEvent,
  PostMergeHookRun,
  PostMergeHookStatus,
} from '../postMergeHooks/types.js';
export type { EnvKind, EnvNoteInfo } from '../worktree/envDetect/catalog.js';
export type {
  MergeRun,
  MergeRunErrorEntry,
  MergeRunEvent,
  MergeRunStatus,
} from '../mergeRuns/types.js';
export type { PushRun, StartPushRunResult } from '../pushRuns/types.js';
export type { QaRun, StartQaRunResult } from '../qaRuns/types.js';
export type { DirEntry, DirListing, DirRoot } from '../fsbrowse/types.js';
export type {
  PiMenuEntry,
  PiModelInfo,
  PiModelsResult,
  PiProvider,
  PiProviderModel,
} from '../piModels/types.js';
export type { CodexModelInfo } from '../codexModels/types.js';
export type { GlobalSettings } from '../globalSettings/types.js';
export type {
  McpHarnessSupport,
  McpRuntime,
  McpSecretRequirement,
  McpServerEntry,
} from '../mcp/types.js';
export type {
  FindingDisposition,
  OpengrepFinding,
  OpengrepGraphFile,
  OpengrepGraphResult,
  OpengrepInstallJob,
  OpengrepProjectSettings,
  OpengrepScanEnvelope,
  OpengrepScanRecord,
  OpengrepSeverity,
  OpengrepStatus,
  RulePackJob,
  RulePackStatus,
  SecurityReview,
  TriageEvent,
} from '../opengrep/types.js';
export type {
  Workflow,
  WorkflowRunHarnessOverride,
  WorkflowStep,
  WorkflowStepHarness,
  WorkflowStepKind,
  WorkflowStepTool,
  WorkflowVariable,
} from '../workflows/types.js';
export type {
  WorkflowRun,
  WorkflowRunEvent,
  WorkflowRunStatus,
  WorkflowStepExecution,
} from '../workflowRuns/types.js';
export type { StartupTerminal, TerminalDefaultHarness, UserSettings } from '../userSettings/types.js';
export type { RecentSpecGap } from '../specGapsTypes.js';
