// Codex models for the model dropdowns, read from the Codex CLI's own catalog
// cache (`$CODEX_HOME/models_cache.json`, default `~/.codex`), which the CLI
// refreshes itself. Read-only — Lattice never writes Codex's files. Only
// entries Codex lists in its own picker (`visibility: "list"`) are offered;
// an absent or unrecognized cache yields an empty list (the select then shows
// only "default" plus any model a step was saved with).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CodexModelInfo } from './codexModels/types.js';

export function parseCodexModelsCache(raw: unknown): CodexModelInfo[] {
  const models = (raw as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  const out: CodexModelInfo[] = [];
  for (const m of models as Array<Record<string, unknown>>) {
    if (!m || typeof m.slug !== 'string' || m.visibility !== 'list') continue;
    const efforts = Array.isArray(m.supported_reasoning_levels)
      ? (m.supported_reasoning_levels as Array<{ effort?: unknown }>)
          .map((l) => l?.effort)
          .filter((e): e is string => typeof e === 'string')
      : [];
    out.push({
      id: m.slug,
      displayName: typeof m.display_name === 'string' ? m.display_name : m.slug,
      description: typeof m.description === 'string' ? m.description : '',
      efforts,
      ...(typeof m.default_reasoning_level === 'string' ? { defaultEffort: m.default_reasoning_level } : {}),
    });
  }
  return out;
}

export async function listCodexModels(
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
): Promise<CodexModelInfo[]> {
  try {
    return parseCodexModelsCache(JSON.parse(await fs.readFile(path.join(codexHome, 'models_cache.json'), 'utf8')));
  } catch {
    return [];
  }
}
