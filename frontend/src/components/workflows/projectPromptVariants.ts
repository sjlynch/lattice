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

type ScanIndex = {
  fileNames: Set<string>;
  filePaths: string[];
  searchableText: string;
  extensionCounts: Map<string, number>;
};

type StackSignal = {
  fileNames?: readonly string[];
  extensions?: readonly string[];
  pathRegexes?: readonly RegExp[];
  textRegexes?: readonly RegExp[];
};

type StackMetadata = {
  id: ProjectPromptStack;
  label: string;
  guidance: readonly string[];
  signals: readonly StackSignal[];
};

type PromptTemplateMatchInput = {
  title: string;
  prompt: string;
};

type PromptTemplateMetadata = {
  id: PromptTemplateId;
  title: string;
  projectAware?: boolean;
  matches: (input: PromptTemplateMatchInput) => boolean;
};

const PROJECT_STACKS: readonly StackMetadata[] = [
  {
    id: 'react',
    label: 'React',
    guidance: [
      'For React code, pay close attention to component boundaries, hook dependency arrays, stale closures, derived state, accessibility, and render/performance pitfalls.',
      'Prefer changes that preserve props/contracts and keep UI behavior covered by component or integration tests where they exist.',
    ],
    signals: [
      { extensions: ['.tsx', '.jsx'] },
      { fileNames: ['vite.config.ts', 'vite.config.js', 'next.config.js', 'next.config.ts'] },
      { textRegexes: [/\breact\b/] },
    ],
  },
  {
    id: 'angular',
    label: 'Angular',
    guidance: [
      'For Angular code, inspect dependency injection boundaries, RxJS subscription lifecycles, change detection, routing/module structure, forms, and template bindings.',
      'Keep public component/service APIs stable and update Angular-specific tests or harnesses when behavior changes.',
    ],
    signals: [
      { fileNames: ['angular.json'] },
      { textRegexes: [/\.component\.ts\b/, /\.module\.ts\b/, /\b@angular\b/] },
    ],
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    guidance: [
      'For TypeScript code, preserve strict type safety, module boundaries, async error paths, public exported types, and build/type-check expectations.',
      'Prefer explicit types where they clarify contracts, but avoid broad rewrites that only satisfy style preferences.',
    ],
    signals: [
      { extensions: ['.ts', '.tsx'] },
      { fileNames: ['tsconfig.json'] },
    ],
  },
  {
    id: 'node',
    label: 'Node.js',
    guidance: [
      'For Node.js code, scrutinize filesystem/process/network boundaries, Express/API validation, async cleanup, long-running resources, and cross-platform path handling.',
      'Keep package-manager scripts and server startup behavior intact; run the project type-check or targeted tests when appropriate.',
    ],
    signals: [
      { fileNames: ['package.json'] },
      { extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'] },
    ],
  },
  {
    id: 'python',
    label: 'Python',
    guidance: [
      'For Python code, check packaging entry points, virtualenv assumptions, pathlib/path handling, typing/dataclass contracts, async/resource cleanup, and pytest coverage.',
      'Favor small module boundaries and regression tests over broad style-only rewrites.',
    ],
    signals: [
      { extensions: ['.py'] },
      { fileNames: ['pyproject.toml'] },
    ],
  },
  {
    id: 'rust',
    label: 'Rust',
    guidance: [
      'For Rust code, respect ownership/lifetime boundaries, error propagation with Result, trait/module APIs, cargo feature flags, and concurrency safety.',
      'Prefer cargo test/clippy-friendly changes and avoid unnecessary public API churn.',
    ],
    signals: [
      { extensions: ['.rs'] },
      { fileNames: ['cargo.toml'] },
    ],
  },
];

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
    id: 'brainstorm',
    title: 'Brainstorm',
    matches: ({ title, prompt }) =>
      title.includes('brainstorm') ||
      prompt.startsWith('brainstorm 3–5 distinct approaches'),
  },
];

const PROJECT_AWARE_PROMPTS = new Set<string>(
  PROMPT_TEMPLATE_METADATA
    .filter((template) => template.projectAware)
    .map((template) => template.id),
);

function addOnce<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

function buildScanIndex(scan: ScanResult | null | undefined): ScanIndex {
  const fileNames = new Set<string>();
  const filePaths: string[] = [];
  const searchableParts: string[] = [];
  const extensionCounts = new Map<string, number>();

  for (const node of scan?.nodes ?? []) {
    if (node.kind !== 'file') continue;
    const name = node.name.toLowerCase();
    const path = node.path.toLowerCase();
    fileNames.add(name);
    filePaths.push(path);
    searchableParts.push(`${name}\n${path}`);
    if (node.ext) {
      extensionCounts.set(node.ext, (extensionCounts.get(node.ext) ?? 0) + 1);
    }
  }

  return {
    fileNames,
    filePaths,
    searchableText: searchableParts.join('\n'),
    extensionCounts,
  };
}

function signalMatches(signal: StackSignal, scan: ScanIndex): boolean {
  if (signal.fileNames?.some((name) => scan.fileNames.has(name))) return true;
  if (signal.extensions?.some((ext) => (scan.extensionCounts.get(ext) ?? 0) > 0)) return true;
  if (signal.pathRegexes?.some((regex) => scan.filePaths.some((path) => regex.test(path)))) return true;
  if (signal.textRegexes?.some((regex) => regex.test(scan.searchableText))) return true;
  return false;
}

function stackMatches(stack: StackMetadata, scan: ScanIndex): boolean {
  return stack.signals.some((signal) => signalMatches(signal, scan));
}

export function detectProjectPromptProfile(
  projectPath: string,
  scan: ScanResult | null | undefined,
): ProjectPromptProfile | null {
  if (!projectPath) return null;
  const scanIndex = buildScanIndex(scan);
  const stacks: ProjectPromptStack[] = [];

  for (const stack of PROJECT_STACKS) {
    if (stackMatches(stack, scanIndex)) addOnce(stacks, stack.id);
  }

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

  const matchingStacks = PROJECT_STACKS.filter((stack) => stacks.includes(stack.id));
  return {
    projectPath,
    stacks,
    summary: matchingStacks.map((stack) => stack.label).join(' + '),
    guidance: matchingStacks.flatMap((stack) => stack.guidance),
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
  const input = {
    title: step.title.trim().toLowerCase(),
    prompt: step.prompt.trim().toLowerCase(),
  };
  return PROMPT_TEMPLATE_METADATA.find((template) => template.matches(input))?.id ?? null;
}

export function promptTemplateTitle(id: PromptTemplateId | null): string | undefined {
  return PROMPT_TEMPLATE_METADATA.find((template) => template.id === id)?.title;
}
