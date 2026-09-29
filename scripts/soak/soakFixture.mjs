import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Called only after the entry point has checked that backend/dist exists.
export function createSoakFixture({ here, port: PORT, terminalPort: TERMINAL_PORT }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-soak-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  const soakLog = path.join(root, 'fake-agents.jsonl');
  for (const d of [home, project, bin, path.join(root, 'tmp')]) fs.mkdirSync(d, { recursive: true });

  // ── the throwaway project ────────────────────────────────────────────────
  function g(args, cwd = project) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  g(['init', '-q', '-b', 'main']);
  // Repo-local identity: the isolated HOME has no ~/.gitconfig, and both the
  // fake agents' commits and Lattice's in-worktree merges need one.
  g(['config', 'user.name', 'Lattice Soak']);
  g(['config', 'user.email', 'soak@example.invalid']);
  fs.writeFileSync(path.join(project, 'README.md'), '# soak project\n');
  fs.writeFileSync(path.join(project, 'shared.txt'), 'shared log\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'initial']);

  // ── the fake harness, first on PATH ─────────────────────────────────────
  const fake = path.join(here, 'fakeClaude.mjs');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "${fake}" %*\r\n`);
  } else {
    const sh = path.join(bin, 'claude');
    fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    fs.chmodSync(sh, 0o755);
  }

  const env = { ...process.env };
  // A backend started from inside a Claude Code session scrubs these itself;
  // the fake agent doesn't care, but keep the child env honest.
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k];
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    PORT: String(PORT),
    TERMINAL_PORT: String(TERMINAL_PORT),
    LATTICE_DEFAULT_ROOT: project,
    // The backend prunes projects.json entries under os.tmpdir() as test junk at
    // every boot, which would make this very project invisible to restart
    // recovery. Give the instance a temp dir the project isn't under.
    TEMP: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    TMPDIR: path.join(root, 'tmp'),
    [pathKey]: `${bin}${path.delimiter}${env[pathKey] ?? ''}`,
    // The pty PATH puts the Windows registry PATH ahead of anything inherited,
    // so the fake needs this to stay ahead of a real `claude` in every terminal.
    LATTICE_PTY_PATH_PREPEND: bin,
    SOAK_LOG: soakLog,
    SOAK_FAKE_DELAY: '1500-8000',
  });

  return { root, home, project, bin, soakLog, env, g };
}
