import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PI_SUBAGENTS_SHIM_FILENAME,
  getPiSubagentsEntry,
  renderPiSubagentsShim,
} from '../piSubagents.js';

test('renderPiSubagentsShim re-exports the default from the given entry', () => {
  const entry =
    'C:/Users/x/.lattice/pi-extensions/.pi/npm/node_modules/@tintinweb/pi-subagents/src/index.ts';
  const out = renderPiSubagentsShim(entry);
  // Must re-export the extension's default activation fn (Pi calls the default).
  assert.ok(out.includes('export { default } from'));
  // Path is emitted as a JSON string literal so backslashes/quotes can't break
  // the generated TS.
  assert.ok(out.includes(JSON.stringify(entry)));
});

test('shim filename is a .ts so Pi auto-discovers it', () => {
  assert.ok(PI_SUBAGENTS_SHIM_FILENAME.endsWith('.ts'));
});

test('entry is null before any install resolves', () => {
  // No install has run in the unit-test process, so the cached entry is null
  // and the shim install is a graceful no-op.
  assert.equal(getPiSubagentsEntry(), null);
});
