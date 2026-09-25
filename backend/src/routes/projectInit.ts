// "Set up Git" — the preview + init pair behind the navbar chip, the
// first-task-create interception, and the folder picker's "initialize a repo"
// checkbox. See `projectInit/CLAUDE.md`.

import { Router, type Response } from 'express';
import { promises as fs } from 'node:fs';
import { canonicalProjectPath, isRealAbsoluteProjectPath } from '../projectPath.js';
import {
  initProjectGit,
  previewProjectInit,
  ProjectInitError,
  type ProjectInitErrorCode,
} from '../projectInit/index.js';
import { relativeProjectError } from './projectParam.js';

const STATUS_FOR_CODE: Record<ProjectInitErrorCode, number> = {
  'not-initable': 409,
  'git-identity-missing': 422,
  'git-failed': 500,
  'git-unavailable': 503,
};

type ProjectInitBody = { project?: unknown; gitignore?: unknown };

function readGitignore(body: ProjectInitBody): string | undefined {
  return typeof body.gitignore === 'string' ? body.gitignore : undefined;
}

// A malformed `project` is a bad request, not an init outcome — it never
// reaches the coded 409/422/500/503 space.
function readProject(body: ProjectInitBody, res: Response): string | null {
  const raw = typeof body.project === 'string' ? body.project.trim() : '';
  if (!raw) {
    res.status(400).json({ error: 'project required' });
    return null;
  }
  if (!isRealAbsoluteProjectPath(raw)) {
    // Same message as every other project-scoped route: it names the likely
    // cause (shell-stripped backslashes), which this one used to omit.
    res.status(400).json({ error: relativeProjectError(raw) });
    return null;
  }
  return canonicalProjectPath(raw);
}

function sendInitError(res: Response, err: unknown): void {
  if (err instanceof ProjectInitError) {
    res
      .status(STATUS_FOR_CODE[err.code])
      .json({ error: err.message, code: err.code, detail: err.detail });
    return;
  }
  res.status(500).json({
    error: (err as Error).message || 'project init failed',
    code: 'git-failed' satisfies ProjectInitErrorCode,
  });
}

export function buildProjectInitRouter(): Router {
  const r = Router();

  // Called on dialog open and again (debounced) on every `.gitignore` edit —
  // watching the file count drop is the reason the textarea is editable.
  r.post('/api/project-init/preview', async (req, res) => {
    const body = (req.body || {}) as ProjectInitBody;
    const project = readProject(body, res);
    if (!project) return;

    try {
      const st = await fs.stat(project);
      if (!st.isDirectory()) {
        return res.status(400).json({ error: `project is not a directory: ${project}` });
      }
    } catch {
      return res.status(400).json({ error: `project path does not exist: ${project}` });
    }

    res.json(await previewProjectInit(project, readGitignore(body)));
  });

  r.post('/api/project-init', async (req, res) => {
    const body = (req.body || {}) as ProjectInitBody;
    const project = readProject(body, res);
    if (!project) return;

    try {
      const result = await initProjectGit(project, { gitignore: readGitignore(body) });
      res.json({ ok: true, ...result });
    } catch (err) {
      sendInitError(res, err);
    }
  });

  return r;
}
