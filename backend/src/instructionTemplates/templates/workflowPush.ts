// PUSH_INSTRUCTIONS.md for a WORKFLOW Push step — pushes the commits that are
// already on the branch and nothing else. Leaf module: a plain-markdown default
// with `{{token}}` placeholders. See ../defs.ts for the catalog entry.
//
// Deliberately different from the QA-lane Push button's brief (push.ts), which
// commits everything first: a workflow runs unattended on the main checkout,
// where uncommitted files are the user's own work in progress (or stray
// artifacts) that must never be swept into a commit behind their back. Task
// agents, the merge and Run tests already commit everything a workflow made.

export const DEFAULT_WORKFLOW_PUSH_TEMPLATE = `# Push to remote (workflow step)

Project: \`{{project_path}}\`

Push the commits that are already on the checked-out branch. **Do not create
commits**: no \`git add\`, no \`git commit\`, no \`git stash\`. Uncommitted files
belong to the user and stay exactly as they are.

## Steps

1. \`cd "{{project_path}}"\`
2. Run \`git status\`. If there are uncommitted or untracked files, leave them
   alone — don't stage, commit, stash or revert anything — and list them in
   your report.
3. Push: \`git push\`. If it fails because the branch has no upstream, run
   \`git push -u origin HEAD\` instead. Don't force-push. If the push is
   rejected (the remote has commits you don't), report it — don't pull,
   rebase or merge.
4. Report one line: what was pushed (or that there was nothing to push), the
   push result, and the uncommitted files you left alone. Then stop — the
   Lattice harness closes this terminal automatically once you stop.
`;
