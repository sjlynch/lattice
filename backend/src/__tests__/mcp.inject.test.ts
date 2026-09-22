// MCP injection hygiene: reconcileMcpServers (add/strip/preserve) + the win32
// package-runner wrapping. Split out of the original monolithic mcp.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MANAGED_MCP_MARKER,
  UnsafeCmdArgumentError,
  escapeCmdArgument,
  platformizeCommand,
  reconcileMcpServers,
  windowsShimIsBatch,
  type ClaudeMcpServerConfig,
} from '../mcp/claudeInject.js';
import { withTempDir } from './helpers/tempDir.js';
import { resolveClaudeServers, resolveCodexServers, resolvePiServers } from '../mcp/registry.js';
import type { McpServerEntry } from '../mcp/catalog.js';

// ---- reconcileMcpServers: the injection-hygiene contract ----
//
// Managed servers are added/updated, previously-managed-now-disabled ones are
// stripped, and the user's own hand-added entries are never touched.

function cfg(command: string): ClaudeMcpServerConfig {
  return { type: 'stdio', command };
}

test('reconcile adds managed servers and records the marker', () => {
  const entry: Record<string, unknown> = {};
  reconcileMcpServers(entry, { brave: cfg('npx') });
  assert.deepEqual(entry.mcpServers, { brave: cfg('npx') });
  assert.deepEqual(entry[MANAGED_MCP_MARKER], ['brave']);
});

test('reconcile preserves the user’s own (unmanaged) servers', () => {
  const entry: Record<string, unknown> = {
    mcpServers: { mine: cfg('node') },
  };
  reconcileMcpServers(entry, { brave: cfg('npx') });
  assert.deepEqual(entry.mcpServers, { mine: cfg('node'), brave: cfg('npx') });
});

test('reconcile strips a previously-managed server that is now disabled', () => {
  const entry: Record<string, unknown> = {
    mcpServers: { brave: cfg('npx'), mine: cfg('node') },
    [MANAGED_MCP_MARKER]: ['brave'],
  };
  // brave no longer in the managed set → stripped; user's `mine` stays.
  reconcileMcpServers(entry, {});
  assert.deepEqual(entry.mcpServers, { mine: cfg('node') });
  assert.equal(entry[MANAGED_MCP_MARKER], undefined);
});

test('reconcile drops the marker when nothing is managed', () => {
  const entry: Record<string, unknown> = {};
  reconcileMcpServers(entry, {});
  assert.deepEqual(entry.mcpServers, {});
  assert.ok(!(MANAGED_MCP_MARKER in entry));
});

// ---- platformizeCommand: Windows package-runner wrapping ----

test('platformizeCommand wraps npx in cmd /c on win32, passes node through', () => {
  const wrapped = platformizeCommand('npx', ['-y', 'pkg']);
  const node = platformizeCommand('node', ['server.js']);
  if (process.platform === 'win32') {
    assert.deepEqual(wrapped, { command: 'cmd', args: ['/c', 'npx', '-y', 'pkg'] });
    assert.deepEqual(node, { command: 'node', args: ['server.js'] });
  } else {
    assert.deepEqual(wrapped, { command: 'npx', args: ['-y', 'pkg'] });
  }
});

test('platformizeCommand leaves an absolute node.exe path alone', () => {
  // The `lattice` catalog entry runs `process.execPath` — a real `.exe`, not a
  // package-runner shim — so it must NOT be `cmd /c`-wrapped. Wrapping would
  // route the spawn through cmd's own quoting rules, and the path has a space
  // in it on a default Windows install (`C:\Program Files\nodejs\node.exe`).
  const args = ['C:\\dev\\lattice\\backend\\dist\\latticeMcp\\server.js'];
  assert.deepEqual(platformizeCommand(process.execPath, args), {
    command: process.execPath,
    args,
  });
  assert.deepEqual(platformizeCommand('C:\\Program Files\\nodejs\\node.exe', args), {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args,
  });
});

test('platformizeCommand: ordinary package-runner args are unchanged by escaping', () => {
  // The catalog's real args carry no cmd metachars, so the escaped form is
  // byte-identical to the old unescaped one — for a batch shim and an .exe.
  const args = ['-y', '@playwright/mcp@latest', '--isolated', '--headless', '--browser=firefox'];
  for (const batch of [true, false]) {
    assert.deepEqual(platformizeCommand('npx', args, { platform: 'win32', batch }), {
      command: 'cmd',
      args: ['/c', 'npx', ...args],
    });
  }
  // Non-win32 never wraps or escapes.
  assert.deepEqual(platformizeCommand('npx', ['a&b'], { platform: 'linux' }), {
    command: 'npx',
    args: ['a&b'],
  });
});

// ---- escapeCmdArgument: the pure escaper ----

test('escapeCmdArgument: verbatim args get one caret layer per cmd parse', () => {
  // .exe target: parsed once by cmd.
  assert.equal(escapeCmdArgument('a&b', false), 'a^&b');
  assert.equal(escapeCmdArgument('a|b', false), 'a^|b');
  assert.equal(escapeCmdArgument('<x>', false), '^<x^>');
  assert.equal(escapeCmdArgument('(x)', false), '^(x^)');
  assert.equal(escapeCmdArgument('a^b', false), 'a^^b');
  assert.equal(escapeCmdArgument('%PATH%', false), '^%PATH^%');
  assert.equal(escapeCmdArgument('!X!', false), '^!X^!');
  // .cmd/.bat target: parsed twice (the `cmd /c` line, then the shim's `%*`).
  assert.equal(escapeCmdArgument('a&b', true), 'a^^^&b');
  assert.equal(escapeCmdArgument('a^b', true), 'a^^^^b');
  assert.equal(escapeCmdArgument('%PATH%', true), '^^^%PATH^^^%');
  // Nothing to escape → identical, including backslashes (trailing too).
  assert.equal(escapeCmdArgument('C:\\dir\\', true), 'C:\\dir\\');
  assert.equal(escapeCmdArgument('--flag=value', true), '--flag=value');
  assert.equal(escapeCmdArgument('@scope/pkg@1.2.3', true), '@scope/pkg@1.2.3');
});

test('escapeCmdArgument: whitespace args are left for the transport to quote', () => {
  // Inside the quotes libuv / Rust add, cmd reads & | < > ( ) ^ literally on
  // both parses — a caret there would survive as a literal, so none is added.
  assert.equal(escapeCmdArgument('a b', true), 'a b');
  assert.equal(escapeCmdArgument('a & b', true), 'a & b');
  assert.equal(escapeCmdArgument('x|y z^', false), 'x|y z^');
  assert.equal(escapeCmdArgument('C:\\Program Files\\x\\', true), 'C:\\Program Files\\x\\');
  assert.equal(escapeCmdArgument('', true), '');
});

test('escapeCmdArgument: refuses what cmd cannot carry', () => {
  // `"` → the transport's `\"` desyncs cmd's quote state for every later arg.
  assert.throws(() => escapeCmdArgument('a"b', true), UnsafeCmdArgumentError);
  assert.throws(() => escapeCmdArgument('"quoted arg"', false), UnsafeCmdArgumentError);
  // % / ! inside a transport-quoted arg still expand, with no escape.
  assert.throws(() => escapeCmdArgument('a %PATH%', true), UnsafeCmdArgumentError);
  assert.throws(() => escapeCmdArgument('a !X!', false), UnsafeCmdArgumentError);
  // A newline would end the cmd command outright.
  assert.throws(() => escapeCmdArgument('a\r\ncalc', true), UnsafeCmdArgumentError);
  assert.throws(() => escapeCmdArgument('a\u0000', true), UnsafeCmdArgumentError);
  // …and platformizeCommand surfaces it (the registry shapers skip the server).
  assert.throws(
    () => platformizeCommand('npx', ['-y', 'x"&calc'], { platform: 'win32', batch: true }),
    UnsafeCmdArgumentError,
  );
});

test('windowsShimIsBatch: first PATH × PATHEXT hit decides; unknown fails safe (batch)', () => {
  const env = { PATH: 'C:\\a;C:\\b', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const has = (files: string[]) => (p: string) => files.includes(p.toLowerCase());
  assert.equal(windowsShimIsBatch('npx', env, has(['c:\\b\\npx.cmd'])), true);
  assert.equal(windowsShimIsBatch('uvx', env, has(['c:\\a\\uvx.exe', 'c:\\b\\uvx.cmd'])), false);
  // Directory order beats extension order.
  assert.equal(windowsShimIsBatch('uvx', env, has(['c:\\a\\uvx.cmd', 'c:\\b\\uvx.exe'])), true);
  assert.equal(windowsShimIsBatch('nope', env, has([])), true);
});

// ---- end to end through the real cmd.exe (win32 only) ----
//
// Spawn exactly the way a harness MCP client does — `spawn('cmd', args)` with
// Node/libuv's own argument quoting, no shell — into (a) a `.cmd` shim shaped
// like npm's `npx.cmd` (`"%NODE_EXE%" "…js" %*`) and (b) a real `.exe`, and
// check the server process receives every arg byte-for-byte, with no injected
// command, redirect or variable expansion.

const TRICKY_ARGS = [
  '-y',
  '@playwright/mcp@latest',
  '--headless',
  'a&echo.PWNED',
  'a|findstr x',
  'a b',
  'a & echo PWNED',
  'x>pwned.txt',
  '<in',
  '(paren)',
  'caret^',
  '^^',
  '%PATH%',
  '%LATTICE_CANARY%',
  '!LATTICE_CANARY!',
  '%',
  'C:\\trailing\\',
  'C:\\with space\\',
  'https://x.test/?a=1&b=2%20c',
  '--flag=a&b',
  'a,b;c=d',
  '*?',
  '',
];

test(
  'escapeCmdArgument end to end: cmd /c <shim.cmd> and <exe> receive args verbatim',
  { skip: process.platform !== 'win32' },
  async () => {
    await withTempDir('lattice-cmdesc-', async (dir) => {
      const echoJs = path.join(dir, 'echo.js');
      await fs.writeFile(echoJs, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
      await fs.writeFile(
        path.join(dir, 'echoargs.cmd'),
        [
          '@ECHO OFF',
          'SETLOCAL',
          `SET "NODE_EXE=${process.execPath}"`,
          '"%NODE_EXE%" "%~dp0echo.js" %*',
          '',
        ].join('\r\n'),
      );
      const env = {
        ...process.env,
        PATH: `${dir};${path.dirname(process.execPath)};${process.env.PATH ?? ''}`,
        LATTICE_CANARY: 'LEAKED',
      };
      const run = (args: string[]) => {
        const r = spawnSync('cmd', args, { cwd: dir, env, encoding: 'utf8', windowsHide: true });
        assert.equal(r.status, 0, r.stderr);
        return r.stdout;
      };
      // (a) batch shim: resolved as batch from PATH, double-escaped.
      assert.equal(windowsShimIsBatch('echoargs', env), true);
      const batchArgs = TRICKY_ARGS.map((a) => escapeCmdArgument(a, true));
      assert.deepEqual(JSON.parse(run(['/c', 'echoargs', ...batchArgs])), TRICKY_ARGS);
      // (b) real exe (node.exe): single-escaped.
      const exeArgs = [echoJs, ...TRICKY_ARGS].map((a) => escapeCmdArgument(a, false));
      assert.deepEqual(JSON.parse(run(['/c', 'node', ...exeArgs])), TRICKY_ARGS);
      // Nothing was redirected into a file.
      await assert.rejects(fs.stat(path.join(dir, 'pwned.txt')));
      // Control: the UNescaped form really is injectable, so the test can't pass
      // for the wrong reason.
      assert.match(run(['/c', 'echoargs', 'a&echo.PWNED']), /PWNED/);
    });
  },
);

test(
  'shapers skip (not crash on) a server whose args cannot cross cmd /c; the rest still resolve',
  { skip: process.platform !== 'win32' },
  () => {
    const mk = (id: string, args: string[]): McpServerEntry => ({
      id,
      label: id,
      description: '',
      transport: 'stdio',
      runtime: 'node',
      command: 'npx',
      args,
      harnessSupport: { claude: true, codex: true, pi: true },
      builtin: false,
    });
    const catalog = [mk('bad', ['-y', 'pkg', '--x="y"']), mk('good', ['-y', 'pkg', 'a&b'])];
    const on = { bad: true, good: true };
    const settings = { mcpOverrides: on, mcpHarnessOverrides: { codex: on, pi: on } };
    const claude = resolveClaudeServers(catalog, settings, {});
    assert.deepEqual(Object.keys(claude), ['good']);
    const good = claude.good as { args?: string[] };
    assert.ok(good.args?.includes('a^^^&b') || good.args?.includes('a^&b'));
    const codex = resolveCodexServers(catalog, settings, {});
    assert.equal(codex.configArgs.length, 1);
    assert.ok(codex.configArgs[0].startsWith('mcp_servers.lattice_good='));
    assert.deepEqual(Object.keys(resolvePiServers(catalog, settings, {}).mcpServers), ['good']);
  },
);
