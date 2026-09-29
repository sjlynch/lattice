import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TerminalSpec } from '../terminal/terminalTypes';
import {
  pickActiveAfterClose,
  pickActiveAfterCloseMany,
  pickActiveAfterDisappear,
} from '../terminal/terminalActivePolicy.ts';

// Regression: the close fallback grouped tabs by a STRICT projectPath compare,
// but a project's panel mixes registry tabs (backend realpath spelling) with
// locally-created fallback tabs (frontend spelling). Closing the active tab of
// one spelling then left nothing selected although a sibling was listed.

const t = (id: string, projectPath: string): TerminalSpec => ({
  id,
  label: id,
  cwd: projectPath,
  projectPath,
});

test('pickActiveAfterClose falls back across projectPath spellings', () => {
  const prev = [t('a', 'C:\\Dev\\Proj'), t('b', 'c:/dev/proj')];
  const next = prev.filter((x) => x.id !== 'a');
  assert.equal(pickActiveAfterClose(prev, next, 'a', 'a'), 'b');
});

test('pickActiveAfterCloseMany falls back across projectPath spellings', () => {
  const prev = [t('a', 'c:/dev/proj'), t('b', 'C:\\Dev\\Proj\\'), t('c', 'c:/dev/proj')];
  const closed = new Set(['b']);
  const next = prev.filter((x) => !closed.has(x.id));
  assert.equal(pickActiveAfterCloseMany(prev, next, closed, 'b'), 'a');
});

test('tabs of another project are never a fallback', () => {
  const prev = [t('a', 'c:/dev/proj'), t('b', 'c:/dev/other')];
  const next = prev.filter((x) => x.id !== 'a');
  assert.equal(pickActiveAfterClose(prev, next, 'a', 'a'), null);
});

// Regression: closing a tab fires the registry's `ended` event before the
// DELETE response, so the Sidebar saw the active id vanish first and focused
// "the last project tab" — a Startup terminal — instead of a neighbour.
const k = (id: string, kind: TerminalSpec['kind']): TerminalSpec => ({
  ...t(id, 'c:/dev/proj'),
  kind,
});

test('a tab removed in place falls back to its panel neighbour, not Startup', () => {
  const prev = [k('a', undefined), k('b', undefined), k('c', undefined), k('s', 'startup')];
  const next = prev.filter((x) => x.id !== 'b');
  assert.equal(pickActiveAfterDisappear(prev, next, 'b', true), 'c');
  const nextLast = prev.filter((x) => x.id !== 'c');
  assert.equal(pickActiveAfterDisappear(prev, nextLast, 'c', true), 'b');
});

test('removing the last regular tab clears focus instead of jumping to Startup', () => {
  const prev = [k('a', undefined), k('s', 'startup')];
  const next = prev.filter((x) => x.id !== 'a');
  assert.equal(pickActiveAfterDisappear(prev, next, 'a', true), null);
});

test('a project switch prefers a regular tab over Startup, else any tab', () => {
  const list = [k('a', undefined), k('s', 'startup')];
  assert.equal(pickActiveAfterDisappear([], list, 'x', false), 'a');
  assert.equal(pickActiveAfterDisappear([], [k('s', 'startup')], 'x', false), 's');
  assert.equal(pickActiveAfterDisappear([], [], 'x', false), null);
});
