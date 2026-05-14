import fs from 'node:fs/promises';
import path from 'node:path';
import { renderPushInstructions } from './instructions.js';
import { assertSafePushSessionPath, createPushSessionId } from './paths.js';
import { installPushStopHook } from './stopHook.js';
import type { PushSession } from './types.js';

// Materialize the per-session directory in home-scoped scratch: writes the
// instructions brief and installs the Stop hook so Claude calls
// /api/push-runs/:id/done on stop.
export async function setupPushSession(
  projectPath: string,
  backendOrigin: string,
): Promise<PushSession> {
  const id = createPushSessionId();
  const cwd = assertSafePushSessionPath(projectPath, id);
  await fs.mkdir(cwd, { recursive: true });

  await installPushStopHook(cwd, id, backendOrigin);

  const instructionsFile = path.join(cwd, 'PUSH_INSTRUCTIONS.md');
  await fs.writeFile(instructionsFile, renderPushInstructions(projectPath), 'utf8');

  return { id, cwd, instructionsFile };
}
