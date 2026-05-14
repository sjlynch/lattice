import type { HarnessAvailability, HarnessChoice } from '../../harnesses';

export type StartupTerminal = {
  id: string;
  label: string;
  command: string;
};

export type UserSettings = {
  sidebarWidth?: number;
  harness?: HarnessChoice;
  startupTerminals?: StartupTerminal[];
  workflowStepsCollapsed?: Record<string, boolean>;
  // Per-env override of the auto-injected "fresh worktree, don't reinstall"
  // note in task instructions. Key = env id; '' suppresses the note;
  // absent key = use the built-in default. See backend worktree/envDetect.ts.
  worktreeEnvNotes?: Record<string, string>;
};

export type ProjectEnvKind =
  | 'node'
  | 'python'
  | 'rust'
  | 'ruby'
  | 'php'
  | 'go'
  | 'maven'
  | 'gradle'
  | 'dotnet';

export type ProjectEnvInfo = {
  id: ProjectEnvKind;
  label: string;
  heavyDir: string;
  manager: string;
  installCmd: string;
  // The note Lattice would inject by default for this env.
  defaultNote: string;
  // What actually gets injected (user override if set, else defaultNote;
  // '' means the user suppressed it).
  effectiveNote: string;
};

export type ProjectEnvResponse = {
  environments: ProjectEnvInfo[];
};

export type { HarnessAvailability };
