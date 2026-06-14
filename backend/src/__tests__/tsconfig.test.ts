import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadProjectAliases } from '../health/tsconfig.js';

async function makeProject(layout: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-tsconfig-'));
  for (const [rel, content] of Object.entries(layout)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return dir;
}

test('loadProjectAliases parses wildcard paths against baseUrl', async () => {
  const dir = await makeProject({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        baseUrl: './src',
        paths: { '@/*': ['*'], '@components/*': ['components/*'] },
      },
    }),
  });
  const aliases = await loadProjectAliases(dir);
  // Longer prefix wins → @components/ before @/.
  assert.equal(aliases[0].prefix, '@components/');
  assert.equal(aliases[0].isWildcard, true);
  assert.equal(aliases[0].substitutions[0], path.join(dir, 'src', 'components'));
  assert.equal(aliases[1].prefix, '@/');
  assert.equal(aliases[1].substitutions[0], path.join(dir, 'src'));
});

test('loadProjectAliases tolerates JSONC comments and trailing commas', async () => {
  const dir = await makeProject({
    'tsconfig.json': `{
      // a comment
      "compilerOptions": {
        "paths": {
          "@/*": ["src/*"], /* trailing block comment */
        },
      },
    }`,
  });
  const aliases = await loadProjectAliases(dir);
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].prefix, '@/');
});

test('loadProjectAliases discovers tsconfig.app.json under references', async () => {
  const dir = await makeProject({
    'tsconfig.json': JSON.stringify({
      files: [],
      references: [{ path: './tsconfig.app.json' }],
    }),
    'tsconfig.app.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '~/*': ['app/*'] } },
    }),
  });
  const aliases = await loadProjectAliases(dir);
  const tilde = aliases.find((a) => a.prefix === '~/');
  assert.ok(tilde, '~/ alias discovered from tsconfig.app.json');
  assert.equal(tilde.substitutions[0], path.join(dir, 'app'));
  // baseUrl '.' also yields a bare-import catch-all (sorted last).
  assert.ok(
    aliases.some((a) => a.prefix === '' && a.isWildcard),
    'explicit baseUrl emits a catch-all alias',
  );
});

test('loadProjectAliases emits a baseUrl catch-all even without paths', async () => {
  const dir = await makeProject({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: './src' },
    }),
  });
  const aliases = await loadProjectAliases(dir);
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].prefix, '');
  assert.equal(aliases[0].isWildcard, true);
  assert.equal(aliases[0].substitutions[0], path.join(dir, 'src'));
});

test('loadProjectAliases skips node_modules', async () => {
  const dir = await makeProject({
    'node_modules/some-pkg/tsconfig.json': JSON.stringify({
      compilerOptions: { paths: { '@bad/*': ['*'] } },
    }),
    'tsconfig.json': JSON.stringify({
      compilerOptions: { paths: { '@good/*': ['src/*'] } },
    }),
  });
  const aliases = await loadProjectAliases(dir);
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].prefix, '@good/');
});

test('loadProjectAliases returns empty list when nothing has paths', async () => {
  const dir = await makeProject({
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
  });
  const aliases = await loadProjectAliases(dir);
  assert.deepEqual(aliases, []);
});
