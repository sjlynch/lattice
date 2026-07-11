import type { WorkflowStep } from '../../api';
import type { DefaultPrompt } from './defaultPrompts';
import type { ProjectPromptProfile } from './projectStackDetection';

export type ProjectAwarePromptId = 'refactor' | 'bug-catcher';
export type PromptTemplateId =
  | ProjectAwarePromptId
  | 'combine-tasks'
  | 'pmf'
  | 'security'
  | 'test-coverage'
  | 'brainstorm'
  | 'documentation';

export type PromptTemplateMatchInput = {
  title: string;
  prompt: string;
};

export type PromptTemplateMetadata = {
  id: PromptTemplateId;
  title: string;
  projectAware?: boolean;
  matches: (input: PromptTemplateMatchInput) => boolean;
};

const PROMPT_TEMPLATE_METADATA: readonly PromptTemplateMetadata[] = [
  {
    id: 'bug-catcher',
    title: 'Bug Catcher',
    projectAware: true,
    matches: ({ title, prompt }) =>
      title.includes('bug catcher') ||
      title.includes('bug-catcher') ||
      (prompt.includes('## active project tailoring') && prompt.includes('bug')),
  },
  {
    id: 'refactor',
    title: 'Refactor',
    projectAware: true,
    matches: ({ title, prompt }) =>
      title.includes('refactor') ||
      prompt.startsWith('analyze the codebase and look for opportunities to refactor'),
  },
  {
    id: 'combine-tasks',
    title: 'Combine Tasks',
    matches: ({ title, prompt }) =>
      title.includes('combine task') ||
      prompt.startsWith('analyze the lattice task board'),
  },
  {
    id: 'pmf',
    title: 'PMF',
    matches: ({ title, prompt }) =>
      title === 'pmf' ||
      prompt.startsWith('please do a thorough review of this codebase'),
  },
  {
    id: 'security',
    title: 'Security',
    matches: ({ title, prompt }) =>
      title === 'security' ||
      prompt.startsWith('analyze this codebase specifically for security vulnerabilities'),
  },
  {
    id: 'test-coverage',
    title: 'Test Coverage',
    matches: ({ title, prompt }) =>
      title.includes('test coverage') ||
      prompt.startsWith('analyze this codebase and its existing test suite'),
  },
  {
    id: 'brainstorm',
    title: 'Brainstorm',
    matches: ({ title, prompt }) =>
      title.includes('brainstorm') ||
      prompt.startsWith('brainstorm 3–5 distinct approaches'),
  },
  {
    id: 'documentation',
    title: 'Documentation',
    matches: ({ title, prompt }) =>
      title.includes('documentation') ||
      prompt.startsWith('survey this project and bring its documentation'),
  },
];

const PROJECT_AWARE_PROMPTS = new Set<string>(
  PROMPT_TEMPLATE_METADATA
    .filter((template) => template.projectAware)
    .map((template) => template.id),
);

export function isProjectAwarePrompt(id: string): id is ProjectAwarePromptId {
  return PROJECT_AWARE_PROMPTS.has(id);
}

export function promptWithProjectVariant(
  prompt: DefaultPrompt,
  profile: ProjectPromptProfile | null,
): DefaultPrompt {
  if (!profile || !isProjectAwarePrompt(prompt.id)) return prompt;
  const guidance = profile.guidance.map((line) => `- ${line}`).join('\n');
  return {
    ...prompt,
    label: `${prompt.label} · Project`,
    prompt: `${prompt.prompt}\n\n## Active project tailoring\n\nThis active project appears to be ${profile.summary}. Tailor the ${prompt.title.toLowerCase()} workflow to ${profile.projectPath}.\n\n${guidance}`,
  };
}

export function promptsWithProjectVariants(
  prompts: DefaultPrompt[],
  profile: ProjectPromptProfile | null,
): DefaultPrompt[] {
  return prompts.map((prompt) => promptWithProjectVariant(prompt, profile));
}

export function inferPromptTemplateId(step: Pick<WorkflowStep, 'title' | 'prompt'>): PromptTemplateId | null {
  const input = {
    title: step.title.trim().toLowerCase(),
    prompt: step.prompt.trim().toLowerCase(),
  };
  return PROMPT_TEMPLATE_METADATA.find((template) => template.matches(input))?.id ?? null;
}

export function promptTemplateTitle(id: PromptTemplateId | null): string | undefined {
  return PROMPT_TEMPLATE_METADATA.find((template) => template.id === id)?.title;
}
