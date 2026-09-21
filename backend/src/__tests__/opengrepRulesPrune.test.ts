import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prunePackTree } from '../opengrep/rules.js';
import { withTempDir, writeLayout } from './helpers/tempDir.js';

// What survives a rule-pack checkout. This is the licence boundary in code:
// the default pack must end up MIT-only (the `jetbrains/` and `rules/lgpl/`
// folders are pruned by name), and nothing that is not a rule — test sources,
// CI config, fixtures — is kept on disk.

const RULE = 'rules:\n  - id: r1\n    message: x\n    languages: [js]\n    severity: WARNING\n    pattern: foo()\n';
const TWO_RULES = `${RULE}  - id: r2\n    message: y\n    languages: [js]\n    severity: INFO\n    pattern: bar()\n`;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

test('prunePackTree keeps only rule yaml (+ LICENSE/README) and drops the excluded folders', async () => {
  await withTempDir('lattice-opengrep-prune-', async (dir) => {
    await writeLayout(dir, {
      LICENSE: 'MIT',
      'README.md': 'readme',
      'CONTRIBUTING.md': 'no',
      'javascript/xss/a.yaml': RULE,
      'javascript/xss/a.js': 'var x = 1;',
      'javascript/xss/a.test.yaml': RULE,
      'javascript/eval/b.yml': TWO_RULES,
      'rules/lgpl/c.yaml': RULE,
      'rules/keep/d.yaml': RULE,
      'jetbrains/e.yaml': RULE,
      'stats/s.yml': 'a: 1\nb: 2\n',
      '.github/workflows/ci.yml': 'on: push\n',
      '.pre-commit-config.yaml': 'repos: []\n',
      'scripts/gen.py': 'print(1)',
      'empty/notes.txt': 'x',
      'nested/deeper/README.md': 'not root, not a rule',
    });
    const counts = await prunePackTree(dir, ['jetbrains', 'rules/lgpl']);
    assert.deepEqual(counts, { ruleFiles: 3, ruleCount: 4 });

    const kept = ['LICENSE', 'README.md', 'javascript/xss/a.yaml', 'javascript/eval/b.yml', 'rules/keep/d.yaml'];
    for (const rel of kept) assert.ok(await exists(path.join(dir, ...rel.split('/'))), `kept ${rel}`);
    const gone = [
      'CONTRIBUTING.md',
      'javascript/xss/a.js',
      'javascript/xss/a.test.yaml',
      'rules/lgpl',
      'jetbrains',
      'stats',
      '.github',
      '.pre-commit-config.yaml',
      'scripts',
      'empty',
      'nested',
    ];
    for (const rel of gone) assert.ok(!(await exists(path.join(dir, ...rel.split('/')))), `removed ${rel}`);
  });
});

test('prunePackTree reports zero rule files for a tree with no rules (the installer refuses it)', async () => {
  await withTempDir('lattice-opengrep-prune-', async (dir) => {
    await writeLayout(dir, { LICENSE: 'MIT', 'docs/x.yaml': 'not: rules\n' });
    assert.deepEqual(await prunePackTree(dir, []), { ruleFiles: 0, ruleCount: 0 });
    assert.ok(await exists(path.join(dir, 'LICENSE')));
    assert.ok(!(await exists(path.join(dir, 'docs'))));
  });
});
