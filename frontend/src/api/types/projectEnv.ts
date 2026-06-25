// Types for GET /api/project-env — auto-detected package-manager environments
// and the "fresh worktree, don't reinstall" notes. See backend
// worktree/envDetect.ts.

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
