// No automatic `git gc` from the git processes Lattice starts.
//
// Git runs `gc --auto` (via `maintenance run --auto`) after `commit`, `merge`,
// `am`, `fetch`, … — i.e. after nearly every git command a merge run and its
// agents make. On 2026-09-24 that turned into a runaway on the ody repo
// (4.2 GB packed): a burst of worktree merges each started a full repack, and
// on Windows a repack cannot delete the old packs while any other git process
// has them mapped (another merge, `git status`, the backup bundle, an agent),
// so every repack left the previous 4.2 GB pack behind — 14 full copies plus
// 38 index-less husks and 7.7 GB of half-written temp packs (80 GB) in six
// minutes, and the merge run failed on a full disk. A leftover-pack count that
// stays high then re-triggers `gc --auto` on the next commit, so it feeds
// itself.
//
// So every git Lattice runs (worktree/exec.ts) and every agent session it
// spawns (terminalServerClient/createSession.ts) gets `gc.auto=0` +
// `maintenance.auto=false` through git's GIT_CONFIG_COUNT/KEY/VALUE
// environment (git ≥ 2.31) — per process, nothing written to any config file.
// Housekeeping instead runs ONCE, in the foreground and alone, after a merge
// run (`repoMaintenance.ts`).

export const NO_AUTO_GC: ReadonlyArray<readonly [string, string]> = [
  ['gc.auto', '0'],
  ['maintenance.auto', 'false'],
];

// Env that appends `pairs` to whatever GIT_CONFIG_COUNT/KEY_n/VALUE_n the base
// environment already carries (git reads keys 0..COUNT-1; a later key wins).
export function gitConfigEnv(
  pairs: ReadonlyArray<readonly [string, string]>,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const existing = Number.parseInt(base.GIT_CONFIG_COUNT ?? '', 10);
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(start + pairs.length) };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${start + i}`] = key;
    env[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  return env;
}

export function isGitCommand(cmd: string): boolean {
  const base = cmd.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  return base === 'git' || base === 'git.exe';
}
