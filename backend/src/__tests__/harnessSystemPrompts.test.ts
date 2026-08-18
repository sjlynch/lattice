import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  configureClaudeSystemPrompt,
  LATTICE_CLAUDE_SYSTEM_PROMPT_FILE_ENV,
  LATTICE_CLAUDE_APPEND_SYSTEM_PROMPT_FILE_ENV,
} from '../terminal/claudeSystemPrompt.js';
import {
  configureCodexProjectMcp,
  configureCodexSystemPrompt,
  codexSystemPromptOverrideEnv,
  codexMcpOverrideEnv,
} from '../terminal/codexTrust.js';
import {
  renderPiSystemPromptExtension,
  applyPiSystemPromptForSpawn,
  PI_SYSTEM_PROMPT_EXTENSION_FILENAME,
  PI_SYSTEM_PROMPT_CONFIG_FILENAME,
} from '../harnessSystemPrompts/piShim.js';
import { resolveHarnessSystemPrompt } from '../harnessSystemPrompts/resolve.js';
import {
  prepareClaudeSystemPrompt,
  prepareCodexSystemPrompt,
  preparePiSystemPrompt,
} from '../harnessSystemPrompts/inject.js';
import { buildHarnessSystemPromptEditorData } from '../harnessSystemPrompts/editorData.js';
import { homeProjectScratchDir } from '../projectPath.js';
import { patchUserSettings } from '../userSettings.js';

const SHELL = 'bash'; // shellEnvRef → "$VAR" on POSIX, deterministic to assert.

// --- Claude command rewriting -------------------------------------------------

test('configureClaudeSystemPrompt adds both flags and stashes paths in env', () => {
  const env: Record<string, string> = {};
  const out = configureClaudeSystemPrompt(
    'claude --dangerously-skip-permissions "do the thing"',
    { replaceFile: '/abs/sys.md', appendFile: '/abs/append.md' },
    SHELL,
    env,
  );
  assert.equal(
    out,
    'claude --system-prompt-file "$LATTICE_CLAUDE_SYSTEM_PROMPT_FILE" ' +
      '--append-system-prompt-file "$LATTICE_CLAUDE_APPEND_SYSTEM_PROMPT_FILE" ' +
      '--dangerously-skip-permissions "do the thing"',
  );
  assert.equal(env[LATTICE_CLAUDE_SYSTEM_PROMPT_FILE_ENV], '/abs/sys.md');
  assert.equal(env[LATTICE_CLAUDE_APPEND_SYSTEM_PROMPT_FILE_ENV], '/abs/append.md');
});

test('configureClaudeSystemPrompt adds only the append flag when only append is set', () => {
  const env: Record<string, string> = {};
  const out = configureClaudeSystemPrompt(
    'claude "x"',
    { appendFile: '/abs/append.md' },
    SHELL,
    env,
  );
  assert.equal(out, 'claude --append-system-prompt-file "$LATTICE_CLAUDE_APPEND_SYSTEM_PROMPT_FILE" "x"');
  assert.ok(!(LATTICE_CLAUDE_SYSTEM_PROMPT_FILE_ENV in env));
});

test('configureClaudeSystemPrompt is a no-op with no override and leaves env untouched', () => {
  const env: Record<string, string> = {};
  const cmd = 'claude "x"';
  assert.equal(configureClaudeSystemPrompt(cmd, {}, SHELL, env), cmd);
  assert.deepEqual(env, {});
});

test('configureClaudeSystemPrompt ignores a non-Claude command', () => {
  const env: Record<string, string> = {};
  const cmd = 'codex --yolo "x"';
  assert.equal(
    configureClaudeSystemPrompt(cmd, { appendFile: '/abs/a.md' }, SHELL, env),
    cmd,
  );
  assert.deepEqual(env, {});
});

// --- Codex system-prompt config-arg injection --------------------------------

test('configureCodexSystemPrompt injects a --config flag per arg on its own env series', () => {
  const env: Record<string, string> = {};
  const out = configureCodexSystemPrompt(
    'codex --yolo "x"',
    ['developer_instructions="hi"', 'model_instructions_file="/abs/i.md"'],
    SHELL,
    env,
  );
  assert.equal(
    out,
    'codex --config "$LATTICE_CODEX_SYS_0" --config "$LATTICE_CODEX_SYS_1" --yolo "x"',
  );
  assert.equal(env[codexSystemPromptOverrideEnv(0)], 'developer_instructions="hi"');
  assert.equal(env[codexSystemPromptOverrideEnv(1)], 'model_instructions_file="/abs/i.md"');
});

test('Codex MCP and system-prompt overrides coexist on distinct env-var series', () => {
  const env: Record<string, string> = {};
  const withMcp = configureCodexProjectMcp(
    'codex --yolo "x"',
    ['mcp_servers.lattice_brave={type="stdio"}'],
    SHELL,
    env,
  );
  const out = configureCodexSystemPrompt(
    withMcp,
    ['developer_instructions="hi"'],
    SHELL,
    env,
  );
  // System-prompt flags sit right after `codex`, before the earlier MCP flag.
  assert.equal(
    out,
    'codex --config "$LATTICE_CODEX_SYS_0" --config "$LATTICE_CODEX_MCP_0" --yolo "x"',
  );
  assert.equal(env[codexSystemPromptOverrideEnv(0)], 'developer_instructions="hi"');
  assert.equal(env[codexMcpOverrideEnv(0)], 'mcp_servers.lattice_brave={type="stdio"}');
});

test('configureCodexSystemPrompt is a no-op for empty args and non-Codex commands', () => {
  const env: Record<string, string> = {};
  assert.equal(configureCodexSystemPrompt('codex "x"', [], SHELL, env), 'codex "x"');
  assert.equal(
    configureCodexSystemPrompt('claude "x"', ['developer_instructions="hi"'], SHELL, env),
    'claude "x"',
  );
  assert.deepEqual(env, {});
});

// --- Codex system-prompt config-arg RENDERING (cmd-safe TOML) ----------------

// Regression: prepareCodexSystemPrompt must emit no raw double-quote. Each
// `-c key=value` rides in a child-env var the command references as `"%VAR%"`,
// and Windows cmd.exe strips inner double-quotes out of that expansion and
// re-tokenizes the value on its own spaces — so a JSON.stringify'd value like
// `developer_instructions="Be terse."` reaches Codex split across argv. Values
// must therefore be double-quote-free TOML literals (single-quoted path, `'''`
// multi-line literal for prose), matching the proven MCP quoting.
test('prepareCodexSystemPrompt renders cmd-safe TOML (no double-quote) for spaces + apostrophes', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-hsp-codex-'));
  try {
    await patchUserSettings(project, {
      harnessSystemPrompts: {
        codex: {
          // Spaces + an apostrophe: the exact shape that broke under
          // JSON.stringify on cmd.exe.
          append: "Always write tests. Don't be terse.",
          replace: 'You are a custom Codex. Be precise.',
        },
      },
    });

    const { configArgs } = await prepareCodexSystemPrompt(project);
    const dev = configArgs.find((a) => a.startsWith('developer_instructions='));
    const model = configArgs.find((a) => a.startsWith('model_instructions_file='));
    assert.ok(dev, 'append → developer_instructions arg present');
    assert.ok(model, 'replace → model_instructions_file arg present');

    // THE invariant: no raw double-quote survives to the rendered value, or
    // cmd.exe's `"%VAR%"` expansion would split it on its spaces.
    for (const arg of configArgs) {
      assert.ok(!arg.includes('"'), `config arg must contain no double-quote: ${arg}`);
    }

    // Prose rides in a TOML multi-line literal with the apostrophe intact,
    // and the always-on Lattice preamble is prepended to the user text.
    assert.match(dev!, /^developer_instructions='''This session runs inside Lattice/);
    assert.ok(
      dev!.endsWith("Always write tests. Don't be terse.'''"),
      `project append must come last: ${dev}`,
    );
    // Joined with a SPACE, never a blank line: an inline `-c` value transits
    // cmd.exe as `"%VAR%"`, which cannot carry a newline. Folding the preamble
    // in must not turn a working single-line append into a broken two-line one.
    assert.ok(!dev!.includes("\n"), `no newline in the -c value: ${dev}`);
    // The replace path is a single-quoted TOML literal (absolute scratch path).
    assert.match(model!, /^model_instructions_file='.*codex-instructions\.md'$/);
  } finally {
    // The replace side writes a scratch file under the home-scoped, per-project
    // system-prompts dir — clean it (keyed by the temp project's hash).
    await fs.rm(homeProjectScratchDir(project, 'system-prompts'), {
      recursive: true,
      force: true,
    });
    await fs.rm(project, { recursive: true, force: true });
  }
});

// The whole point of the Lattice preamble: discovery must not depend on the
// user having configured anything. A project with NO harness system-prompt
// override of its own still spawns with the pointer to its API reference.
test('a project with no override still gets the Lattice preamble', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-hsp-pre-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-hsp-cwd-'));
  try {
    // `.lattice/` is what marks a project as Lattice-managed, and is where the
    // generated reference the preamble points at lands.
    await fs.mkdir(path.join(project, '.lattice'), { recursive: true });
    assert.equal(await resolveHarnessSystemPrompt(project, 'claude'), null);

    const { appendFile, replaceFile } = await prepareClaudeSystemPrompt(project);
    assert.ok(appendFile, 'append file written even with no user override');
    assert.equal(replaceFile, undefined, 'replace side left alone');
    const appended = await fs.readFile(appendFile as string, 'utf8');
    assert.match(appended, /^This session runs inside Lattice/);
    assert.match(appended, /LATTICE_API.md/);

    await preparePiSystemPrompt(cwd, project);
    const cfg = JSON.parse(
      await fs.readFile(
        path.join(cwd, '.pi', 'extensions', PI_SYSTEM_PROMPT_CONFIG_FILENAME),
        'utf8',
      ),
    );
    assert.match(cfg.append, /^This session runs inside Lattice/);
    assert.equal(cfg.replace, '');
  } finally {
    await fs.rm(homeProjectScratchDir(project, 'system-prompts'), {
      recursive: true,
      force: true,
    });
    await fs.rm(project, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// --- Pi extension shim -------------------------------------------------------

test('renderPiSystemPromptExtension embeds the config path and the hook', () => {
  const src = renderPiSystemPromptExtension('/abs/.pi/extensions/cfg.json');
  assert.match(src, /before_agent_start/);
  assert.match(src, /const CONFIG_FILE = "\/abs\/\.pi\/extensions\/cfg\.json"/);
  assert.match(src, /systemPrompt/);
});

test('applyPiSystemPromptForSpawn writes the extension + JSON, then removes on clear', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-hsp-'));
  const extFile = path.join(dir, '.pi', 'extensions', PI_SYSTEM_PROMPT_EXTENSION_FILENAME);
  const cfgFile = path.join(dir, '.pi', 'extensions', PI_SYSTEM_PROMPT_CONFIG_FILENAME);
  try {
    await applyPiSystemPromptForSpawn(dir, { append: 'be terse', replace: '' });
    const cfg = JSON.parse(await fs.readFile(cfgFile, 'utf8'));
    assert.deepEqual(cfg, { append: 'be terse', replace: '' });
    assert.match(await fs.readFile(extFile, 'utf8'), /before_agent_start/);

    // Clearing the override strips the pair so a reused cwd stays clean.
    await applyPiSystemPromptForSpawn(dir, null);
    await assert.rejects(() => fs.readFile(extFile, 'utf8'));
    await assert.rejects(() => fs.readFile(cfgFile, 'utf8'));

    // Idempotent when already absent — must not throw.
    await applyPiSystemPromptForSpawn(dir, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- Settings round-trip (read-only) -----------------------------------------

test('resolve + editorData reflect saved overrides and drop blank sides', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-hsp-proj-'));
  try {
    await patchUserSettings(project, {
      harnessSystemPrompts: {
        claude: { append: 'be terse', replace: '' },
        codex: { replace: 'you are codex, custom' },
        // whitespace-only append must be treated as "unset"
        pi: { append: '   ' },
      },
    });

    // Only non-empty sides survive the resolver.
    assert.deepEqual(await resolveHarnessSystemPrompt(project, 'claude'), {
      append: 'be terse',
      replace: undefined,
    });
    assert.deepEqual(await resolveHarnessSystemPrompt(project, 'codex'), {
      append: undefined,
      replace: 'you are codex, custom',
    });
    // pi's only side is whitespace → nothing configured.
    assert.equal(await resolveHarnessSystemPrompt(project, 'pi'), null);

    // Editor data carries the catalog for all three harnesses + current text.
    const entries = await buildHarnessSystemPromptEditorData(project);
    assert.deepEqual(
      entries.map((e) => e.harness).sort(),
      ['claude', 'codex', 'pi'],
    );
    const claude = entries.find((e) => e.harness === 'claude')!;
    assert.equal(claude.currentAppend, 'be terse');
    assert.equal(claude.currentReplace, '');
    assert.equal(claude.defaultViewable, false); // proprietary
    const codex = entries.find((e) => e.harness === 'codex')!;
    assert.equal(codex.currentReplace, 'you are codex, custom');
    assert.equal(codex.defaultViewable, true);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});
