import type { ScanResult, WorkflowStep } from '../../api';
import type { DefaultPrompt } from './defaultPrompts';

export type ProjectPromptStack =
  | 'react'
  | 'angular'
  | 'typescript'
  | 'node'
  | 'python'
  | 'rust';

export type ProjectPromptProfile = {
  projectPath: string;
  stacks: ProjectPromptStack[];
  summary: string;
  guidance: string[];
};

export type ProjectAwarePromptId = 'refactor' | 'bug-catcher';
export type PromptTemplateId =
  | ProjectAwarePromptId
  | 'combine-tasks'
  | 'pmf'
  | 'brainstorm';

const PROJECT_AWARE_PROMPTS = new Set<string>(['refactor', 'bug-catcher']);

const STACK_LABELS: Record<ProjectPromptStack, string> = {
  react: 'React',
  angular: 'Angular',
  typescript: 'TypeScript',
  node: 'Node.js',
  python: 'Python',
  rust: 'Rust',
};

const STACK_GUIDANCE: Record<ProjectPromptStack, string[]> = {
  react: [
    'For React code, pay close attention to component boundaries, hook dependency arrays, stale closures, derived state, accessibility, and render/performance pitfalls.',
    'Prefer changes that preserve props/contracts and keep UI behavior covered by component or integration tests where they exist.',
  ],
  angular: [
    'For Angular code, inspect dependency injection boundaries, RxJS subscription lifecycles, change detection, routing/module structure, forms, and template bindings.',
    'Keep public component/service APIs stable and update Angular-specific tests or harnesses when behavior changes.',
  ],
  typescript: [
    'For TypeScript code, preserve strict type safety, module boundaries, async error paths, public exported types, and build/type-check expectations.',
    'Prefer explicit types where they clarify contracts, but avoid broad rewrites that only satisfy style preferences.',
  ],
  node: [
    'For Node.js code, scrutinize filesystem/process/network boundaries, Express/API validation, async cleanup, long-running resources, and cross-platform path handling.',
    'Keep package-manager scripts and server startup behavior intact; run the project type-check or targeted tests when appropriate.',
  ],
  python: [
    'For Python code, check packaging entry points, virtualenv assumptions, pathlib/path handling, typing/dataclass contracts, async/resource cleanup, and pytest coverage.',
    'Favor small module boundaries and regression tests over broad style-only rewrites.',
  ],
  rust: [
    'For Rust code, respect ownership/lifetime boundaries, error propagation with Result, trait/module APIs, cargo feature flags, and concurrency safety.',
    'Prefer cargo test/clippy-friendly changes and avoid unnecessary public API churn.',
  ],
};

function addOnce<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

function fileNameSet(scan: ScanResult | null | undefined): Set<string> {
  const names = new Set<string>();
  for (const node of scan?.nodes ?? []) {
    if (node.kind !== 'file') continue;
    names.add(node.name.toLowerCase());
  }
  return names;
}

function pathText(scan: ScanResult | null | undefined): string {
  return (scan?.nodes ?? [])
    .filter((node) => node.kind === 'file')
    .map((node) => `${node.name}\n${node.path}`.toLowerCase())
    .join('\n');
}

function extCounts(scan: ScanResult | null | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of scan?.nodes ?? []) {
    if (node.kind !== 'file' || !node.ext) continue;
    counts.set(node.ext, (counts.get(node.ext) ?? 0) + 1);
  }
  return counts;
}

export function detectProjectPromptProfile(
  projectPath: string,
  scan: ScanResult | null | undefined,
): ProjectPromptProfile | null {
  if (!projectPath) return null;
  const names = fileNameSet(scan);
  const paths = pathText(scan);
  const counts = extCounts(scan);
  const stacks: ProjectPromptStack[] = [];
  const tsCount = (counts.get('.ts') ?? 0) + (counts.get('.tsx') ?? 0);
  const jsCount = (counts.get('.js') ?? 0) + (counts.get('.jsx') ?? 0) + (counts.get('.mjs') ?? 0) + (counts.get('.cjs') ?? 0);
  const reactSignals =
    (counts.get('.tsx') ?? 0) > 0 ||
    (counts.get('.jsx') ?? 0) > 0 ||
    names.has('vite.config.ts') ||
    names.has('vite.config.js') ||
    names.has('next.config.js') ||
    names.has('next.config.ts') ||
    /\breact\b/.test(paths);
  const angularSignals =
    names.has('angular.json') ||
    /\.component\.ts\b/.test(paths) ||
    /\.module\.ts\b/.test(paths) ||
    /\b@angular\b/.test(paths);

  if (reactSignals) addOnce(stacks, 'react');
  if (angularSignals) addOnce(stacks, 'angular');
  if (tsCount > 0 || names.has('tsconfig.json')) addOnce(stacks, 'typescript');
  if (names.has('package.json') || jsCount > 0 || tsCount > 0) addOnce(stacks, 'node');
  if ((counts.get('.py') ?? 0) > 0 || names.has('pyproject.toml')) addOnce(stacks, 'python');
  if ((counts.get('.rs') ?? 0) > 0 || names.has('cargo.toml')) addOnce(stacks, 'rust');

  if (stacks.length === 0) {
    return {
      projectPath,
      stacks,
      summary: 'a mixed or not-yet-scanned codebase',
      guidance: [
        'First identify the dominant languages, frameworks, build commands, and test style from the project before proposing project-specific work.',
      ],
    };
  }

  const labels = stacks.map((stack) => STACK_LABELS[stack]);
  const guidance = stacks.flatMap((stack) => STACK_GUIDANCE[stack]);
  return {
    projectPath,
    stacks,
    summary: labels.join(' + '),
    guidance,
  };
}

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
  const title = step.title.trim().toLowerCase();
  const prompt = step.prompt.trim().toLowerCase();
  if (title.includes('bug catcher') || title.includes('bug-catcher') || prompt.includes('## active project tailoring') && prompt.includes('bug')) {
    return 'bug-catcher';
  }
  if (title.includes('refactor') || prompt.startsWith('analyze the codebase and look for opportunities to refactor')) {
    return 'refactor';
  }
  if (title.includes('combine task') || prompt.startsWith('analyze the lattice task board')) {
    return 'combine-tasks';
  }
  if (title === 'pmf' || prompt.startsWith('please do a thorough review of this codebase')) {
    return 'pmf';
  }
  if (title.includes('brainstorm') || prompt.startsWith('brainstorm 3–5 distinct approaches')) {
    return 'brainstorm';
  }
  return null;
}

export function promptTemplateTitle(id: PromptTemplateId | null): string | undefined {
  if (id === 'bug-catcher') return 'Bug Catcher';
  if (id === 'combine-tasks') return 'Combine Tasks';
  if (id === 'pmf') return 'PMF';
  if (id === 'refactor') return 'Refactor';
  if (id === 'brainstorm') return 'Brainstorm';
  return undefined;
}
