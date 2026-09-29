import fs from 'node:fs';
import path from 'node:path';

// Collect after the entry point has allowed the post-chaos outbox to settle.
export async function collectSoakReport({ fixture, api, finalRun, taskIds, expectedLines, elapsed, restarts }) {
  const { root, home, project, soakLog, g } = fixture;
  const P = encodeURIComponent(project);

  const failures = [];
  const check = (ok, msg) => {
    if (!ok) failures.push(msg);
  };

  check(finalRun?.status === 'completed', `workflow run ended ${finalRun?.status ?? 'NOT AT ALL (timeout)'}${finalRun?.error ? `: ${finalRun.error}` : ''}`);

  const list = await api('GET', `/api/tasks?project=${P}&status=all&fields=full&clip=0&limit=0&confirm_large=1`);
  const tasks = (list.json?.tasks ?? []).filter((t) => taskIds.includes(t.id));
  const byStatus = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  for (const t of tasks) {
    check(t.status === 'qa' || t.status === 'done', `task ${t.title} ended ${t.status}${t.conflict ? ' (conflict)' : ''}`);
  }

  const mainLog = g(['log', '--oneline', 'main']);
  for (const { file, line } of expectedLines) {
    const p = path.join(project, file);
    const content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    // CRLF: Git for Windows' system config checks out with core.autocrlf.
    check(content.split(/\r?\n/).includes(line), `main is missing "${line}" in ${file}`);
  }
  check(!/<<<<<<<|>>>>>>>/.test(fs.readFileSync(path.join(project, 'shared.txt'), 'utf8')), 'conflict markers on main');

  const worktrees = g(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length;
  check(worktrees === 1, `${worktrees - 1} task worktree(s) still registered`);

  const outboxDir = path.join(home, '.lattice', 'callback-outbox');
  const pending = fs.existsSync(outboxDir) ? fs.readdirSync(outboxDir).filter((n) => n.endsWith('.json')) : [];
  check(pending.length === 0, `${pending.length} undelivered callback(s) left in the outbox`);

  const events = fs.existsSync(soakLog)
    ? fs.readFileSync(soakLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const starts = events.filter((e) => e.event === 'start');
  const sessionsBy = {};
  for (const e of starts) sessionsBy[e.kind] = (sessionsBy[e.kind] ?? 0) + 1;
  const pushSessions = starts.filter((e) => e.kind === 'session' && /[\\/]push[\\/]/.test(e.cwd)).length;
  check(pushSessions === 1, `${pushSessions} push session(s) spawned (want exactly 1)`);
  const hookSessions = starts.filter((e) => e.kind === 'session' && /[\\/]post-merge-hooks[\\/]/.test(e.cwd)).length;
  // The hook is on and merges landed: it must have run — even when a kill fell
  // between the last merge and the hook firing (postMergeHooks/owed.ts).
  check(hookSessions >= 1, 'the post-merge hook never ran');
  const failedWork = events.filter((e) => e.event === 'work-failed' || e.event === 'crashed');
  check(failedWork.length === 0, `${failedWork.length} fake-agent failure(s): ${failedWork.map((e) => e.error).join(' | ').slice(0, 400)}`);

  const report = {
    ok: failures.length === 0,
    failures,
    elapsedSec: elapsed,
    restarts,
    run: finalRun ? { status: finalRun.status, error: finalRun.error, stepSummaries: finalRun.stepSummaries } : null,
    tasksByStatus: byStatus,
    mainCommits: mainLog.split('\n').length,
    sessionsByKind: sessionsBy,
    pushSessions,
    hookSessions,
    stopHooks: events.filter((e) => e.event === 'stop-hook').length,
    root,
  };

  return report;
}
