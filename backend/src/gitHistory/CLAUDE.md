# backend/src/gitHistory

Backs the frontend timeline scrubber (`GET /api/git-history`, served by `routes/health/gitInfo.ts`). **One** `git log --name-status -M` round-trip per request returns every commit *and* its changed-file list, so the scrubber can derive each drag-range's change map purely client-side without re-hitting the backend. `../gitHistory.ts` is the public shim (`getGitHistory` + the types).

## Contract

- `index.ts` — git execution. `getGitHistory` checks `--is-inside-work-tree`, then runs `git log -<N> --no-merges --name-status -M --format=…`, `git status --porcelain=v1 -z`, and `computeStatusSignature` in parallel. `clampLogLimit` bounds N to **1–50**. A non-zero exit (no commits yet, shallow repo, …) yields an empty result rather than an error.
- `signature.ts` — `computeStatusSignature(repoRoot)`: a compact fingerprint of the exact state the scrubber renders — `git status --porcelain=v2 --branch -z` (the `# branch.oid` header carries HEAD; entries carry every dirty path) hashed to a short sha1. Returned as `GitHistoryResult.signature` **and** used by the `../gitStatus.ts` watcher to decide whether a filesystem change actually moved the repo state; both run the identical command so their values always agree. Never rejects (returns `''` on a missing repo / vanished cwd) so a watcher recompute can't unhandled-reject.
- `parseLog.ts` — splits the log on a custom `␃COMMIT␃` header sentinel (metadata fields joined by an exotic `␟` separator so ordinary commit subjects don't collide), then parses each name-status block. A rename/copy (`R…`/`C…`, surfaced because of `-M`) is **decomposed into a delete of the old path + an add of the new** (carrying `oldPath`) so the graph can ghost the old node and green-ring the new one. git emits newest-first; we reverse to oldest→newest to match the scrubber's left-to-right ticks.
- `parseStatus.ts` — parses the NUL-separated `git status` porcelain into dirty-path changes (a rename target consumes the following NUL token as its old path). Index + worktree codes collapse to a single status per path by priority **D > A/R > M**.
- `parserShared.ts` — the sentinels, `normalizeGitPath` (backslash→slash), `parseNameStatusToken`, and the status-priority merge shared by both parsers.
- `types.ts` — `GitCommit` / `GitCommitChange` / `GitFileStatus` / `GitUncommitted` / `GitHistoryResult`.

Split: **parsing** (`parseLog.ts` / `parseStatus.ts` / `parserShared.ts` — pure, unit-tested in `__tests__/gitHistoryParsers.test.ts`) vs **git execution** (`index.ts`).
