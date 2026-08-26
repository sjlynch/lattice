import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getUserSettings, patchUserSettings } from '../userSettings.js';

// Regression: `startupTerminals` is the one setting agents hand-write through
// `PATCH /api/settings`, and nothing validated the shape. An entry that guessed
// the field names — `{name: 'stack', command: '…'}`, no `id`, no `label` — was
// stored verbatim, and the Settings dialog then threw
// "Cannot read properties of undefined (reading 'trim')" on `label.trim()`,
// leaving that project's settings permanently un-editable through the UI that
// would have repaired the row (2026-08-26, interview_eci). Both the read and
// the write path now coerce entries to `{id, label, command}`.

async function mkProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lattice-startup-'));
}

async function writeRaw(project: string, settings: unknown): Promise<void> {
  const dir = path.join(project, '.lattice');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'userSettings.json'),
    JSON.stringify(settings, null, 2),
    'utf8',
  );
}

test('getUserSettings heals an agent-written {name, command} row on read', async () => {
  const project = await mkProject();
  try {
    // Exactly what was found on disk in interview_eci.
    await writeRaw(project, {
      startupTerminals: [{ name: 'stack', command: 'npm run db:up && npm run dev' }],
      sidebarWidth: 770,
    });

    const settings = await getUserSettings(project);
    const rows = settings.startupTerminals ?? [];
    assert.equal(rows.length, 1);
    // `name` is accepted as a label alias — the row is repaired, not discarded.
    assert.equal(rows[0].label, 'stack');
    assert.equal(rows[0].command, 'npm run db:up && npm run dev');
    assert.equal(typeof rows[0].id, 'string');
    assert.ok(rows[0].id.length > 0);
    // Untouched fields survive.
    assert.equal(settings.sidebarWidth, 770);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('a minted id is stable across reads (a changing id would double-spawn the pty)', async () => {
  const project = await mkProject();
  try {
    await writeRaw(project, {
      startupTerminals: [{ name: 'stack', command: 'npm run dev' }],
    });
    const first = await getUserSettings(project);
    const second = await getUserSettings(project);
    assert.equal(
      first.startupTerminals?.[0].id,
      second.startupTerminals?.[0].id,
    );
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('two id-less rows with the same command still get distinct ids', async () => {
  const project = await mkProject();
  try {
    await writeRaw(project, {
      startupTerminals: [
        { label: 'a', command: 'npm run dev' },
        { label: 'a', command: 'npm run dev' },
      ],
    });
    const rows = (await getUserSettings(project)).startupTerminals ?? [];
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].id, rows[1].id);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('patchUserSettings coerces a malformed write instead of storing it', async () => {
  const project = await mkProject();
  try {
    // The shape an agent POSTs when it guesses. Also covers junk entries and a
    // commandless row (a no-op the UI drops on its next save anyway).
    await patchUserSettings(project, {
      startupTerminals: [
        { name: 'dev server', command: '  npm run dev  ' },
        { command: '' },
        null,
        'nonsense',
        { id: 'kept', label: 'explicit', command: 'npm start' },
      ] as never,
    });

    const onDisk = JSON.parse(
      await fs.readFile(path.join(project, '.lattice', 'userSettings.json'), 'utf8'),
    );
    assert.deepEqual(
      onDisk.startupTerminals.map((t: { label: string; command: string }) => [
        t.label,
        t.command,
      ]),
      [
        ['dev server', 'npm run dev'],
        ['explicit', 'npm start'],
      ],
    );
    for (const row of onDisk.startupTerminals) {
      assert.deepEqual(Object.keys(row).sort(), ['command', 'id', 'label']);
    }
    // An explicit id is preserved — the sidebar matches a running pty by it.
    assert.equal(onDisk.startupTerminals[1].id, 'kept');
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('a non-array startupTerminals cannot reach a consumer as one', async () => {
  const project = await mkProject();
  try {
    await writeRaw(project, { startupTerminals: { name: 'stack', command: 'x' } });
    const settings = await getUserSettings(project);
    assert.deepEqual(settings.startupTerminals, []);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('a patch that does not mention startupTerminals leaves the saved list alone', async () => {
  const project = await mkProject();
  try {
    await patchUserSettings(project, {
      startupTerminals: [{ id: 'a', label: 'dev', command: 'npm run dev' }],
    });
    await patchUserSettings(project, { sidebarWidth: 500 });
    const settings = await getUserSettings(project);
    assert.equal(settings.sidebarWidth, 500);
    assert.deepEqual(settings.startupTerminals, [
      { id: 'a', label: 'dev', command: 'npm run dev' },
    ]);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});
