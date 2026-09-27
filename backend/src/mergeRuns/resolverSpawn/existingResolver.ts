import path from 'node:path';
import { agentHarnessForCommand } from '../../harnesses.js';

// The live conflict-resolver pty already working in `worktreePath`, if any: an
// agent harness whose launch prompt names MERGE_INSTRUCTIONS.md, with that
// exact cwd (so the task's own agent — LATTICE_TASK.md — and a plain shell
// never match). Shared by merge-run recovery and the manual /merge route so
// neither starts a second resolver writing the same merge index.
export function findExistingResolverSession(
  sessions: readonly unknown[],
  worktreePath: string,
): { id: string } | undefined {
  const normalizeCwd = (cwd: string) => {
    const normalized = path.resolve(cwd);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const target = normalizeCwd(worktreePath);
  return sessions.find((candidate) => {
    const session = candidate as { id?: unknown; cwd?: unknown; initialCommand?: unknown } | null;
    return session && typeof session.id === 'string' && typeof session.cwd === 'string'
      && typeof session.initialCommand === 'string' && agentHarnessForCommand(session.initialCommand)
      && /\bMERGE_INSTRUCTIONS\.md\b/i.test(session.initialCommand)
      && normalizeCwd(session.cwd) === target;
  }) as { id: string } | undefined;
}
