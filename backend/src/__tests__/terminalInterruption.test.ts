import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyClaudeTranscriptTail,
  classifyCodexRolloutTail,
  classifyPiTranscriptTail,
  decideInterruption,
} from '../terminalRegistry/interruption.js';
import {
  claudeProjectDirName,
  piSessionDirName,
} from '../terminalRegistry/harnessPaths.js';
import { parseCodexSessionMeta, pickCodexSession } from '../terminalRegistry/codexDiscovery.js';

const lines = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

// ---- path encodings (verified against real dirs on Windows) -------------

test('claude / pi project dir encodings match the harnesses', () => {
  assert.equal(claudeProjectDirName('C:\\development\\lattice'), 'C--development-lattice');
  assert.equal(claudeProjectDirName('/home/me/proj'), '-home-me-proj');
  assert.equal(piSessionDirName('C:\\development\\lattice'), '--C--development-lattice--');
  assert.equal(piSessionDirName('/home/me/proj'), '--home-me-proj--');
});

// ---- claude --------------------------------------------------------------

const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });
const assistant = (content: unknown) => ({ type: 'assistant', message: { role: 'assistant', content } });

test('claude: a dangling tool_use is an open turn', () => {
  const tail = lines(
    user('do it'),
    assistant([{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
  );
  assert.equal(classifyClaudeTranscriptTail(tail), 'open');
});

test('claude: a tool_result with no reply yet is an open turn', () => {
  const tail = lines(
    assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'x' }]),
  );
  assert.equal(classifyClaudeTranscriptTail(tail), 'open');
});

test('claude: a final assistant text is idle; a user Esc-interrupt marker is idle', () => {
  assert.equal(classifyClaudeTranscriptTail(lines(user('hi'), assistant([{ type: 'text', text: 'done' }]))), 'idle');
  assert.equal(
    classifyClaudeTranscriptTail(lines(assistant([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }]),
      user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]))),
    'idle',
  );
});

test('claude: a trailing user prompt with no reply is open; bookkeeping lines are skipped', () => {
  const tail = lines(
    { type: 'summary', summary: 'x' },
    user('please continue'),
    { type: 'file-history-snapshot', messageId: 'm' },
  );
  assert.equal(classifyClaudeTranscriptTail(tail), 'open');
  assert.equal(classifyClaudeTranscriptTail(''), 'unknown');
  assert.equal(classifyClaudeTranscriptTail('not json\n'), 'unknown');
});

// ---- pi ------------------------------------------------------------------

const piMsg = (message: Record<string, unknown>) => ({ type: 'message', message });

test('pi: stopReason toolUse / trailing user / toolResult are open, stop is idle', () => {
  assert.equal(classifyPiTranscriptTail(lines(piMsg({ role: 'assistant', stopReason: 'toolUse' }))), 'open');
  assert.equal(classifyPiTranscriptTail(lines(piMsg({ role: 'user' }))), 'open');
  assert.equal(classifyPiTranscriptTail(lines(piMsg({ role: 'toolResult' }))), 'open');
  assert.equal(classifyPiTranscriptTail(lines(
    { type: 'session', id: 'x' }, piMsg({ role: 'user' }), piMsg({ role: 'assistant', stopReason: 'stop' }),
  )), 'idle');
  assert.equal(classifyPiTranscriptTail(lines(piMsg({ role: 'assistant', stopReason: 'aborted' }))), 'idle');
  assert.equal(classifyPiTranscriptTail(lines({ type: 'session' })), 'unknown');
});

// ---- codex ---------------------------------------------------------------

const ev = (type: string) => ({ type: 'event_msg', payload: { type } });

test('codex: task_started after the last task_complete is open', () => {
  assert.equal(classifyCodexRolloutTail(lines(ev('task_started'), ev('task_complete'), ev('task_started'))), 'open');
  assert.equal(classifyCodexRolloutTail(lines(ev('task_started'), ev('task_complete'))), 'idle');
  assert.equal(classifyCodexRolloutTail(lines(ev('task_started'), ev('turn_aborted'))), 'idle');
  assert.equal(classifyCodexRolloutTail(lines({ type: 'session_meta' })), 'unknown');
});

test('codex: session_meta parsing and cwd-matched, unclaimed, earliest-first picking', () => {
  const meta = parseCodexSessionMeta(JSON.stringify({
    type: 'session_meta',
    payload: { id: 'A', cwd: 'C:\\Proj\\a', timestamp: '2026-09-20T16:26:24.905Z' },
  }), 'f')!;
  assert.equal(meta.id, 'A');
  assert.equal(meta.timestamp, Date.parse('2026-09-20T16:26:24.905Z'));
  assert.equal(parseCodexSessionMeta('{"type":"other"}', 'f'), null);

  const candidates = [
    { id: 'old', cwd: 'c:/proj/a', timestamp: 1, file: '1' },
    { id: 'B', cwd: 'C:\\proj\\b', timestamp: 2, file: '2' },
    { id: 'A2', cwd: 'C:\\Proj\\A', timestamp: 3, file: '3' },
  ];
  const pick = pickCodexSession(candidates, 'c:\\proj\\a', new Set(['old']));
  assert.deepEqual(pick, { id: 'A2', ambiguous: false });
  const both = pickCodexSession(candidates, 'c:\\proj\\a', new Set());
  assert.deepEqual(both, { id: 'old', ambiguous: true });
  assert.equal(pickCodexSession(candidates, 'c:\\proj\\zzz', new Set()), null);
  // A `codex resume --last` relaunch reopened the thread written most recently
  // in the cwd — pick by mtime, newest first, not the earliest-created one.
  const withMtimes = [
    { id: 'older-thread', cwd: 'c:/proj/a', timestamp: 1, file: '1', mtimeMs: 500 },
    { id: 'newer-thread', cwd: 'c:/proj/a', timestamp: 2, file: '2', mtimeMs: 900 },
  ];
  assert.deepEqual(pickCodexSession(withMtimes, 'c:/proj/a', new Set(), 'resumed'), { id: 'newer-thread', ambiguous: true });
  assert.deepEqual(pickCodexSession(withMtimes, 'c:/proj/a', new Set(), 'fresh'), { id: 'older-thread', ambiguous: true });
});

// ---- the decision --------------------------------------------------------

test('decideInterruption nudges only on open+non-idle; any idle vetoes; unknown never nudges', () => {
  assert.equal(decideInterruption('open', 'busy'), 'interrupted');
  assert.equal(decideInterruption('open', 'unknown'), 'interrupted');
  assert.equal(decideInterruption('open', 'idle'), 'idle');
  assert.equal(decideInterruption('idle', 'busy'), 'idle');
  assert.equal(decideInterruption('unknown', 'busy'), 'unknown');
  assert.equal(decideInterruption('unknown', 'unknown'), 'unknown');
  assert.equal(decideInterruption('unknown', 'idle'), 'idle');
});
