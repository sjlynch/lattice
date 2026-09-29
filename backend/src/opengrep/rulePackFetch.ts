// Pinned by COMMIT, fetched with git: `git fetch --depth 1 origin <sha>` +
// `checkout FETCH_HEAD` yields a content-addressed tree, so the pin verifies
// the content by construction (unlike a tarball, whose bytes GitHub does not
// keep stable). Rules are data the engine interprets — the threat is "wrong
// rules", not code execution — so the commit pin is proportionate.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnWithTimeout } from '../spawnWithTimeout.js';
import { RulePackError } from './rulePackError.js';

const GIT_TIMEOUT_MS = 5 * 60_000;

async function git(args: string[], cwd: string): Promise<string> {
  // Public repositories only: a credential prompt (a proxy, a mistyped URL)
  // must fail instead of parking the fetch until the 5-minute timeout.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  const r = await spawnWithTimeout('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS, env });
  if (r.error) throw new RulePackError(`git ${args[0]} failed to start: ${r.error.message}`);
  if (r.timedOut) throw new RulePackError(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS / 1000}s`);
  if (r.code !== 0) {
    throw new RulePackError(`git ${args.join(' ')} exited ${r.code}: ${r.stderr.trim().slice(0, 600)}`);
  }
  return r.stdout;
}

// Fetch exactly `commit` from `repo` into `dest` (created). GitHub serves
// fetches by full SHA (uploadpack.allowReachableSHA1InWant), which is what
// makes a shallow fetch of one pinned commit possible without cloning history.
export async function fetchPackCommit(repo: string, commit: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  await git(['init', '-q'], dest);
  await git(['remote', 'add', 'origin', repo], dest);
  await git(
    ['-c', 'core.longpaths=true', '-c', 'advice.detachedHead=false', 'fetch', '-q', '--depth', '1', 'origin', commit],
    dest,
  );
  await git(['-c', 'core.longpaths=true', 'checkout', '-q', 'FETCH_HEAD'], dest);
  const head = (await git(['rev-parse', 'HEAD'], dest)).trim();
  if (head !== commit) {
    throw new RulePackError(`checked out ${head}, expected pinned commit ${commit}`);
  }
  // The `.git` directory is not needed once checked out: the pack is read-only
  // data from here on. Removing it is a recursive delete of a directory this
  // module just created under ~/.lattice — never a project tree.
  await fs.rm(path.join(dest, '.git'), { recursive: true, force: true });
}
