import type { AgentHarness } from '../harnesses.js';

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
  terminalId?: string;
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
