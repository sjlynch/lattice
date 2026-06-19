// The QA_INSTRUCTIONS.md brief handed to a Playwright-enabled Claude session
// that exercises a merged QA-lane task end-to-end. By the time a task reaches
// the QA lane its branch has merged into the project's default branch and the
// worktree is gone, so this session operates against the real project tree.
//
// Like the push-run brief, the pty runs with `cwd = scratchDir` (so Claude
// reads the Stop hook from cwd) and the agent `cd`s into the project as
// step 1. The Playwright MCP is injected automatically at spawn because the
// QA-lane toggle (`qaPlaywright.enabled`) is on for this project; its
// headless/headed mode is already configured there, so the brief doesn't set
// it.

import { applyTemplate } from '../instructionTemplates/apply.js';
import { DEFAULT_QA_TEMPLATE } from '../instructionTemplates/defs.js';

export function renderQaInstructions(args: {
  projectPath: string;
  // The QA run id — keys the structured-verdict callback URL.
  qaRunId: string;
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  backendOrigin: string;
  template?: string;
}): string {
  const { projectPath, qaRunId, taskId, taskTitle, taskDescription, backendOrigin } =
    args;
  const description = taskDescription?.trim()
    ? taskDescription.trim()
    : '_(no description provided)_';
  const summaryUrl = `${backendOrigin}/api/tasks/${taskId}/append-summary`;
  const verdictUrl = `${backendOrigin}/api/qa-runs/${qaRunId}/verdict`;

  return applyTemplate(args.template ?? DEFAULT_QA_TEMPLATE, {
    project_path: projectPath,
    task_title: taskTitle,
    task_description: description,
    summary_url: summaryUrl,
    verdict_url: verdictUrl,
  });
}
