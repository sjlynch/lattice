import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentCommand } from '../agentCommandBuilder.js';

// buildAgentCommand assembles the shell command line spawned for EVERY
// task/workflow/push/resolver agent across all three harnesses. Its private
// shellDoubleQuoted() helper (exercised here THROUGH buildAgentCommand, the
// only exported entry) is the sole shell-injection guard on the prompt text:
// it wraps the value in double quotes and backslash-escapes double-quote,
// backslash, dollar-sign, and backtick. A regression is either a broken spawn
// (mangled prompt) or a shell-injection surface, so pin both the harness
// framing and the quoting exactly. Pure unit test — no spawning, no fs.

// --- Harness branches (with a benign, metachar-free prompt) ------------------

test('claude branch: --dangerously-skip-permissions + quoted prompt', () => {
  assert.equal(
    buildAgentCommand({ harness: 'claude', prompt: 'do the thing' }),
    'claude --dangerously-skip-permissions "do the thing"',
  );
});

test('pi branch with no piModel: `pi --approve` + quoted prompt (no --model)', () => {
  assert.equal(
    buildAgentCommand({ harness: 'pi', prompt: 'do the thing' }),
    'pi --approve "do the thing"',
  );
});

test('pi branch with an INVALID piModel: still no --model flag (keeps --approve)', () => {
  // An un-normalizable value (buildPiModelFlag rejects it) must fall back to
  // Pi's own default model — never interpolate the junk into the command line.
  assert.equal(
    buildAgentCommand({
      harness: 'pi',
      prompt: 'do the thing',
      piModel: 'not a model',
    }),
    'pi --approve "do the thing"',
  );
});

test('pi branch with a VALID piModel: --approve then quoted --model precede the prompt', () => {
  assert.equal(
    buildAgentCommand({
      harness: 'pi',
      prompt: 'do the thing',
      piModel: 'qwen-local/qwen',
    }),
    'pi --approve --model "qwen-local/qwen" "do the thing"',
  );
});

test('codex branch: --yolo by default + --dangerously-bypass-hook-trust + quoted prompt', () => {
  // --yolo (Codex's permission bypass) is ON by default, matching the
  // default-on UserSettings.codexYolo. --dangerously-bypass-hook-trust is
  // ALWAYS present so the Lattice-injected .codex/hooks.json Stop hook (the
  // completion backstop) runs without Codex's per-hook trust prompt.
  assert.equal(
    buildAgentCommand({ harness: 'codex', prompt: 'do the thing' }),
    'codex --yolo --dangerously-bypass-hook-trust "do the thing"',
  );
});

test('codex branch with codexYolo:true: explicit --yolo + bypass-hook-trust', () => {
  assert.equal(
    buildAgentCommand({ harness: 'codex', prompt: 'do the thing', codexYolo: true }),
    'codex --yolo --dangerously-bypass-hook-trust "do the thing"',
  );
});

test('codex branch with codexYolo:false: no --yolo but STILL --dangerously-bypass-hook-trust', () => {
  // Dropping --yolo (permissions) must not drop the hook-trust bypass — the
  // Stop-hook backstop still needs to run without a trust prompt.
  assert.equal(
    buildAgentCommand({ harness: 'codex', prompt: 'do the thing', codexYolo: false }),
    'codex --dangerously-bypass-hook-trust "do the thing"',
  );
});

// --- Shell quoting of the prompt (the injection guard) -----------------------
//
// Assert each metacharacter is backslash-escaped exactly once and the whole is
// wrapped in double quotes. We check via claude (the framing is fixed) and read
// the prompt back out of the returned command by slicing off the known prefix.

const CLAUDE_PREFIX = 'claude --dangerously-skip-permissions ';

function quotedPromptOf(prompt: string): string {
  const cmd = buildAgentCommand({ harness: 'claude', prompt });
  assert.ok(
    cmd.startsWith(CLAUDE_PREFIX),
    `expected the claude prefix, got: ${cmd}`,
  );
  return cmd.slice(CLAUDE_PREFIX.length);
}

test('a metachar-free prompt is just wrapped in double quotes', () => {
  assert.equal(quotedPromptOf('plain prompt'), '"plain prompt"');
});

test('a double-quote in the prompt is backslash-escaped exactly once', () => {
  // he said "hi"  ->  "he said \"hi\""
  assert.equal(quotedPromptOf('he said "hi"'), '"he said \\"hi\\""');
});

test('a backslash in the prompt is backslash-escaped exactly once', () => {
  // path C:\dir  ->  "path C:\\dir"
  assert.equal(quotedPromptOf('path C:\\dir'), '"path C:\\\\dir"');
});

test('a dollar-var is neutralised (escaped, not expanded)', () => {
  // echo $HOME  ->  "echo \$HOME"
  assert.equal(quotedPromptOf('echo $HOME'), '"echo \\$HOME"');
});

test('a backtick is neutralised (escaped, not command-substituted)', () => {
  // run `id`  ->  "run \`id\`"
  assert.equal(quotedPromptOf('run `id`'), '"run \\`id\\`"');
});

test('a mix of all four metacharacters is each escaped exactly once', () => {
  // "\$`  ->  "\"\\\$\`"
  assert.equal(quotedPromptOf('"\\$`'), '"\\"\\\\\\$\\`"');
});

test('command-substitution via $( ) is defused (dollar + paren)', () => {
  // The dollar-sign is escaped so the subshell never runs; parens are literal.
  assert.equal(
    quotedPromptOf('$(rm -rf /)'),
    '"\\$(rm -rf /)"',
  );
});

test('command-substitution via backticks is defused', () => {
  // Both backticks are escaped so the subshell never runs.
  assert.equal(
    quotedPromptOf('`rm -rf /`'),
    '"\\`rm -rf /\\`"',
  );
});
