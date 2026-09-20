// Per-project user settings CRUD: GET/PATCH /api/settings (sidebar width,
// harness preference, MCP/Pi per-project enables, etc.). Reads/merges through
// ../../userSettings.ts; a PATCH only touches the fields present in the body.

import { Router } from 'express';
import {
  getUserSettings,
  patchUserSettings,
  type UserSettings,
} from '../../userSettings.js';
import { readProjectParam } from '../projectParam.js';

export function buildUserSettingsRouter(): Router {
  const r = Router();

  r.get('/api/settings', async (req, res) => {
    const project = readProjectParam(req, res, { source: 'query' });
    if (project === null) return;
    res.json(await getUserSettings(project));
  });

  // A relative project here used to CREATE `<backend cwd>/<project>/.lattice/
  // userSettings.json` — readProjectParam refuses it.
  r.patch('/api/settings', async (req, res) => {
    const project = readProjectParam(req, res, { source: 'query' });
    if (project === null) return;
    const partial = (req.body || {}) as Partial<UserSettings>;
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      return res.status(400).json({ error: 'body must be a JSON object of settings' });
    }
    res.json(await patchUserSettings(project, partial));
  });

  return r;
}
