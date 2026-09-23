// `~/.lattice/per-project/<hash>/run-tests.json` — what the last Run tests step
// saw: `{lastHead, lastFinishedAt}`. Two uses:
//   - the skip rule (D16): a Run tests step whose project HEAD still equals
//     `lastHead` has nothing new to test and advances at once;
//   - the "recently merged tasks" window (R6): tasks that reached QA/Done after
//     `lastFinishedAt`.
// Written only when a Run tests agent finished normally, with the HEAD *at the
// finish* — so the step's own fix commits don't make the next run look like
// something was merged. Home-scoped (never inside the project tree), atomic
// temp→rename, and every read failure degrades to "no state" (= run the tests).

import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../../claudeTrust/configFile.js';
import { homeProjectScratchDir } from '../../projectPath.js';

export const RUN_TESTS_STATE_FILENAME = 'run-tests.json';

export type RunTestsState = {
  lastHead: string;
  lastFinishedAt: number;
};

export function runTestsStateFile(projectPath: string): string {
  return homeProjectScratchDir(projectPath, RUN_TESTS_STATE_FILENAME);
}

export function parseRunTestsState(raw: unknown): RunTestsState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const lastHead = typeof r.lastHead === 'string' && /^[0-9a-f]{7,64}$/i.test(r.lastHead) ? r.lastHead : null;
  const lastFinishedAt = typeof r.lastFinishedAt === 'number' && Number.isFinite(r.lastFinishedAt) ? r.lastFinishedAt : null;
  if (!lastHead || lastFinishedAt === null) return null;
  return { lastHead, lastFinishedAt };
}

export async function readRunTestsState(projectPath: string): Promise<RunTestsState | null> {
  try {
    return parseRunTestsState(JSON.parse(await fs.readFile(runTestsStateFile(projectPath), 'utf8')));
  } catch {
    return null;
  }
}

export async function writeRunTestsState(projectPath: string, state: RunTestsState): Promise<void> {
  const file = runTestsStateFile(projectPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, JSON.stringify(state, null, 2));
}
