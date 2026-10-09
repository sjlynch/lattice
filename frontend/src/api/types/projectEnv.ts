// Types for GET /api/project-env — auto-detected package-manager environments
// and the "fresh worktree, don't reinstall" notes. Each entry is the backend's
// own `EnvNoteInfo` (backend/src/worktree/envDetect/catalog.ts, re-exported
// through backend/src/shared/wireTypes.ts): `defaultNote` is what Lattice
// injects by default; `effectiveNote` is the user override if set, else the
// default ('' means the user suppressed it).
import type { EnvNoteInfo } from '../../../../backend/src/shared/wireTypes';

export type ProjectEnvInfo = EnvNoteInfo;

export type ProjectEnvResponse = {
  environments: ProjectEnvInfo[];
};
