import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INHERITED_AGENT_SESSION_ENV, scrubInheritedAgentSessionEnv } from '../inheritedAgentEnv.js';

// A backend started from inside a Claude Code session must not pass that
// session's identity (and messaging socket) to every agent it spawns.

test('drops the outside Claude session identity, keeps user configuration', () => {
  const env: NodeJS.ProcessEnv = {
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: '008e8d66-7805-46b0-b49e-333771957723',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\LOCAL\\cc-msg-x',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    CLAUDE_PID: '123',
    // User configuration sharing the prefix — must survive.
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
    CLAUDE_CONFIG_DIR: 'C:\\claude',
    PATH: 'C:\\bin',
  };
  const removed = scrubInheritedAgentSessionEnv(env);
  assert.deepEqual(removed.sort(), [
    'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID',
  ]);
  for (const name of INHERITED_AGENT_SESSION_ENV) assert.equal(env[name], undefined, name);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '32000');
  assert.equal(env.CLAUDE_CONFIG_DIR, 'C:\\claude');
  assert.equal(env.PATH, 'C:\\bin');
});

test('a clean environment is left alone', () => {
  const env: NodeJS.ProcessEnv = { PATH: 'x' };
  assert.deepEqual(scrubInheritedAgentSessionEnv(env), []);
  assert.deepEqual(env, { PATH: 'x' });
});
