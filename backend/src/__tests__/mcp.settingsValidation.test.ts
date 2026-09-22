// globalSettings MCP validation: untrusted-input sanitization + the built-in
// override trust boundary (an override may TUNE a built-in but never re-point
// what it runs). Split out of the original monolithic mcp.test.ts; adds
// malicious-shape coverage for the env code-injection denylist and the
// additive-only args guard. The sanitizers are imported via globalSettings.js to
// keep pinning that re-export surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeCustomServers,
  sanitizeBuiltinOverrides,
} from '../globalSettings.js';
import { applyBuiltinOverride } from '../mcp/settingsValidation.js';
import { isUnsafeOverrideArg } from '../mcp/overrideSecurity.js';
import { builtinMcpServerById } from '../mcp/catalog.js';

// ---- sanitizeCustomServers ----

test('sanitizeCustomServers keeps valid entries, drops idless junk, forces builtin:false', () => {
  const out = sanitizeCustomServers([
    { id: 'good', command: 'npx', args: ['-y', 'x', 42], builtin: true },
    { label: 'no id' },
    'garbage',
    null,
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'good');
  assert.equal(out[0].builtin, false); // can't smuggle builtin:true
  assert.deepEqual(out[0].args, ['-y', 'x']); // non-string arg filtered
  assert.equal(out[0].harnessSupport.claude, true); // default-on for claude
  assert.equal(out[0].harnessSupport.pi, false);
});

test('sanitizeCustomServers preserves secretHeaders for imported HTTP servers', () => {
  // The import header-leak fix records an auth header's name in `secretHeaders`
  // (the value lives in the secrets file). That field must survive persistence so
  // the resolver can re-inject at spawn; non-string junk is filtered.
  const out = sanitizeCustomServers([
    {
      id: 'remote',
      transport: 'http',
      url: 'https://x/mcp',
      headers: { Accept: 'application/json' },
      secretHeaders: ['Authorization', 42],
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].transport, 'http');
  assert.deepEqual(out[0].secretHeaders, ['Authorization']); // 42 filtered out
  assert.deepEqual(out[0].headers, { Accept: 'application/json' });
});

test('sanitizeCustomServers drops prototype-key ids and duplicate ids (first wins)', () => {
  // Ids key plain objects downstream (secrets map, Claude mcpServers, .pi/mcp.json):
  // `__proto__` would set a prototype, `constructor` resolves Object itself.
  const out = sanitizeCustomServers([
    { id: '__proto__', command: 'a' },
    { id: 'constructor', command: 'b' },
    { id: 'prototype', command: 'c' },
    { id: 'dup', command: 'first' },
    { id: 'dup', command: 'second' },
  ]);
  assert.deepEqual(
    out.map((e) => [e.id, e.command]),
    [['dup', 'first']],
  );
});

// ---- sanitizeBuiltinOverrides: shape + env denylist ----

test('sanitizeBuiltinOverrides keeps only the editable fields', () => {
  const out = sanitizeBuiltinOverrides({
    playwright: {
      args: ['-y', '@playwright/mcp@latest', '--browser', 'firefox'],
      env: { FOO: 'bar' },
      runtimeNote: 'tweaked',
      id: 'evil',
    },
    bogus: 'not an object',
  });
  assert.deepEqual(out.playwright.args, ['-y', '@playwright/mcp@latest', '--browser', 'firefox']);
  assert.deepEqual(out.playwright.env, { FOO: 'bar' });
  assert.equal(out.playwright.runtimeNote, 'tweaked');
  assert.ok(!('id' in out.playwright)); // identity can't be overridden
  assert.ok(!('bogus' in out));
});

test('sanitizeBuiltinOverrides drops command/url (no executable/endpoint swap)', () => {
  // A built-in override must not be able to re-point what the server runs.
  // Dropping command/url here keeps "definitions live in code" honest and
  // stops "toggle a known-safe built-in" from becoming "run an arbitrary
  // command" once enabled per-project.
  const out = sanitizeBuiltinOverrides({
    'brave-search': { command: 'C:/evil.exe', args: ['--pwn'], url: 'http://attacker/' },
  });
  assert.ok(!('command' in out['brave-search'])); // executable can't be overridden
  assert.ok(!('url' in out['brave-search'])); // endpoint can't be overridden
  assert.deepEqual(out['brave-search'].args, ['--pwn']); // arg array survives the shape pass
});

test('sanitizeBuiltinOverrides strips code-injection / launcher-hijack env vars', () => {
  // The env half of the trust gap: an override must not be able to inject a
  // code-exec / launcher-hijack var into an otherwise known-safe built-in.
  const out = sanitizeBuiltinOverrides({
    playwright: {
      env: {
        NODE_OPTIONS: '--require /tmp/evil.js', // arbitrary-module load
        LD_PRELOAD: '/tmp/evil.so', // native lib injection
        PATH: '/tmp/evil/bin', // which npx/node runs
        npm_config_registry: 'http://attacker/registry', // trojaned package source
        DEBUG: 'pw:api', // benign tuning → kept
      },
    },
  });
  const env = out.playwright.env ?? {};
  assert.ok(!('NODE_OPTIONS' in env), 'NODE_OPTIONS dropped');
  assert.ok(!('LD_PRELOAD' in env), 'LD_PRELOAD dropped');
  assert.ok(!('PATH' in env), 'PATH dropped');
  assert.ok(!('npm_config_registry' in env), 'npm_config_* dropped');
  assert.equal(env.DEBUG, 'pw:api', 'benign env tuning preserved');
});

// Regression: the denylist covered npm's registry re-point but not the Python
// launcher's (the `blender` built-in runs `uvx`), nor a CA+proxy MITM of the
// package fetch.
test('sanitizeBuiltinOverrides strips uv/pip/python and CA/proxy env vars', () => {
  const out = sanitizeBuiltinOverrides({
    blender: {
      env: {
        UV_INDEX_URL: 'http://attacker/simple',
        UV_EXTRA_INDEX_URL: 'http://attacker/simple',
        PIP_INDEX_URL: 'http://attacker/simple',
        PYTHONPATH: '/tmp/evil',
        PYTHONSTARTUP: '/tmp/evil.py',
        NODE_EXTRA_CA_CERTS: '/tmp/evil.pem',
        HTTPS_PROXY: 'http://attacker:8080',
        DISABLE_TELEMETRY: 'true',
      },
    },
  });
  assert.deepEqual(out.blender.env, { DISABLE_TELEMETRY: 'true' });
});

test('sanitizeBuiltinOverrides drops an override that is only a dangerous env', () => {
  // Every field stripped (the lone env var was dangerous) → no editable field
  // survives → the override id itself is dropped, not persisted as an empty husk.
  const out = sanitizeBuiltinOverrides({
    playwright: { env: { NODE_OPTIONS: '--require /evil.js' } },
  });
  assert.ok(!('playwright' in out));
});

// ---- applyBuiltinOverride: the catalog-aware merge (additive args + re-pin) ----

test('applyBuiltinOverride: additive browser flags are preserved', () => {
  const pw = builtinMcpServerById('playwright');
  assert.ok(pw);
  const merged = applyBuiltinOverride(pw, {
    args: ['-y', '@playwright/mcp@latest', '--isolated', '--browser', 'firefox'],
  });
  // The override reproduced the catalog launcher/package spec + baked-in flags
  // (incl. --isolated), then appended a safe flag — accepted verbatim.
  assert.deepEqual(merged.args, [
    '-y',
    '@playwright/mcp@latest',
    '--isolated',
    '--browser',
    'firefox',
  ]);
  assert.equal(merged.command, pw.command);
});

test('applyBuiltinOverride: a replacement args array is rejected (package spec protected)', () => {
  const brave = builtinMcpServerById('brave-search');
  assert.ok(brave);
  // Same length, different package spec → not additive → rejected.
  assert.deepEqual(
    applyBuiltinOverride(brave, { args: ['-y', 'evil-pkg'] }).args,
    brave.args,
    'swapping the package spec falls back to the catalog args',
  );
  // Shorter / rewritten arrays → rejected too.
  assert.deepEqual(applyBuiltinOverride(brave, { args: ['--pwn'] }).args, brave.args);
  // Dropping the `-y` launcher flag → rejected (prefix no longer preserved).
  assert.deepEqual(
    applyBuiltinOverride(brave, { args: ['@brave/brave-search-mcp-server', '--x'] }).args,
    brave.args,
  );
});

test('applyBuiltinOverride: identity + runner come from the catalog; safe fields fold in', () => {
  const brave = builtinMcpServerById('brave-search');
  assert.ok(brave);
  const merged = applyBuiltinOverride(brave, {
    // A crafted override trying to swap identity/runner — all ignored.
    id: 'evil',
    command: 'C:/evil.exe',
    url: 'http://attacker/',
    builtin: false,
    // Safe tuning that should fold in.
    env: { DEBUG: '1' },
    runtimeNote: 'note',
  });
  assert.equal(merged.id, brave.id);
  assert.equal(merged.command, brave.command); // still 'npx'
  assert.equal(merged.url, brave.url); // still undefined (stdio built-in)
  assert.equal(merged.builtin, true);
  assert.equal(merged.env?.DEBUG, '1');
  assert.equal(merged.runtimeNote, 'note');
});

test('applyBuiltinOverride: a malicious override cannot replace the catalog runner (end-to-end)', () => {
  // Feed a malicious override through the sanitizer (the same path
  // getGlobalSettings runs on read) and apply it the way mergedCatalog does. The
  // built-in keeps its code-defined runner; only safe tuning could ever land.
  const brave = builtinMcpServerById('brave-search');
  assert.ok(brave);
  const overrides = sanitizeBuiltinOverrides({
    'brave-search': { command: 'C:/evil.exe', args: ['--y', 'pwn'], env: { NODE_OPTIONS: '--require /e.js' } },
  });
  const merged = applyBuiltinOverride(brave, overrides['brave-search']);
  assert.equal(merged.command, brave.command); // still 'npx', not the injected exe
  assert.deepEqual(merged.args, brave.args); // replacement args rejected → catalog args stand
  assert.ok(!merged.env?.NODE_OPTIONS); // code-injection env never reached the merge
});

// ---- the first-party `lattice` entry is override-proof in the same way ------
//
// It is the one server that ships ON, so an override that could re-point it
// would be the highest-value target on the whole catalog: it would run under
// every Lattice-spawned agent, on every project, without anyone toggling
// anything. The generic guards must cover it exactly as they cover the rest.

test('applyBuiltinOverride: a lattice override cannot re-point command/args or clear defaultEnabled', () => {
  const lattice = builtinMcpServerById('lattice');
  assert.ok(lattice);
  const overrides = sanitizeBuiltinOverrides({
    lattice: {
      command: 'C:/evil.exe',
      args: ['C:/evil.js'],
      // Not a field the sanitizer keeps — asserted below that it can't sneak
      // through and switch Lattice's own board server off (or another one on).
      defaultEnabled: false,
      builtin: false,
      harnessSupport: { claude: false, codex: false, pi: false },
      runtimeNote: 'tuned',
    },
  });
  // `command` never survives the sanitizer; `defaultEnabled`/`builtin`/
  // `harnessSupport` aren't resolver-tunable fields, so they're dropped too.
  assert.equal(overrides.lattice.command, undefined);
  assert.ok(!('defaultEnabled' in overrides.lattice));
  assert.ok(!('builtin' in overrides.lattice));
  assert.ok(!('harnessSupport' in overrides.lattice));

  const merged = applyBuiltinOverride(lattice, overrides.lattice);
  assert.equal(merged.command, process.execPath); // still the backend's own node
  assert.deepEqual(merged.args, lattice.args); // replacement args rejected
  assert.equal(merged.defaultEnabled, true); // still on by default
  assert.equal(merged.builtin, true);
  assert.deepEqual(merged.harnessSupport, { claude: true, codex: true, pi: true });
  assert.equal(merged.runtimeNote, 'tuned'); // the one safe tweak lands
});

test('sanitizeCustomServers: a user-added server can never ship defaultEnabled', () => {
  // `defaultEnabled` is reserved for first-party catalog entries. A custom
  // server that could set it would be arbitrary user-supplied code running in
  // every agent Lattice spawns, with nothing switched on by anyone.
  const [entry] = sanitizeCustomServers([
    { id: 'sneaky', command: 'node', args: ['x.js'], defaultEnabled: true },
  ]);
  assert.equal(entry.id, 'sneaky');
  assert.equal(entry.defaultEnabled, undefined);
});

// ---- additive args: no flag may point a built-in at an arbitrary binary ----
//
// Appending keeps the package spec, but `--executable-path <x>` still makes
// Playwright / chrome-devtools launch `<x>` as "the browser" — i.e. run an
// arbitrary command. Every spelling, both `--flag value` and `--flag=value`,
// case-insensitive, rejects the whole override (the catalog args stand).

test('isUnsafeOverrideArg: binary-launching flags in every spelling and form', () => {
  for (const flag of [
    '--executable-path',
    '--executablePath',
    '--browser-executable',
    '--chrome-path',
    '--browser-path',
    '--EXECUTABLE-PATH',
    '--ExecutablePath',
    '--executable_path',
    '--Browser-Executable',
    '--CHROME-PATH',
    '--chromeArg',
    '--chrome-arg',
  ]) {
    assert.ok(isUnsafeOverrideArg(flag), `${flag} (flag value form)`);
    assert.ok(isUnsafeOverrideArg(`${flag}=C:/evil.exe`), `${flag}=value form`);
  }
  // Ordinary tuning flags and plain values stay allowed.
  for (const ok of ['--browser', '--browser=firefox', 'firefox', '--headless', '--isolated', '--viewport-size=1280,720', '--executable', 'C:/evil.exe']) {
    assert.equal(isUnsafeOverrideArg(ok), false, ok);
  }
});

test('isUnsafeOverrideArg: chrome-devtools short alias -e, only for that server', () => {
  for (const a of ['-e', '-E', '-e=C:/evil.exe', '-eC:/evil.exe', '-ie']) {
    assert.ok(isUnsafeOverrideArg(a, 'chrome-devtools'), a);
  }
  assert.equal(isUnsafeOverrideArg('-y', 'chrome-devtools'), false);
  assert.equal(isUnsafeOverrideArg('-e', 'playwright'), false);
});

test('applyBuiltinOverride: --executable-path (both forms) is refused for playwright + chrome-devtools', () => {
  const pw = builtinMcpServerById('playwright');
  const cd = builtinMcpServerById('chrome-devtools');
  assert.ok(pw && cd);
  const cases: Array<[typeof pw, string[]]> = [
    [pw, ['--executable-path', 'C:/evil.exe']],
    [pw, ['--Executable-Path=C:/evil.exe']],
    [pw, ['--browser', 'chrome', '--browser-executable', '/tmp/x']],
    [cd, ['--executablePath', 'C:/evil.exe']],
    [cd, ['--EXECUTABLEPATH=C:/evil.exe']],
    [cd, ['--chrome-path=C:/evil.exe']],
    [cd, ['--browser-path', 'C:/evil.exe']],
    [cd, ['--chromeArg=--renderer-cmd-prefix=C:/evil.exe']],
    [cd, ['-e', 'C:/evil.exe']],
  ];
  for (const [entry, extra] of cases) {
    const overrides = sanitizeBuiltinOverrides({ [entry.id]: { args: [...(entry.args ?? []), ...extra] } });
    const merged = applyBuiltinOverride(entry, overrides[entry.id]);
    assert.deepEqual(merged.args, entry.args, `${entry.id} ${extra.join(' ')}`);
  }
  // A safe additive flag on the same servers still lands.
  const ok = applyBuiltinOverride(cd, { args: [...(cd.args ?? []), '--headless'] });
  assert.deepEqual(ok.args, [...(cd.args ?? []), '--headless']);
});

test('isUnsafeOverrideArg: Playwright --config (a file that can set executablePath) is refused for playwright only', () => {
  for (const arg of ['--config', '--config=./pw.json', '--CONFIG', '--Config=x']) {
    assert.ok(isUnsafeOverrideArg(arg, 'playwright'), arg);
  }
  // Other servers' own --config flags aren't this escape.
  assert.equal(isUnsafeOverrideArg('--config', 'chrome-devtools'), false);
  assert.equal(isUnsafeOverrideArg('--config'), false);
  // A near-miss is not caught.
  assert.equal(isUnsafeOverrideArg('--config-dir', 'playwright'), false);
});
