# backend/src/worktree/snapshot

Safety-critical copy-based working-tree snapshots. Keep the capture order in
`capture.ts` intact:

1. Parse `git status --porcelain=v1 --untracked-files=all`.
2. Drop any path that fails the repo-containment guard; dropped paths must not
   be copied, reset, or deleted.
3. Create the snapshot dir and copy dirty paths, recording successes and
   failures separately.
4. Write the manifest only after copies, and list only successfully copied
   paths.
5. Reset tracked files and delete untracked files **only** from the successful
   copy lists. A failed copy stays dirty in the user's working tree so follow-up
   git operations fail safely instead of losing data.

Do not replace this with `git stash --include-untracked`.
