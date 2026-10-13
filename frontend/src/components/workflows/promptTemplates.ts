import type { DefaultPrompt } from './defaultPrompts';
import type { ProjectPromptProfile } from './projectStackDetection';

// The quick-add prompts that get a "· Project" variant tailored to the active
// project's detected stack.
export type ProjectAwarePromptId = 'refactor' | 'bug-catcher';

const PROJECT_AWARE_PROMPTS: ReadonlySet<string> = new Set<ProjectAwarePromptId>([
  'refactor',
  'bug-catcher',
]);

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
