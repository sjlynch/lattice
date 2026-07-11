// Assembles the harness command line for a workflow step. Intent-specific
// prompt text stays here; shared harness syntax (Claude permissions, Pi model
// flag, Codex prompt quoting) lives in agentCommandBuilder.ts.

import { buildAgentCommand, promptFileName } from '../agentCommandBuilder.js';
import type { Workflow } from '../workflows.js';

export function buildWorkflowStepCommand(
  stepFile: string,
  harness: Workflow['steps'][number]['harness'],
  piModel?: string,
  codexYolo?: boolean,
): string {
  const resolvedHarness = harness ?? 'claude';
  const fileName = promptFileName(stepFile);
  return buildAgentCommand({
    harness: resolvedHarness,
    piModel,
    codexYolo,
    prompt: `Please read ${fileName} and complete the task described in it.`,
  });
}
