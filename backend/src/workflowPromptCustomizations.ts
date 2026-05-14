import fs from 'node:fs/promises';
import path from 'node:path';
import { generateWorkflowPromptCustomizationId } from './ids.js';
import { canonicalProjectPath } from './projectPath.js';
import { proxyCreateSession } from './terminalProxy.js';
import { normalizeAgentHarness, type AgentHarness } from './harnesses.js';
import {
  buildClaudeCommand,
  buildCodexCommand,
  buildPiCommand,
} from './worktree/commands.js';

export type WorkflowPromptTemplateId =
  | 'refactor'
  | 'bug-catcher'
  | 'combine-tasks'
  | 'pmf'
  | 'brainstorm';

export type WorkflowPromptCustomizationStatus =
  | 'running'
  | 'completed'
  | 'errored';

export type WorkflowPromptCustomization = {
  id: string;
  projectPath: string;
  stepTitle: string;
  originalPrompt: string;
  templateId?: WorkflowPromptTemplateId;
  templateTitle?: string;
  customInstructions?: string;
  harness: AgentHarness;
  status: WorkflowPromptCustomizationStatus;
  createdAt: number;
  finishedAt?: number;
  resultPrompt?: string;
  error?: string;
  command: string;
  cwd: string;
  serverId?: string;
};

export type StartWorkflowPromptCustomizationInput = {
  project: string;
  stepTitle?: string;
  prompt: string;
  templateId?: WorkflowPromptTemplateId;
  templateTitle?: string;
  customInstructions?: string;
  harness?: unknown;
};

const requests = new Map<string, WorkflowPromptCustomization>();

function customizationDir(projectPath: string, id: string): string {
  return path.join(projectPath, '.lattice', 'workflow-prompt-customizations', id);
}

function buildCustomizationCommand(
  instructionsFile: string,
  harness: AgentHarness,
): string {
  if (harness === 'pi') return buildPiCommand(instructionsFile);
  if (harness === 'codex') return buildCodexCommand(instructionsFile);
  return buildClaudeCommand(instructionsFile);
}

function renderSubmitScript(callbackUrl: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');

async function main() {
  const file = process.argv[2];
  const prompt = file
    ? fs.readFileSync(file, 'utf8')
    : fs.readFileSync(0, 'utf8');
  const response = await fetch(${JSON.stringify(callbackUrl)}, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error('submit failed: ' + response.status + ' ' + text);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
`;
}

function renderCustomizationInstructions(
  request: WorkflowPromptCustomization,
): string {
  const templateLine = request.templateId
    ? `Template type: ${request.templateTitle ?? request.templateId}`
    : 'Template type: custom user-authored workflow step';
  const customInstructions = request.customInstructions?.trim();
  return [
    `# Customize workflow prompt: ${request.stepTitle || 'Untitled step'}`,
    '',
    'You are customizing a Lattice workflow step prompt for the active project.',
    'Do not edit project files, do not create tasks, and do not commit anything.',
    '',
    '## Active project',
    '',
    `Project root: \`${request.projectPath}\``,
    `Selected harness for the step: ${request.harness}`,
    templateLine,
    '',
    'Inspect the project as needed, then rewrite the workflow step prompt so it is tailored to this project while preserving the original intent.',
    request.templateId
      ? 'Adhere to the template type above. Keep the prompt self-contained and suitable for future agents that will create Lattice tasks from it.'
      : 'Use the user customization instructions below as the source of truth for how this custom prompt should be tailored.',
    'The final prompt should be actionable, concise enough to live in the workflow editor, and specific about languages/frameworks/tests/docs that matter in this project.',
    '',
    ...(customInstructions
      ? [
          '## User customization instructions',
          '',
          customInstructions,
          '',
        ]
      : []),
    '## Current workflow prompt',
    '',
    '```markdown',
    request.originalPrompt,
    '```',
    '',
    '## Return the customized prompt',
    '',
    '1. Write only the revised workflow prompt body to `CUSTOMIZED_PROMPT.md` in this directory.',
    '2. Submit it back to Lattice with:',
    '',
    '```bash',
    'node submit-customized-prompt.cjs CUSTOMIZED_PROMPT.md',
    '```',
    '',
    'After the callback succeeds, stop. The browser will update the workflow step automatically.',
  ].join('\n');
}

export function getWorkflowPromptCustomization(
  id: string,
): WorkflowPromptCustomization | null {
  const request = requests.get(id);
  return request ? { ...request } : null;
}

export async function startWorkflowPromptCustomization(
  input: StartWorkflowPromptCustomizationInput,
  backendOrigin: string,
): Promise<WorkflowPromptCustomization> {
  if (!input.project) throw new Error('project required');
  const originalPrompt = typeof input.prompt === 'string' ? input.prompt : '';
  const customInstructions = input.customInstructions?.trim();
  if (!originalPrompt.trim() && !customInstructions) {
    throw new Error('prompt or customization instructions required');
  }

  const projectPath = canonicalProjectPath(input.project);
  const id = generateWorkflowPromptCustomizationId();
  const cwd = customizationDir(projectPath, id);
  const harness = normalizeAgentHarness(input.harness);
  const request: WorkflowPromptCustomization = {
    id,
    projectPath,
    stepTitle: input.stepTitle?.trim() || 'Untitled step',
    originalPrompt,
    ...(input.templateId ? { templateId: input.templateId } : {}),
    ...(input.templateTitle ? { templateTitle: input.templateTitle } : {}),
    ...(customInstructions ? { customInstructions } : {}),
    harness,
    status: 'running',
    createdAt: Date.now(),
    command: '',
    cwd,
  };

  await fs.mkdir(cwd, { recursive: true });
  const instructionsFile = path.join(cwd, 'CUSTOMIZE_PROMPT.md');
  await fs.writeFile(
    path.join(cwd, 'submit-customized-prompt.cjs'),
    renderSubmitScript(`${backendOrigin}/api/workflow-prompt-customizations/${id}/complete`),
    'utf8',
  );
  await fs.writeFile(
    instructionsFile,
    renderCustomizationInstructions(request),
    'utf8',
  );

  const command = buildCustomizationCommand(instructionsFile, harness);
  request.command = command;
  requests.set(id, request);

  const sess = await proxyCreateSession({
    cwd,
    initialCommand: command,
    projectPath,
  });
  if ('error' in sess) {
    console.warn(
      `[workflow-prompt-customization] ${id}: pre-spawn failed: ${sess.error}`,
    );
  } else {
    request.serverId = sess.id;
  }

  return { ...request };
}

export async function completeWorkflowPromptCustomization(
  id: string,
  prompt: unknown,
): Promise<WorkflowPromptCustomization | null> {
  const request = requests.get(id);
  if (!request) return null;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    request.status = 'errored';
    request.error = 'customized prompt was empty';
    request.finishedAt = Date.now();
    return { ...request };
  }
  request.status = 'completed';
  request.resultPrompt = prompt.replace(/\r\n/g, '\n').trim();
  request.finishedAt = Date.now();
  try {
    await fs.writeFile(
      path.join(request.cwd, 'CUSTOMIZED_PROMPT.submitted.md'),
      request.resultPrompt,
      'utf8',
    );
  } catch {
    // Best-effort audit copy only.
  }
  return { ...request };
}
