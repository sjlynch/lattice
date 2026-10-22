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

// Per-process temp root: TEMP/TMP/TMPDIR point into it, so every os.tmpdir()
// a test (or a child it spawns) uses lands inside, and the exit cleanup below
// removes whatever a test forgot to. Without it, tests that skip their own
// cleanup — or are killed mid-run — had left ~30k `lattice-*` dirs in the real
// %TEMP% (2026-10-15), and a workflow's Run tests step re-runs the suite.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-test-'));
process.env.TEMP = tempRoot;
process.env.TMP = tempRoot;
process.env.TMPDIR = tempRoot;
const tempHome = fs.mkdtempSync(path.join(tempRoot, 'lattice-test-home-'));
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
// Tests that write under ~/.lattice check this marker and refuse to run
// without it: `node --test src/__tests__/x.test.ts` (no `--import` of this
// file) otherwise lands their fixtures in the developer's REAL home — which is
// how a fake rule pack once overwrote a real ~/.lattice/opengrep/state.json.
process.env.LATTICE_TEST_HOME_ISOLATED = tempHome;
// An inherited LATTICE_HOME would send ~/.lattice writes past the redirected
// HOME, into an instance's real state.
delete process.env.LATTICE_HOME;
// Code under test that reaches the terminal proxy (kill-by-cwd on cleanup,
// session probes) defaulted to the developer's LIVE executor on :5185: a 401
// at best, and under load a stalled request that hung postMergeHookTrigger for
// minutes. Point it at a port nothing listens on; tests that need an executor
// start a fake one and set TERMINAL_PORT themselves before importing.
// Overwritten, not defaulted: a suite run from inside a Lattice terminal
// inherits that pty's TERMINAL_PORT=5185 (and its executor token), which a
// `??=` kept — so tests reached the live executor after all.
// LATTICE_TEST_TERMINAL_PORT is the explicit opt-in to another port.
process.env.TERMINAL_PORT = process.env.LATTICE_TEST_TERMINAL_PORT || '9';
delete process.env.LATTICE_TERMINAL_TOKEN;
// A peer gateway a test switches on binds loopback only (no LAN exposure, no
// Windows Firewall prompt).
process.env.LATTICE_PEER_GATEWAY_HOST = '127.0.0.1';

// Best-effort cleanup when the test process exits (sync — 'exit' can't await).
process.on('exit', () => {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    /* best effort; the OS temp dir is reclaimed eventually anyway */
  }
});
