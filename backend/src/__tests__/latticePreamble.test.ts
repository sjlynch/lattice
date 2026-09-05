import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildLatticePreamble,
  composeSystemPromptAppend,
  resolveLatticePreamble,
} from '../harnessSystemPrompts/latticePreamble.js';

// The always-on discovery pointer folded into every harness's system prompt.
// It replaced two channels that could never work: the LATTICE_* pty env vars
// (no harness reads the environment into its context) and the terminal banner
// (scrollback-only — the pty child never receives those bytes).

const DOC = 'C:\\dev\\foo\\.lattice\\LATTICE_API.md';

test('preamble names Lattice, its trigger words, and the literal doc path', () => {
  const text = buildLatticePreamble(DOC);

  assert.ok(text.includes(DOC), 'absolute doc path present');
  for (const kw of [
    'Lattice',
    'task board',
    'worktrees',
    'merging',
    'workflows',
    'startup terminals',
  ]) {
    assert.ok(text.includes(kw), `trigger word "${kw}" present`);
  }
});

test('preamble is one line with no double quotes (Codex -c transit)', () => {
  // It rides a `-c developer_instructions='''…'''` override through a
  // `"%VAR%"` expansion; cmd.exe strips inner double quotes and breaks on an
  // embedded newline, so either would silently drop the override on Windows.
  const text = buildLatticePreamble('/home/u/p/.lattice/LATTICE_API.md');

  assert.ok(!text.includes('\n'), 'single line');
  assert.ok(!text.includes('"'), 'no double quotes');
  assert.ok(!text.includes("'''"), 'no TOML multi-line-literal delimiter');
});

test('preamble points an MCP-equipped session at the board tools, not curl', () => {
  // The `lattice` MCP server is first-party and ON by default, but the doc the
  // preamble points at is written in curl recipes — so without this clause an
  // agent that HAS typed board tools still shells out to curl.
  const text = buildLatticePreamble(DOC);
  assert.match(text, /MCP tools/);
  assert.ok(text.includes('board_summary'), 'names a tool the agent can recognise');
  assert.match(text, /instead of curl/);
});

test('preamble stays short — it rides every spawn in every project', () => {
  const text = buildLatticePreamble(DOC);
  assert.ok(text.length < 600, `preamble is ${text.length} chars, expected < 600`);
});

test('preamble points at nothing when the project is not Lattice-managed', async () => {
  // No `.lattice/` dir → no generated doc → no pointer, so an unmanaged cwd
  // spawns with a stock system prompt rather than a dangling path.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-preamble-none-'));
  assert.equal(resolveLatticePreamble(dir), null);
  assert.equal(resolveLatticePreamble(''), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('preamble resolves (and generates the doc) for a managed project', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-preamble-'));
  await fs.mkdir(path.join(dir, '.lattice'), { recursive: true });

  const text = resolveLatticePreamble(dir);
  assert.ok(text, 'preamble produced');
  const docPath = path.join(dir, '.lattice', 'LATTICE_API.md');
  assert.ok((text as string).includes(docPath), 'names this project’s doc');
  await fs.access(docPath); // throws if the doc was not written

  await fs.rm(dir, { recursive: true, force: true });
});

test('compose puts the Lattice preamble before the project’s own append', () => {
  const joined = composeSystemPromptAppend('LATTICE', 'USER');
  assert.equal(joined, 'LATTICE\n\nUSER');
  assert.equal(composeSystemPromptAppend('LATTICE', 'USER', ' '), 'LATTICE USER');
});

test('compose tolerates either side being absent or blank', () => {
  assert.equal(composeSystemPromptAppend('LATTICE', undefined), 'LATTICE');
  assert.equal(composeSystemPromptAppend(null, 'USER'), 'USER');
  assert.equal(composeSystemPromptAppend(null, undefined), undefined);
  // A whitespace-only override must not introduce a trailing separator.
  assert.equal(composeSystemPromptAppend('LATTICE', '   \n '), 'LATTICE');
  assert.equal(composeSystemPromptAppend('', ''), undefined);
});
