// Git setup: preview what a first commit would capture, then create the repo.
//
// Both are POSTs rather than GETs because the `.gitignore` draft the user is
// editing rides in the body — it is multi-line and arbitrarily long, which a
// query string can't carry safely.

import { postJson } from './http';
import type { ProjectInitPreview, ProjectInitResult } from './types';

// `gitignore` is omitted (not sent as undefined) so the backend can tell
// "the user hasn't edited anything, generate the default" apart from
// "the user deliberately emptied it".
function initBody(project: string, gitignore?: string) {
  return gitignore === undefined ? { project } : { project, gitignore };
}

export async function previewProjectInit(
  project: string,
  gitignore?: string,
): Promise<ProjectInitPreview> {
  return postJson<ProjectInitPreview>(
    '/api/project-init/preview',
    initBody(project, gitignore),
  );
}

// Throws an `HttpError` on failure; the dialog branches on `.status === 422`
// (git doesn't know who you are yet) and renders `.detail` — git's own stderr,
// which already names the commands to run.
export async function initProjectGit(
  project: string,
  gitignore?: string,
): Promise<ProjectInitResult> {
  return postJson<ProjectInitResult>(
    '/api/project-init',
    initBody(project, gitignore),
  );
}
