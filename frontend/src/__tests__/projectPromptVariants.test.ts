import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphNode, ScanResult } from '../api/index.ts';
import {
  detectProjectPromptProfile,
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
