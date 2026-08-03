import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphNode, ScanResult } from '../api/index.ts';
import {
  detectProjectPromptProfile,
  inferPromptTemplateId,
  promptTemplateTitle,
  promptsWithProjectVariants,
} from '../components/workflows/projectPromptVariants.ts';

function file(name: string, path: string, ext?: string): GraphNode {
  return {
    id: path,
    name,
    path,
    kind: 'file',
    ...(ext ? { ext } : {}),
  };
}

function scan(nodes: GraphNode[]): ScanResult {
  return { root: '/repo', nodes, links: [] };
}

test('detectProjectPromptProfile identifies React TypeScript Node projects in declaration order', () => {
  const profile = detectProjectPromptProfile('/repo', scan([
    file('package.json', '/repo/package.json'),
    file('App.tsx', '/repo/src/App.tsx', '.tsx'),
  ]));

  assert.deepEqual(profile?.stacks, ['react', 'typescript', 'node']);
  assert.equal(profile?.summary, 'React + TypeScript + Node.js');
  assert.ok(profile?.guidance.some((line) => line.startsWith('For React code')));
});

test('detectProjectPromptProfile covers Angular, Python, Rust, and default fallbacks', () => {
  const angular = detectProjectPromptProfile('/repo', scan([
    file('angular.json', '/repo/angular.json'),
    file('app.component.ts', '/repo/src/app/app.component.ts', '.ts'),
  ]));
  assert.deepEqual(angular?.stacks, ['angular', 'typescript', 'node']);

  const polyglot = detectProjectPromptProfile('/repo', scan([
    file('pyproject.toml', '/repo/pyproject.toml'),
    file('main.py', '/repo/main.py', '.py'),
    file('Cargo.toml', '/repo/Cargo.toml'),
    file('lib.rs', '/repo/src/lib.rs', '.rs'),
  ]));
  assert.deepEqual(polyglot?.stacks, ['python', 'rust']);
  assert.equal(polyglot?.summary, 'Python + Rust');

  const fallback = detectProjectPromptProfile('/repo', scan([
    file('README.md', '/repo/README.md', '.md'),
  ]));
  assert.deepEqual(fallback?.stacks, []);
  assert.equal(fallback?.summary, 'a mixed or not-yet-scanned codebase');
});

test('promptsWithProjectVariants only tailors project-aware prompts', () => {
  const profile = detectProjectPromptProfile('/repo', scan([
    file('package.json', '/repo/package.json'),
    file('App.tsx', '/repo/src/App.tsx', '.tsx'),
  ]));
  assert.ok(profile);

  const prompts = [
    {
      id: 'refactor',
      title: 'Refactor',
      label: 'Refactor',
      prompt: 'Base refactor prompt.',
      icon: null as never,
    },
    {
      id: 'combine-tasks',
      title: 'Combine Tasks',
      label: 'Combine Tasks',
      prompt: 'Base combine prompt.',
      icon: null as never,
    },
  ];

  const variants = promptsWithProjectVariants(prompts, profile);
  assert.equal(variants[0].label, 'Refactor · Project');
  assert.match(variants[0].prompt, /## Active project tailoring/);
  assert.equal(variants[1], prompts[1]);
});

test('inferPromptTemplateId and promptTemplateTitle use the ordered template metadata', () => {
  const cases = [
    [{ title: 'Bug-catcher pass', prompt: '' }, 'bug-catcher', 'Bug Catcher'],
    [{ title: 'Refactor modules', prompt: '' }, 'refactor', 'Refactor'],
    [{ title: 'Combine task backlog', prompt: '' }, 'combine-tasks', 'Combine Tasks'],
    [{ title: ' PMF ', prompt: '' }, 'pmf', 'PMF'],
    [{ title: 'Security', prompt: '' }, 'security', 'Security'],
    [{ title: 'Test coverage gaps', prompt: '' }, 'test-coverage', 'Test Coverage'],
    [
      {
        title: 'Coverage pass',
        prompt: 'Analyze this codebase and its existing test suite to find genuine gaps.',
      },
      'test-coverage',
      'Test Coverage',
    ],
    [{ title: 'Brainstorm options', prompt: '' }, 'brainstorm', 'Brainstorm'],
    [
      {
        title: 'Tailored template',
        prompt: '## Active project tailoring\n\nLook for bug risks in this project.',
      },
      'bug-catcher',
      'Bug Catcher',
    ],
    [
      {
        title: 'Template prompt',
        prompt: 'Analyze the Lattice task board and identify tasks that should be combined.',
      },
      'combine-tasks',
      'Combine Tasks',
    ],
    // The prompt bodies were reworded to be planner-only (file tasks, never
    // implement/commit). Both the old and the new opener must still resolve, or
    // a workflow saved before the rewording loses its template identity.
    [
      {
        title: 'Step 1',
        prompt: 'Analyze the codebase for opportunities to refactor the code so that it is easier for LLMs to navigate.',
      },
      'refactor',
      'Refactor',
    ],
    [
      {
        title: 'Step 1',
        prompt: 'Analyze the codebase and look for opportunities to refactor the code so that it is easier for LLMs to navigate.',
      },
      'refactor',
      'Refactor',
    ],
    [
      {
        title: 'Step 1',
        prompt: "Survey this project's documentation and file every gap you find as a task.",
      },
      'documentation',
      'Documentation',
    ],
    [
      {
        title: 'Step 1',
        prompt: 'Survey this project and bring its documentation up to a high standard.',
      },
      'documentation',
      'Documentation',
    ],
  ] as const;

  for (const [step, id, title] of cases) {
    assert.equal(inferPromptTemplateId(step), id);
    assert.equal(promptTemplateTitle(id), title);
  }

  assert.equal(inferPromptTemplateId({ title: 'Custom', prompt: 'Do something else.' }), null);
  assert.equal(promptTemplateTitle(null), undefined);
});
