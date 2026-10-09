// Git-setup types: the probe behind the navbar chip and the preview/init pair
// behind the "Set up Git" dialog (`GET /api/git-check`,
// `POST /api/project-init/preview`, `POST /api/project-init`). The shapes are
// the backend's own (backend/src/projectInit/types.ts, re-exported through
// backend/src/shared/wireTypes.ts).
import type { ProjectInitResult as BackendProjectInitResult } from '../../../../backend/src/shared/wireTypes';

export type {
  ProjectGitProbe,
  ProjectGitState,
  ProjectInitPreview,
} from '../../../../backend/src/shared/wireTypes';

// The route adds `ok: true` around the init result (routes/projectInit.ts).
export type ProjectInitResult = { ok: true } & BackendProjectInitResult;
