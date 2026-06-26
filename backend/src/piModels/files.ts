import fs from 'node:fs/promises';
import path from 'node:path';
import { piAgentDir } from './config.js';
import type { ModelsJson } from './types.js';

export async function readModelsJson(): Promise<ModelsJson | null> {
  try {
    const raw = await fs.readFile(path.join(piAgentDir(), 'models.json'), 'utf8');
    return JSON.parse(raw) as ModelsJson;
  } catch {
    return null;
  }
}

export async function readDefaultPattern(): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(piAgentDir(), 'settings.json'), 'utf8');
    const s = JSON.parse(raw) as {
      defaultProvider?: string;
      defaultModel?: string;
    };
    if (s.defaultProvider && s.defaultModel) {
      return `${s.defaultProvider}/${s.defaultModel}`;
    }
    return null;
  } catch {
    return null;
  }
}
