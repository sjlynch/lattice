// Assembles the harness command line for a workflow step. Thin glue over
// the pure per-harness builders in worktree/commands.ts — kept here (rather
// than folded into that module) because the harness→builder dispatch is
// workflow-step-specific and reads off `Workflow['steps'][number]['harness']`.

import { buildClaudeCommand, buildCodexCommand, buildPiCommand } from '../worktree/commands.js';
import type { Workflow } from '../workflows.js';

export function buildWorkflowStepCommand(
  stepFile: string,
  harness: Workflow['steps'][number]['harness'],
  piModel?: string,
): string {
  if (harness === 'pi') return buildPiCommand(stepFile, piModel);
  if (harness === 'codex') return buildCodexCommand(stepFile);
  return buildClaudeCommand(stepFile);
}
