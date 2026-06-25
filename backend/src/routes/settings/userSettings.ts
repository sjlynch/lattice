// Per-project user settings CRUD: GET/PATCH /api/settings (sidebar width,
// harness preference, MCP/Pi per-project enables, etc.). Reads/merges through
// ../../userSettings.ts; a PATCH only touches the fields present in the body.

import { Router } from 'express';
import {
  getUserSettings,
  patchUserSettings,
  type UserSettings,
} from '../../userSettings.js';

export function buildUserSettingsRouter(): Router {
  const r = Router();

  r.get('/api/settings', async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    res.json(await getUserSettings(project));
  });

  r.patch('/api/settings', async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    const partial = (req.body || {}) as Partial<UserSettings>;
    res.json(await patchUserSettings(project, partial));
  });

  return r;
}
