// The "Set up Git" backend: probe → guards → starter .gitignore → init.
//
// The load-bearing case is `'nested'`. `fs.stat(<project>/.git)` reports "no
// repo" for a subdirectory of a monorepo, and a `git init` there creates a
// nested repo the parent sees as a bare gitlink — the worst thing this feature
// can do. So the probe's walk-up detection is pinned from both sides: the
// subdirectory must come back `'nested'` AND `initable: false`.
//
// The end-to-end init needs a git identity to commit with. This directory is
// exempt from `gitIdentityUntouched.test.ts`'s source scan precisely so tests
// can supply one for their own throwaway repos — here it goes in the
// environment rather than a config file, because the repo doesn't exist yet
// when `initProjectGit` needs it.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStarterGitignore } from '../projectInit/gitignoreTemplate.js';
import { refuseInitReason } from '../projectInit/guards.js';
import { initProjectGit, isMissingIdentityFailure } from '../projectInit/init.js';
import { previewProjectInit } from '../projectInit/preview.js';
import { probeProjectGit } from '../projectInit/probe.js';
import { ProjectInitError } from '../projectInit/types.js';
import { canonicalProjectPath } from '../projectPath.js';
import { withTempDir, writeLayout } from './helpers/tempDir.js';

const execFileAsync = promisify(execFile);
const PREFIX = 'lattice-project-init-';

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

// Author + committer, for the whole test process. Restored by the caller.
const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'Lattice Test',
  GIT_AUTHOR_EMAIL: 'lattice-test@example.invalid',
  GIT_COMMITTER_NAME: 'Lattice Test',
  GIT_COMMITTER_EMAIL: 'lattice-test@example.invalid',
} as const;

async function withGitIdentity<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(IDENTITY_ENV)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// --- probe ---------------------------------------------------------------------

test('probeProjectGit reports a plain repo as `repo`', async () => {
  await withTempDir(PREFIX, async (dir) => {
    await git(dir, ['init']);

    const probe = await probeProjectGit(dir);
    assert.equal(probe.state, 'repo');
    assert.equal(probe.initable, false);
    assert.equal(probe.toplevel, canonicalProjectPath(dir));
  });
});

test('probeProjectGit reports a SUBDIRECTORY of a repo as `nested`, never initable', async () => {
  await withTempDir(PREFIX, async (dir) => {
    await git(dir, ['init']);
    const sub = path.join(dir, 'packages', 'app');
    await fs.mkdir(sub, { recursive: true });

    // `fs.stat(<sub>/.git)` would say "no repo here" — the whole reason the
    // probe has to spend a `rev-parse --show-toplevel`.
    const probe = await probeProjectGit(sub);
    assert.equal(probe.state, 'nested');
    assert.equal(probe.initable, false);
    assert.ok(probe.toplevel, 'nested probe must name the ancestor repo');
    // git resolves symlinked temp dirs (macOS /var → /private/var), so compare
    // basenames rather than the whole path.
    assert.equal(path.basename(probe.toplevel!), path.basename(dir));
    assert.match(probe.reason ?? '', /nested/i);
  });
});

test('probeProjectGit reports a bare repo as `bare`', async () => {
  await withTempDir(PREFIX, async (dir) => {
    await git(dir, ['init', '--bare']);

    const probe = await probeProjectGit(dir);
    assert.equal(probe.state, 'bare');
    assert.equal(probe.initable, false);
  });
});

test('probeProjectGit treats a `.git` FILE as a repo (linked worktree / submodule)', async () => {
  await withTempDir(PREFIX, async (dir) => {
    await fs.writeFile(path.join(dir, '.git'), 'gitdir: /somewhere/else\n', 'utf8');

    const probe = await probeProjectGit(dir);
    assert.equal(probe.state, 'repo');
    assert.equal(probe.initable, false);
  });
});

test('probeProjectGit reports a plain folder as `none` + initable', async () => {
  await withTempDir(PREFIX, async (dir) => {
    const probe = await probeProjectGit(dir);
    assert.equal(probe.state, 'none');
    assert.equal(probe.initable, true);
    assert.equal(probe.reason, undefined);
  });
});

// --- guards --------------------------------------------------------------------

test('refuseInitReason refuses the home directory and a filesystem root', async () => {
  const home = canonicalProjectPath(os.homedir());
  const homeReason = await refuseInitReason(home);
  assert.ok(homeReason, 'the home dir must never be initializable');
  assert.match(homeReason!, /home directory/i);

  const root = path.parse(process.cwd()).root;
  const rootReason = await refuseInitReason(canonicalProjectPath(root));
  assert.ok(rootReason, 'a drive/filesystem root must never be initializable');
  assert.match(rootReason!, /filesystem root/i);
});

test('refuseInitReason accepts an ordinary writable folder', async () => {
  await withTempDir(PREFIX, async (dir) => {
    assert.equal(await refuseInitReason(canonicalProjectPath(dir)), null);
  });
});

// --- starter .gitignore ---------------------------------------------------------

test('buildStarterGitignore covers Lattice scratch and secrets', async () => {
  await withTempDir(PREFIX, async (dir) => {
    await writeLayout(dir, { 'package.json': '{"name":"x"}\n' });

    const text = await buildStarterGitignore(dir);
    assert.ok(text.includes('.lattice/'), 'must ignore Lattice scratch');
    assert.ok(text.includes('node_modules/'), 'must ignore dependency dirs');
    assert.ok(text.includes('.env'), 'must ignore env files');
  });
});

test('buildStarterGitignore only ignores `target/` when the ecosystem is detected', async () => {
  // A JS project can legitimately keep source in `target/`, so blanket-ignoring
  // it would silently drop a whole tree out of the first commit.
  await withTempDir(PREFIX, async (dir) => {
    await writeLayout(dir, { 'package.json': '{"name":"x"}\n' });
    await fs.mkdir(path.join(dir, 'node_modules'));

    const text = await buildStarterGitignore(dir);
    assert.ok(!text.includes('target/'), 'a plain JS project must not ignore target/');
  });

  await withTempDir(PREFIX, async (dir) => {
    await writeLayout(dir, { 'Cargo.toml': '[package]\nname = "x"\n' });
    await fs.mkdir(path.join(dir, 'target'));

    const text = await buildStarterGitignore(dir);
    assert.ok(text.includes('target/'), 'a Rust project must ignore its target/ dir');
    assert.match(text, /detected here \(.*Rust.*\)/);
  });
});

// --- preview -------------------------------------------------------------------

test('previewProjectInit counts only what the first commit would capture', async () => {
  await withTempDir(PREFIX, async (dir) => {
    await writeLayout(dir, {
      'package.json': '{"name":"x"}\n',
      'src/app.ts': 'export const a = 1;\n',
      'node_modules/dep/index.js': 'x'.repeat(4096),
      '.env': 'SECRET=1\n',
    });

    const preview = await previewProjectInit(dir);
    assert.equal(preview.generated, true);
    assert.equal(preview.isEmpty, false);
    assert.equal(preview.truncated, false);
    assert.equal(preview.fileCount, 2, 'node_modules/ and .env must be excluded');
    assert.ok(preview.byteCount > 0);
    assert.ok(
      !preview.largest.some((f) => f.path.includes('node_modules')),
      'an ignored file must not show up as a largest-file warning',
    );
  });
});

test('previewProjectInit reports an empty folder as the zero-risk path', async () => {
  await withTempDir(PREFIX, async (dir) => {
    const preview = await previewProjectInit(dir);
    assert.equal(preview.isEmpty, true);
    assert.equal(preview.fileCount, 0);
    assert.equal(preview.probe.initable, true);
  });
});

// --- init end to end ------------------------------------------------------------

test('initProjectGit creates a repo with exactly one commit, then refuses a second run', async () => {
  await withGitIdentity(async () => {
    await withTempDir(PREFIX, async (dir) => {
      await writeLayout(dir, {
        'README.md': '# hi\n',
        'src/app.ts': 'export const a = 1;\n',
        'node_modules/dep/index.js': 'ignored\n',
      });

      const result = await initProjectGit(dir);
      assert.equal(result.toplevel, canonicalProjectPath(dir));
      assert.equal(result.branch, 'main');
      assert.ok(result.commit, 'a repo with no commit is useless to Lattice');
      assert.ok(result.filesCommitted >= 3, 'README, src/app.ts and .gitignore');

      const log = await git(dir, ['rev-list', '--count', 'HEAD']);
      assert.equal(log.trim(), '1');

      const tracked = (await git(dir, ['ls-files'])).split(/\r?\n/).filter(Boolean);
      assert.ok(tracked.includes('.gitignore'));
      assert.ok(tracked.includes('README.md'));
      assert.ok(tracked.includes('src/app.ts'));
      assert.ok(
        !tracked.some((f) => f.startsWith('node_modules/')),
        'the generated .gitignore must keep node_modules out of the first commit',
      );

      // Second call: the folder is a repo now, so it is no longer initable.
      await assert.rejects(
        () => initProjectGit(dir),
        (err: unknown) => {
          assert.ok(err instanceof ProjectInitError);
          assert.equal(err.code, 'not-initable');
          return true;
        },
      );
      assert.equal((await git(dir, ['rev-list', '--count', 'HEAD'])).trim(), '1');
    });
  });
});

test('initProjectGit commits an empty folder rather than leaving HEAD unborn', async () => {
  await withGitIdentity(async () => {
    await withTempDir(PREFIX, async (dir) => {
      const result = await initProjectGit(dir);
      // The generated `.gitignore` is itself a file, so this is never truly
      // empty — what matters is that HEAD exists.
      assert.ok(result.commit);
      assert.equal((await git(dir, ['rev-list', '--count', 'HEAD'])).trim(), '1');
    });
  });
});

test('a missing git identity is recognized from git\'s own stderr', () => {
  // Lattice is barred from asking git whether an identity exists (the query
  // would have to name the config keys `gitIdentityUntouched.test.ts` scans
  // for), so this string match IS the detection — the exact text git prints,
  // across the phrasings it uses.
  assert.ok(
    isMissingIdentityFailure(
      'Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n  git config ...',
    ),
  );
  assert.ok(
    isMissingIdentityFailure(
      'fatal: unable to auto-detect email address (got \'spenc@box.(none)\')',
    ),
  );
  // Anything else must fall through to `git-failed`, so the dialog shows git's
  // real problem instead of a fix that has nothing to do with it.
  assert.equal(isMissingIdentityFailure('error: pathspec did not match any file'), false);
  assert.equal(isMissingIdentityFailure('fatal: could not read Username'), false);
});

test('initProjectGit refuses a subdirectory of an existing repo', async () => {
  await withTempDir(PREFIX, async (dir) => {
    await git(dir, ['init']);
    const sub = path.join(dir, 'packages', 'app');
    await fs.mkdir(sub, { recursive: true });

    await assert.rejects(
      () => initProjectGit(sub),
      (err: unknown) => {
        assert.ok(err instanceof ProjectInitError);
        assert.equal(err.code, 'not-initable');
        return true;
      },
    );
    // The nested `.git` this feature exists to prevent must not appear.
    await assert.rejects(() => fs.stat(path.join(sub, '.git')));
  });
});

test('initProjectGit leaves an existing .gitignore alone', async () => {
  await withGitIdentity(async () => {
    await withTempDir(PREFIX, async (dir) => {
      await writeLayout(dir, {
        '.gitignore': '# mine\nbuild-output/\n',
        'app.js': 'console.log(1);\n',
      });

      await initProjectGit(dir);

      const text = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
      assert.ok(text.startsWith('# mine\nbuild-output/\n'), 'the user\'s file must survive');
      assert.ok(text.includes('.lattice/'), 'Lattice entries are appended, not substituted');
    });
  });
});

// ...but an EXPLICIT gitignore overrides even an existing file. It only ever
// arrives from the dialog, where the user saw that exact text and the file
// count it produces. Keeping the old file instead would mean the count they
// approved described a different commit than the one they got — exactly the
// case the preview exists to catch.
test('an explicit .gitignore overrides one already on disk', async () => {
  await withGitIdentity(async () => {
    await withTempDir(PREFIX, async (dir) => {
      await writeLayout(dir, {
        '.gitignore': '# stale\n',
        'app.js': 'console.log(1);\n',
        '.env': 'SECRET=hunter2\n',
      });

      await initProjectGit(dir, { gitignore: '# edited in the dialog\n.env\n' });

      const tracked = await git(dir, ['ls-files']);
      assert.ok(tracked.includes('app.js'));
      assert.ok(
        !tracked.includes('.env'),
        'the exclusion the user typed must hold — this is the whole point of the preview',
      );
    });
  });
});

// The dialog hands the user an editable `.gitignore` — which means they can
// delete the Lattice entries out of it before submitting. `.lattice/` holds
// health-cache.json / userSettings.json, so an unignored one lands straight in
// the first commit.
test('a user-edited .gitignore that drops the Lattice entries still ignores .lattice/', async () => {
  await withGitIdentity(async () => {
    await withTempDir(PREFIX, async (dir) => {
      await writeLayout(dir, {
        'app.js': 'console.log(1);\n',
        '.lattice/health-cache.json': '{"version":3}\n',
      });

      await initProjectGit(dir, { gitignore: '# just mine\n*.log\n' });

      const text = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
      assert.ok(text.startsWith('# just mine\n*.log\n'), 'the user\'s text is kept verbatim');
      assert.ok(text.includes('.lattice/'), 'the Lattice entries are re-appended');

      const tracked = await git(dir, ['ls-files']);
      assert.ok(tracked.includes('app.js'));
      assert.ok(
        !tracked.includes('.lattice/'),
        'Lattice scratch must never reach the first commit',
      );
    });
  });
});
