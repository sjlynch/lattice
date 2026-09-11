# Project identity and legacy storage

`projectPath.ts` delegates identity to `projectIdentity.ts`. Existing project
directories resolve through native `realpath`: Windows path-case, junction and
short-name aliases share one physical path. No whole-path lowercasing occurs,
so case-sensitive directory semantics are preserved. Missing paths retain the
legacy resolved spelling and are not negatively cached.

The storage hash can remain the legacy hash. On first access, identity discovery
reads the project index, `.canonical-path` markers, bounded leading metadata
from task/run files, and snapshot manifests. If one existing hash belongs to
the physical project, it is reused for tasks, run locks, worktrees, snapshots,
backups and scratch. Nothing moves or is deleted. A durable binding at
`~/.lattice/project-identities/<sha1(physicalPath)[:12]>.json` records the chosen
hash and original spelling, atomically published without replacing another
backend's binding. Later index normalization cannot strand the old store.

Bindings reserve legacy storage for its original physical project even when a
junction is subsequently removed or points elsewhere. Scoped task, workflow and
merge records normalize their old project field through this binding; snapshot
recovery resolves its recorded old root against the owning hash.

Two already-existing hashes for one physical project require reconciliation.
Lattice refuses to choose a task database, preserves every store, and reports
their hashes and home root. Task load/backup and snapshot sweeps contain that
failure per project so unrelated projects continue. This patch does not merge
conflicting task/workflow/run histories or relocate ambiguous worktrees.

Path/hash caches are bounded at 2,048 entries. Discovery inventories are cached
per home; generated task/run records put identity near the beginning, so their
fallback metadata read is capped at 64 KB per file. Hot identity lookups perform
no filesystem reads. Existing resolved paths are pinned while the backend runs;
restart all backends after retargeting an open junction or manually reconciling
stores. All concurrently participating backends must use this identity protocol.
Old builds can still address their old path hashes independently.

Unreadable/corrupt durable bindings refuse discovery rather than release their
unknown storage reservation. This can defer identity initialization beyond the
directly named project until the binding is repaired; silently skipping it could
give a retargeted junction the original project's task database. Unrelated stray
files and incomplete snapshot metadata are skipped and preserved.
