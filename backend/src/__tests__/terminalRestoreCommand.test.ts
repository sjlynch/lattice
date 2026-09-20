import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commandHasFlag,
  parseAgentCommand,
  quoteArg,
  tokenizeCommand,
} from '../terminalRegistry/commandParse.js';
import {
  assignHarnessSessionId,
  mintAgentSessionId,
} from '../terminalRegistry/sessionIdentity.js';
import { buildRestoreCommand, RESTORE_NUDGE } from '../terminalRegistry/restoreCommand.js';
import { buildAgentCommand } from '../agentCommandBuilder.js';

// ---- tokenizer -----------------------------------------------------------

test('tokenizeCommand round-trips Lattice-built quoted prompts', () => {
  const cmd = buildAgentCommand({
    harness: 'claude',
    prompt: 'Please read LATTICE_TASK.md and say "hi" with a $dollar and `tick`',
  });
  const tokens = tokenizeCommand(cmd);
  assert.equal(tokens[0]!.value, 'claude');
  assert.equal(tokens[1]!.value, '--dangerously-skip-permissions');
  assert.equal(tokens[2]!.quoted, true);
  assert.equal(
    tokens[2]!.value,
    'Please read LATTICE_TASK.md and say "hi" with a $dollar and `tick`',
  );
  // quoteArg is the inverse of the tokenizer's unescaping.
  assert.equal(tokenizeCommand(quoteArg(tokens[2]!.value))[0]!.value, tokens[2]!.value);
});

test('parseAgentCommand separates flags, value flags and the trailing prompt', () => {
  const parsed = parseAgentCommand(
    'pi --approve --model "my-vllm/meta-llama/Llama-3.1-8B" "Please read LATTICE_TASK.md"',
    'pi',
  )!;
  assert.equal(parsed.binary.value, 'pi');
  assert.deepEqual(parsed.args.map((t) => t.value), ['--approve', '--model', 'my-vllm/meta-llama/Llama-3.1-8B']);
  assert.equal(parsed.prompt?.value, 'Please read LATTICE_TASK.md');
  assert.deepEqual(parsed.positionals, []);
});

test('parseAgentCommand: an interactive launch has no prompt', () => {
  const parsed = parseAgentCommand('claude --dangerously-skip-permissions', 'claude')!;
  assert.equal(parsed.prompt, undefined);
  assert.deepEqual(parsed.args.map((t) => t.value), ['--dangerously-skip-permissions']);
});

test('commandHasFlag sees bare and --flag=value forms, never quoted text', () => {
  assert.equal(commandHasFlag('claude --resume abc', ['--resume']), true);
  assert.equal(commandHasFlag('claude --session-id=abc', ['--session-id']), true);
  assert.equal(commandHasFlag('claude "please --resume nothing"', ['--resume']), false);
});

// ---- session identity ----------------------------------------------------

test('assignHarnessSessionId pins a UUID on Claude and a lattice- id on Pi', () => {
  const claude = assignHarnessSessionId('claude --dangerously-skip-permissions "go"', () => 'ID');
  assert.equal(claude.command, 'claude --dangerously-skip-permissions "go" --session-id ID');
  assert.deepEqual(claude.agentSession, { harness: 'claude', id: 'ID', source: 'minted' });
  const pi = assignHarnessSessionId('pi --approve', () => 'lattice-ID');
  assert.equal(pi.command, 'pi --approve --session-id lattice-ID');
  assert.equal(pi.agentSession?.harness, 'pi');
  // Real mint: Claude needs a UUID, Pi's charset allows the lattice- prefix.
  assert.match(mintAgentSessionId('claude'), /^[0-9a-f-]{36}$/);
  assert.match(mintAgentSessionId('pi'), /^lattice-[0-9a-f-]{36}$/);
});

test('assignHarnessSessionId never stacks on a user-chosen session or touches codex/shells', () => {
  for (const cmd of [
    'claude --resume 123', 'claude -c', 'claude --continue', 'claude --session-id x',
    'pi --session foo.jsonl', 'pi -c', 'pi --no-session', 'pi --fork abc',
  ]) {
    const out = assignHarnessSessionId(cmd, () => 'NEW');
    assert.equal(out.command, cmd, cmd);
    assert.equal(out.agentSession, undefined, cmd);
  }
  assert.equal(assignHarnessSessionId('codex --yolo "x"').command, 'codex --yolo "x"');
  assert.equal(assignHarnessSessionId(undefined).command, '');
  assert.equal(assignHarnessSessionId('npm run dev').command, 'npm run dev');
});

// ---- restore command per harness ----------------------------------------

test('claude: transcript exists → --resume with the prompt dropped and the nudge appended', () => {
  const launch = { initialCommand: buildAgentCommand({ harness: 'claude', prompt: 'Please read LATTICE_TASK.md' }) };
  const out = buildRestoreCommand({
    launch,
    agentSession: { harness: 'claude', id: 'S1', source: 'minted' },
    claudeTranscriptExists: true,
    nudge: RESTORE_NUDGE,
  });
  assert.equal(out.mode, 'resume');
  assert.equal(out.command, `claude --dangerously-skip-permissions --resume S1 ${quoteArg(RESTORE_NUDGE)}`);
});

test('claude: transcript missing → same --session-id with the ORIGINAL prompt, no nudge', () => {
  const launch = { initialCommand: 'claude --dangerously-skip-permissions "Please read LATTICE_TASK.md"' };
  const out = buildRestoreCommand({
    launch,
    agentSession: { harness: 'claude', id: 'S1', source: 'minted' },
    claudeTranscriptExists: false,
    nudge: RESTORE_NUDGE,
  });
  assert.equal(out.mode, 'fresh');
  assert.equal(out.command, 'claude --dangerously-skip-permissions --session-id S1 "Please read LATTICE_TASK.md"');
});

test('claude: a sidebar launch without a prompt resumes without one', () => {
  const out = buildRestoreCommand({
    launch: { initialCommand: 'claude' },
    agentSession: { harness: 'claude', id: 'S1', source: 'minted' },
    claudeTranscriptExists: true,
  });
  assert.equal(out.command, 'claude --resume S1');
});

test('pi: --session-id is used for both launch and relaunch, model flag preserved', () => {
  const launch = {
    initialCommand: buildAgentCommand({ harness: 'pi', piModel: 'box/qwen3', prompt: 'Please read LATTICE_TASK.md' }),
  };
  const out = buildRestoreCommand({
    launch,
    agentSession: { harness: 'pi', id: 'lattice-1', source: 'minted' },
    nudge: 'continue',
  });
  assert.equal(out.mode, 'resume');
  assert.equal(out.command, 'pi --approve --model "box/qwen3" --session-id lattice-1 "continue"');
});

test('codex: known id → resume <id> with flags kept; unknown → resume --last', () => {
  const launch = { initialCommand: buildAgentCommand({ harness: 'codex', prompt: 'Please read LATTICE_TASK.md' }) };
  const known = buildRestoreCommand({
    launch,
    agentSession: { harness: 'codex', id: '019a-b', source: 'rollout-scan' },
    nudge: 'go on',
  });
  assert.equal(known.command, 'codex resume 019a-b --yolo --dangerously-bypass-hook-trust "go on"');
  const unknown = buildRestoreCommand({ launch });
  assert.equal(unknown.command, 'codex resume --last --yolo --dangerously-bypass-hook-trust');
  assert.equal(unknown.agentSession, undefined);
});

test('codex: the injected title config is NOT in the original and is not duplicated', () => {
  // The registry stores the pre-injection command; the chokepoint re-adds the
  // title config on relaunch. A stale record that somehow carried it still
  // parses (it is a value flag) and is preserved verbatim.
  const out = buildRestoreCommand({
    launch: { initialCommand: 'codex --config "tui.terminal_title=[\'status\']" --yolo "p"' },
    agentSession: { harness: 'codex', id: 'X', source: 'rollout-scan' },
  });
  assert.equal(out.command, 'codex resume X --config "tui.terminal_title=[\'status\']" --yolo');
});

test('a plain shell reopens with no command; a non-harness command reruns verbatim', () => {
  assert.deepEqual(buildRestoreCommand({ launch: {} }), { mode: 'shell' });
  const dev = buildRestoreCommand({ launch: { initialCommand: 'npm run dev' } });
  assert.equal(dev.mode, 'verbatim');
  assert.equal(dev.command, 'npm run dev');
});

test('a harness launch with no known session (user picked their own) reruns verbatim', () => {
  const out = buildRestoreCommand({ launch: { initialCommand: 'claude --resume abc' } });
  assert.equal(out.mode, 'verbatim');
  assert.equal(out.command, 'claude --resume abc');
});

test('a session ref for the wrong harness is ignored', () => {
  const out = buildRestoreCommand({
    launch: { initialCommand: 'pi --approve' },
    agentSession: { harness: 'claude', id: 'S', source: 'minted' },
  });
  assert.equal(out.mode, 'verbatim');
});
