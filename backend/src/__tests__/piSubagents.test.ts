import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  PI_SUBAGENTS_SHIM_FILENAME,
  getPiSubagentsEntry,
  renderPiSubagentsShim,
  isPiSubagentsGloballyInstalled,
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

test('isPiSubagentsGloballyInstalled detects the package in settings.json packages', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-agent-'));
  await fs.writeFile(
    path.join(dir, 'settings.json'),
    JSON.stringify({ packages: ['npm:@tintinweb/pi-subagents'] }),
    'utf8',
  );
  assert.equal(await isPiSubagentsGloballyInstalled(dir), true);
});

test('isPiSubagentsGloballyInstalled detects a physical node_modules install', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-agent-'));
  // settings.json absent / empty packages, but the package is on disk.
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ packages: [] }), 'utf8');
  const pkgDir = path.join(dir, 'npm', 'node_modules', '@tintinweb', 'pi-subagents');
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(path.join(pkgDir, 'package.json'), '{}', 'utf8');
  assert.equal(await isPiSubagentsGloballyInstalled(dir), true);
});

test('isPiSubagentsGloballyInstalled is false when neither signal is present', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-agent-'));
  assert.equal(await isPiSubagentsGloballyInstalled(dir), false);
});
