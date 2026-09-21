// Test preload — home isolation.
//
// Redirects the home dir to a throwaway temp dir so the suite never writes into
// the developer's real ~/.lattice: the projects.json index, per-project
// tasks.json DBs, snapshots, git-backups, etc. Without this, every `npm test`
// run permanently pollutes ~/.lattice/projects.json with the temp-dir projects
// that task-cache tests create (the `lattice-canon-*`, `lattice-merge-*`,
// `lattice-finalize-*` entries), and leaves orphan per-project task DBs behind.
//
// Wired in via the `--import` flag in package.json's `test` script so it runs
// BEFORE any test file imports the task cache — whose LATTICE_HOME constant is
// computed once at module load from os.homedir() (which reads USERPROFILE/HOME).
// Node evaluates every `--import` module before loading the test files, so the
// env is already redirected by the time that constant is bound.
//
// This is pure isolation with no behavior change: the entire suite already
// passes under a redirected home. Individual tests that set up their own temp
// home still work — they just override this default and restore afterward.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-test-home-'));
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
// Tests that write under ~/.lattice check this marker and refuse to run
// without it: `node --test src/__tests__/x.test.ts` (no `--import` of this
// file) otherwise lands their fixtures in the developer's REAL home — which is
// how a fake rule pack once overwrote a real ~/.lattice/opengrep/state.json.
process.env.LATTICE_TEST_HOME_ISOLATED = tempHome;

// Best-effort cleanup when the test process exits (sync — 'exit' can't await).
process.on('exit', () => {
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* best effort; the OS temp dir is reclaimed eventually anyway */
  }
});
