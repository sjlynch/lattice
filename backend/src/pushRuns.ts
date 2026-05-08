// Push runs: small registry of one-off "push to remote" Claude sessions.
//
// A push run owns a temp directory under `<project>/.lattice/push/<id>/`
// containing a `PUSH_INSTRUCTIONS.md` brief and a `.claude/settings.local.json`
// Stop hook. The hook calls back to `/api/push-runs/:id/done` which marks
// the run done so the frontend can auto-close the terminal.

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

export type PushRun = {
  id: string;
  projectPath: string;
  cwd: string;
  status: 'running' | 'done';
  createdAt: number;
  doneAt?: number;
};

const runs = new Map<string, PushRun>();

export function getPushRun(id: string): PushRun | undefined {
  return runs.get(id);
}

export function recordPushRun(run: PushRun): void {
  runs.set(run.id, run);
}

export function markPushRunDone(id: string): boolean {
  const r = runs.get(id);
  if (!r || r.status === 'done') return false;
  r.status = 'done';
  r.doneAt = Date.now();
  return true;
}

// Forget the run after the frontend has acknowledged completion. Keeps the
// in-memory map from growing across long sessions.
export function forgetPushRun(id: string): void {
  runs.delete(id);
}

function pushSessionDir(projectPath: string, id: string): string {
  return path.join(projectPath, '.lattice', 'push', id);
}

// Materialize the per-session directory: writes the instructions brief and
// installs the Stop hook so Claude calls /api/push-runs/:id/done on stop.
export async function setupPushSession(
  projectPath: string,
  backendOrigin: string,
): Promise<{ id: string; cwd: string; instructionsFile: string }> {
  const id = `push_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const cwd = pushSessionDir(projectPath, id);
  const claudeDir = path.join(cwd, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });

  const hookConfig = {
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `curl -s -m 5 -X POST ${backendOrigin}/api/push-runs/${id}/done`,
            },
          ],
        },
      ],
    },
  };
  await fs.writeFile(
    path.join(claudeDir, 'settings.local.json'),
    JSON.stringify(hookConfig, null, 2),
    'utf8',
  );

  const instructionsFile = path.join(cwd, 'PUSH_INSTRUCTIONS.md');
  await fs.writeFile(instructionsFile, renderPushInstructions(projectPath), 'utf8');

  return { id, cwd, instructionsFile };
}

export async function cleanupPushSession(projectPath: string, id: string): Promise<void> {
  const dir = pushSessionDir(projectPath, id);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* best-effort — Windows file locks etc. */
  }
}

function renderPushInstructions(projectPath: string): string {
  return `# Push to remote

Project: \`${projectPath}\`

## Steps

1. \`cd "${projectPath}"\`
2. Run \`git status\`. If there are uncommitted changes, stage and commit them
   with a concise message that describes the diff:
   \`\`\`
   git add -A
   git commit -m "<concise summary of the changes>"
   \`\`\`
   If the working tree is already clean, skip the commit step.
3. Push to the remote: \`git push\`. If push fails because the upstream isn't
   set, run \`git push -u origin HEAD\` instead.
4. Report a one-line summary of what you committed (if anything) and the push
   result. Then stop — the Lattice harness closes this terminal automatically
   once you stop.
`;
}
