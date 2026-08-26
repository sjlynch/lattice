import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubInheritedNpmEnv } from '../terminal/envSetup.js';
import { buildSessionLaunchContext } from '../terminal/launchContext.js';

// Lattice's backend is itself an npm run-script, and every pty inherits the
// backend's environment wholesale. Two things rode along that shouldn't have:
//
//   1. `npm_config_prefix` — npm's "the folder where globally installed tools
//      go" — which silently sent `npm install -g` in ANY Lattice terminal, in
//      ANY project, into `<latticeRoot>/backend`.
//   2. the `node_modules/.bin` PATH entries npm prepends for the package it
//      runs and every ancestor of it, which lent every terminal Lattice's own
//      `tsc` / `tsx` / `playwright`.
//
// See terminal/envSetup.ts for the full note. `platform` is passed explicitly
// throughout so these stay deterministic on any host.

// --- environment keys ------------------------------------------------------

test('drops the inherited npm prefix family', () => {
  const env: { [key: string]: string } = {
    npm_config_prefix: 'C:\\development\\lattice\\backend',
    npm_config_global_prefix: 'C:\\development\\lattice\\backend',
    npm_config_local_prefix: 'C:\\development\\lattice\\backend',
    npm_config_globalconfig: 'C:\\development\\lattice\\backend\\etc\\npmrc',
  };
  scrubInheritedNpmEnv(env, 'win32');
  assert.deepEqual(env, {}, 'every prefix-family key removed');
});

test("keeps the user's own npm config — registry, cache, auth, userconfig", () => {
  // A blanket npm_config_* scrub would break installs against a private
  // registry inside Lattice terminals only. These are the user's ambient
  // configuration, not something Lattice's boot invented.
  const env: { [key: string]: string } = {
    npm_config_registry: 'https://registry.internal.example/',
    npm_config_cache: 'C:\\Users\\me\\AppData\\Local\\npm-cache',
    npm_config_userconfig: 'C:\\Users\\me\\.npmrc',
    'npm_config_//registry.internal.example/:_authToken': 'secret',
    npm_config_prefix: 'C:\\development\\lattice\\backend',
  };
  scrubInheritedNpmEnv(env, 'win32');
  assert.equal(env.npm_config_prefix, undefined, 'prefix still dropped');
  assert.equal(env.npm_config_registry, 'https://registry.internal.example/');
  assert.equal(env.npm_config_cache, 'C:\\Users\\me\\AppData\\Local\\npm-cache');
  assert.equal(env.npm_config_userconfig, 'C:\\Users\\me\\.npmrc');
  assert.equal(
    env['npm_config_//registry.internal.example/:_authToken'],
    'secret',
    'auth token preserved',
  );
});

test('drops the lifecycle/package context describing Lattice itself', () => {
  const env: { [key: string]: string } = {
    npm_command: 'run-script',
    npm_execpath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    npm_node_execpath: 'C:\\Program Files\\nodejs\\node.exe',
    npm_lifecycle_event: 'dev',
    npm_lifecycle_script: 'node scripts/dev.mjs',
    npm_package_name: 'lattice-backend',
    npm_package_version: '0.1.0',
    npm_package_json: 'C:\\development\\lattice\\backend\\package.json',
    INIT_CWD: 'C:\\development\\lattice',
  };
  scrubInheritedNpmEnv(env, 'win32');
  assert.deepEqual(env, {}, 'no npm run-script context survives into a pty');
});

test('leaves everything else untouched, and matches case-insensitively', () => {
  const env: { [key: string]: string } = {
    HOME: 'C:\\Users\\me',
    ANTHROPIC_API_KEY: 'sk-test',
    NPM_CONFIG_PREFIX: 'C:\\development\\lattice\\backend',
    NPM_PACKAGE_NAME: 'lattice-backend',
  };
  scrubInheritedNpmEnv(env, 'win32');
  assert.deepEqual(env, { HOME: 'C:\\Users\\me', ANTHROPIC_API_KEY: 'sk-test' });
});

test('is a no-op on an env that never went through npm', () => {
  const env: { [key: string]: string } = {
    Path: 'C:\\Windows',
    SHELL: '/bin/bash',
  };
  scrubInheritedNpmEnv(env, 'win32');
  assert.deepEqual(env, { Path: 'C:\\Windows', SHELL: '/bin/bash' });
});

// --- PATH entries ----------------------------------------------------------

const LATTICE = 'C:\\development\\lattice';

function winEnv(): { [key: string]: string } {
  return {
    Path: [
      LATTICE + '\\backend\\node_modules\\.bin',
      LATTICE + '\\node_modules\\.bin',
      'C:\\development\\node_modules\\.bin',
      'C:\\node_modules\\.bin',
      'C:\\Windows\\system32',
      'C:\\Program Files\\nodejs',
      'C:\\Users\\me\\AppData\\Roaming\\npm',
      'C:\\Users\\me\\.local\\bin',
    ].join(';'),
    npm_config_local_prefix: LATTICE + '\\backend',
  };
}

test("removes exactly npm's injected .bin entries, keeps every real one", () => {
  const env = winEnv();
  scrubInheritedNpmEnv(env, 'win32');
  assert.deepEqual(env.Path.split(';'), [
    'C:\\Windows\\system32',
    'C:\\Program Files\\nodejs',
    // The harness commands live in these two directories (codex/pi in the real
    // global npm folder, claude in ~/.local/bin). Spawning an agent must never
    // depend on anything this cleanup touches.
    'C:\\Users\\me\\AppData\\Roaming\\npm',
    'C:\\Users\\me\\.local\\bin',
  ]);
});

test("an unrelated project's node_modules/.bin is never touched", () => {
  // Only ancestors of npm's local prefix are npm's doing. A bin directory the
  // user put on PATH themselves is theirs, and must survive.
  const env = winEnv();
  env.Path = 'C:\\work\\someapp\\node_modules\\.bin;' + env.Path;
  scrubInheritedNpmEnv(env, 'win32');
  assert.ok(
    env.Path.split(';').includes('C:\\work\\someapp\\node_modules\\.bin'),
    "an unrelated project's .bin survives",
  );
});

test('matches PATH entries regardless of case or trailing separator', () => {
  const env = winEnv();
  env.Path =
    'C:\\DEVELOPMENT\\LATTICE\\BACKEND\\node_modules\\.bin\\;C:\\Windows\\system32';
  scrubInheritedNpmEnv(env, 'win32');
  assert.deepEqual(env.Path.split(';'), ['C:\\Windows\\system32']);
});

test('works on posix too, and is case-SENSITIVE there', () => {
  const env: { [key: string]: string } = {
    PATH: [
      '/home/me/lattice/backend/node_modules/.bin',
      '/home/me/lattice/node_modules/.bin',
      '/home/me/Lattice/node_modules/.bin', // a genuinely different directory
      '/usr/local/bin',
    ].join(':'),
    npm_config_local_prefix: '/home/me/lattice/backend',
  };
  scrubInheritedNpmEnv(env, 'linux');
  assert.deepEqual(env.PATH.split(':'), [
    '/home/me/Lattice/node_modules/.bin',
    '/usr/local/bin',
  ]);
});

test('leaves PATH alone when Lattice was not started through npm', () => {
  // No local prefix => npm injected nothing => there is nothing to reverse.
  const original =
    LATTICE + '\\backend\\node_modules\\.bin;C:\\Windows\\system32';
  const env: { [key: string]: string } = { Path: original };
  scrubInheritedNpmEnv(env, 'win32');
  assert.equal(env.Path, original);
});

// --- end-to-end guard ------------------------------------------------------
//
// Every test above can pass while the call site is gone. This one drives the
// real buildSessionLaunchContext against a poisoned process.env and asserts
// that nothing describing Lattice's own npm boot reaches a pty. It is the check
// that fails if someone deletes the scrub, moves it after applyFreshWindowsPath,
// reintroduces `npm --prefix` in the dev orchestrator, or adds a new leak of
// the same shape.

// npm keys that are the USER's own configuration rather than Lattice's boot,
// and so are deliberately passed through. Anything new must be added here
// consciously — which is the point of the guard.
// Note this guard reads the AMBIENT env, so it also sees whatever npm exported
// into the test runner itself — which is why it must name every user-config key
// npm resolves, not just the ones this test plants. `noproxy` / `init_module` /
// `allow_scripts` come from the user's `.npmrc` (or npm's defaults for it) and
// are the same class as `registry` / `cache`.
const ALLOWED_NPM_KEYS =
  /^npm_config_(registry|cache|userconfig|noproxy|init_module|allow_scripts|\/\/)/i;

test('no npm boot context of any kind reaches a spawned terminal', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-envleak-'));
  const fakeLattice = path.join(tmp, 'lattice');
  const fakeBackend = path.join(fakeLattice, 'backend');
  fs.mkdirSync(fakeBackend, { recursive: true });

  // Exactly what `npm --prefix backend run dev` used to export, verbatim.
  const poison: { [key: string]: string } = {
    npm_config_prefix: fakeBackend,
    npm_config_global_prefix: fakeBackend,
    npm_config_local_prefix: fakeBackend,
    npm_config_globalconfig: path.join(fakeBackend, 'etc', 'npmrc'),
    npm_command: 'run-script',
    npm_execpath: '/npm/bin/npm-cli.js',
    npm_node_execpath: '/node',
    npm_lifecycle_event: 'dev',
    npm_lifecycle_script: 'node scripts/dev.mjs',
    npm_package_name: 'lattice-backend',
    npm_package_version: '0.1.0',
    INIT_CWD: fakeLattice,
    // ...alongside a real user setting, which must survive.
    npm_config_registry: 'https://registry.internal.example/',
  };

  const pathKey =
    Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const saved = new Map<string, string | undefined>();
  for (const key of [...Object.keys(poison), pathKey]) {
    saved.set(key, process.env[key]);
  }

  try {
    for (const [key, value] of Object.entries(poison)) process.env[key] = value;
    process.env[pathKey] = [
      path.join(fakeBackend, 'node_modules', '.bin'),
      path.join(fakeLattice, 'node_modules', '.bin'),
      saved.get(pathKey) ?? '',
    ].join(path.delimiter);

    const ctx = buildSessionLaunchContext({ cwd: tmp, projectPath: tmp });
    assert.ok(!('error' in ctx), 'launch context built');
    if ('error' in ctx) return;

    const leaked = Object.keys(ctx.env).filter(
      (k) => /^(npm_|init_cwd$)/i.test(k) && !ALLOWED_NPM_KEYS.test(k),
    );
    assert.deepEqual(leaked, [], 'no npm boot keys reach the pty');
    assert.equal(
      ctx.env.npm_config_registry,
      'https://registry.internal.example/',
      "the user's own registry setting still reaches the pty",
    );

    const resolved = ctx.env.Path ?? ctx.env.PATH ?? '';
    for (const entry of resolved.split(path.delimiter)) {
      assert.ok(
        !entry.toLowerCase().startsWith(fakeLattice.toLowerCase()),
        "PATH entry points inside Lattice's own install: " + entry,
      );
    }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
