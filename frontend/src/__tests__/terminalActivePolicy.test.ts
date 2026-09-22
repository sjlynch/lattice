import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TerminalSpec } from '../terminal/terminalTypes';
import {
  pickActiveAfterClose,
  pickActiveAfterCloseMany,
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
