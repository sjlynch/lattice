import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { codexCodeTools, codexRolloutCodeCall } from '../codexCodeActivity.js';
import { filesFromHookBody } from '../hookFiles.js';

// Codex 0.159's hosted runner records only the outer `exec` call; the CLI
// activity hooks can miss the nested tools. These fixtures retain that shape
// without any actual session, prompt, or project contents.
test('hosted parallel shell reads retain literal cmd and workdir for the normal activity decoder', () => {
  const tools = codexCodeTools([
    'const results = await Promise.allSettled([',
    '  tools.exec_command({cmd: "Get-Content -LiteralPath src/app.ts", workdir: "frontend"}),',
    '  tools.exec_command({cmd: ["cat", "README.md"], max_output_tokens: budget})',
    ']); results.forEach(text);',
  ].join('\n'));
  assert.equal(tools.length, 2);
  assert.deepEqual(filesFromHookBody(tools[0]), {
    files: [path.join('frontend', 'src', 'app.ts')], mustExist: true,
  });
  assert.deepEqual(filesFromHookBody(tools[1]), { files: ['README.md'], mustExist: true });
});

test('hosted patch arguments preserve newlines and escaped Windows paths', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+x\n*** End Patch';
  const tools = codexCodeTools(`await tools.apply_patch(${JSON.stringify(patch)});`);
  assert.deepEqual(filesFromHookBody(tools[0]), { files: ['src/a.ts', 'src/b.ts'], mustExist: true });
  const windows = codexCodeTools('await tools.exec_command({cmd: "Get-Content C:\\\\repo\\\\src\\\\a.ts"});');
  assert.equal(windows[0].tool_input.cmd, 'Get-Content C:\\repo\\src\\a.ts');
});

test('hosted activity ignores arbitrary strings, other tools, and unknown directories', () => {
  assert.deepEqual(codexCodeTools([
    'const unrelated = "src/secret.ts";',
    'text("README.md"); tools.web__run({url: "src/page.ts"});',
    'tools.exec_command({cmd: "cat package.json", workdir: chosenDirectory});',
  ].join('\n')), []);
  assert.deepEqual(codexCodeTools('tools.exec_command({cmd: "cat README.md"});'.repeat(100)).length, 64);
  assert.deepEqual(codexCodeTools('x'.repeat(256 * 1024 + 1)), []);
});

test('only hosted exec rollout items use the fallback; native hooks keep their own activity path', () => {
  const payload = { type: 'custom_tool_call', name: 'exec', call_id: 'call-1',
    input: 'await tools.exec_command({cmd: "cat README.md"});' };
  assert.equal(codexRolloutCodeCall({ type: 'response_item', payload })?.tools.length, 1);
  assert.equal(codexRolloutCodeCall({ type: 'event_msg', payload }), null);
  assert.equal(codexRolloutCodeCall({ type: 'response_item', payload: { ...payload, name: 'apply_patch' } }), null);
  assert.equal(codexRolloutCodeCall({ type: 'response_item', payload: { ...payload, input: null } }), null);
});
