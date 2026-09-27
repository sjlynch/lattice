// Per-project user settings CRUD: GET/PATCH /api/settings (sidebar width,
// harness preference, MCP/Pi per-project enables, etc.). Reads/merges through
// ../../userSettings.ts; a PATCH only touches the fields present in the body.

import { Router } from 'express';
import {
  getUserSettings,
  patchUserSettings,
  userSettingsShapeError,
  type UserSettings,
} from '../../userSettings.js';
import { readProjectParam, requireExistingProjectDir } from '../projectParam.js';

export function buildUserSettingsRouter(): Router {
  const r = Router();

  r.get('/api/settings', async (req, res) => {
    const project = readProjectParam(req, res, { source: 'query' });
    if (project === null) return;
    res.json(await getUserSettings(project));
  });

  // A relative project here used to CREATE `<backend cwd>/<project>/.lattice/
  // userSettings.json` — readProjectParam refuses it. An absolute one that
  // doesn't exist (a typo, or a UI tab still open on a deleted project) would
  // `mkdir -p` the folder back into being — refused before any validation or
  // write. A malformed value for a field consumers take on trust (e.g.
  // `deadCodeEntryGlobs: "src/**"`, which broke /api/scan) is a 400 rather
  // than silently healed, so the caller learns about the mistake.
  r.patch('/api/settings', async (req, res) => {
    const project = readProjectParam(req, res, { source: 'query' });
    if (project === null) return;
    if (!(await requireExistingProjectDir(project, res))) return;
    const partial = (req.body || {}) as Partial<UserSettings>;
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      return res.status(400).json({ error: 'body must be a JSON object of settings' });
    }
    const shapeError = userSettingsShapeError(partial as Record<string, unknown>);
    if (shapeError) return res.status(400).json({ error: shapeError });
    res.json(await patchUserSettings(project, partial));
  });

  return r;
}
