import fs from 'node:fs/promises';
import path from 'node:path';
import { startHomeScratchAgentSession } from '../homeScratch/session.js';
import { createHomeScratchPaths } from '../homeScratch/paths.js';
import { cleanupHomeScratchSession } from '../homeScratch/cleanup.js';
import { buildAgentCommand } from '../agentCommandBuilder.js';
import { registerAgentSession, unregisterAgentSession } from '../agentSessions.js';
import { installClaudeHooks } from '../claudeStopHook.js';
import { installCodexStopHook } from '../codexStopHook.js';
import { installPiCompletionExtension } from '../piExtension.js';
import { installPiActivityExtension } from '../piActivity.js';
import { installPiRetryExtension } from '../piRetry.js';
import { buildAgentActivityUrl } from '../agentActivityTokens.js';
import type { AgentHarness } from '../harnesses.js';
import { isActiveReview, updateReviewStore, type ReviewRun } from './reviewStore.js';
import type { OpengrepFinding } from './parseOutput.js';
import { securityReviewBrief } from './reviewBrief.js';
import { beginRestartTransition } from '../restartDrain/gate.js';
import { canonicalProjectPath } from '../projectPath.js';
import { terminalRegistry } from '../terminalRegistry/store.js';
import { proxyKillSession } from '../terminalServerClient/sessions.js';

export const reviewPaths = createHomeScratchPaths({ dirName: 'security-reviews', idPrefix: 'sreview', logLabel: '[security-review]', noun: 'security review' });
export const reviewAgentId = (id: string) => `security-review:${id}`;
export async function cleanupReview(projectPath: string, id: string) {
  const cwd = reviewPaths.assertSafeSessionPath(projectPath, id);
  // Block conversation restore before removing its cwd. A failed kill retains
  // ownership and scratch so a later explicit End/Close can retry safely.
  for (const record of await terminalRegistry.list(projectPath, { includeEnded: true })) {
    if (canonicalProjectPath(record.cwd) !== canonicalProjectPath(cwd)) continue;
    const closing = await terminalRegistry.requestClose(record.id, projectPath);
    if (!closing) continue;
    if (closing.serverId && !await proxyKillSession(closing.serverId)) throw new Error('Could not close the review console. Retry End review or close its terminal tab.');
    const current = await terminalRegistry.get(record.id, projectPath);
    if (current?.relaunching || current?.serverId && current.serverId !== closing.serverId) throw new Error('The review console is restoring. Retry closing it once restoration settles.');
    await terminalRegistry.end(record.id, { reason: 'closed' }, projectPath);
  }
  await cleanupHomeScratchSession({ paths: reviewPaths, projectPath, id, logLabel: '[security-review]' });
}
const pending = new Map<string, AbortController>();
const pendingKey = (project: string, id: string) => `${canonicalProjectPath(project)}\0${id}`;
export function abortPendingReview(project: string, id: string) { pending.get(pendingKey(project, id))?.abort(); }
export function isPendingReview(project: string, id: string) { return pending.has(pendingKey(project, id)); }

export async function startReviewSession(args: { project: string; scanId: string; findings: OpengrepFinding[]; harness: AgentHarness; piModel?: string; backendOrigin: string }, deps: { start?: typeof startHomeScratchAgentSession; cleanup?: typeof cleanupReview } = {}) {
  const endTransition = beginRestartTransition('security-review-start');
  let materializedId: string | undefined;
  const controller = new AbortController();
  try {
    const prompt = 'Read SECURITY_REVIEW.md. Review the supplied findings, explain your recommended next steps in this console, then wait for the user to choose before creating any tasks or making changes.';
    let command = buildAgentCommand({ harness: args.harness, piModel: args.piModel, codexYolo: false, prompt });
    // Only scratch is writable; local API access permits agreed board tasks.
    if (args.harness === 'codex') command = command.replace('codex ', 'codex --sandbox workspace-write --ask-for-approval never -c sandbox_workspace_write.network_access=true ');
    const started = await (deps.start ?? startHomeScratchAgentSession)({
      paths: reviewPaths, projectPath: args.project, instructionsFileName: 'SECURITY_REVIEW.md',
      signal: controller.signal,
      queueKind: 'security-review', queuePriority: 'interactive', dedupeKeyPrefix: 'security-review',
      // This is an ordinary durable conversation, not an auto-cleaned one-shot.
      registryOwner: 'user', registryLabel: 'Security review',
      buildCommand: () => command,
      cleanup: deps.cleanup ?? cleanupReview,
      installHooks: async ({ cwd, id }) => {
        const callbackUrl = `${args.backendOrigin}/api/opengrep/reviews/${id}/done?project=${encodeURIComponent(args.project)}`;
        const activityUrl = buildAgentActivityUrl(args.backendOrigin, { agentId: reviewAgentId(id), projectPath: args.project, label: 'Security review' });
        await installClaudeHooks(cwd, { completeUrl: callbackUrl, activityUrl });
        await installCodexStopHook(cwd, callbackUrl, 'always', activityUrl);
        await installPiCompletionExtension({ dir: cwd, callbackUrl, site: 'security-review-done', respectQuitGate: false, eventName: 'agent_settled' });
        await installPiActivityExtension({ dir: cwd, activityUrl });
        await installPiRetryExtension(cwd);
      },
      renderInstructions: async ({ cwd, id }) => {
        materializedId = id;
        pending.set(pendingKey(args.project, id), controller);
        const now = Date.now();
        const run: ReviewRun = { id, project: args.project, scanId: args.scanId, harness: args.harness, piModel: args.piModel,
          status: 'running', createdAt: now, updatedAt: now, findingCount: args.findings.length };
        await updateReviewStore(args.project, (store) => { store.runs.push(run); });
        await fs.writeFile(path.join(cwd, 'findings.json'), JSON.stringify(args.findings, null, 2));
        return securityReviewBrief({ ...args, findingCount: args.findings.length }, id);
      },
      onSpawned: () => {},
    });
    const active = await updateReviewStore(args.project, (store) => {
      const run = store.runs.find((r) => r.id === started.id);
      if (run) { run.serverId = started.serverId; run.terminalId = started.terminalId; run.updatedAt = Date.now(); }
      return !!run && isActiveReview(run);
    });
    if (active) registerAgentSession({ agentId: reviewAgentId(started.id), projectPath: args.project, label: 'Security review', harness: args.harness });
    else await (deps.cleanup ?? cleanupReview)(args.project, started.id);
    return started;
  } catch (err) {
    if (materializedId) {
      await updateReviewStore(args.project, (store) => {
        const run = store.runs.find((r) => r.id === materializedId);
        if (run && isActiveReview(run)) { run.status = 'failed'; run.finishedAt = run.updatedAt = Date.now(); run.error = err instanceof Error ? err.message : String(err); }
      }).catch(console.error);
      unregisterAgentSession(reviewAgentId(materializedId));
      await (deps.cleanup ?? cleanupReview)(args.project, materializedId);
    }
    throw err;
  } finally { if (materializedId) pending.delete(pendingKey(args.project, materializedId)); endTransition(); }
}

// Stop means this TURN ended, not that the conversation should be destroyed.
export async function finishReview(project: string, id: string) {
  reviewPaths.assertSafeSessionPath(project, id);
  await updateReviewStore(project, (store) => {
    const run = store.runs.find((r) => r.id === id);
    if (!run || !isActiveReview(run)) return;
    run.status = 'awaiting-decision';
    run.lastTurnAt = run.updatedAt = Date.now();
  });
}
