// RUN_TESTS.md — the brief for a workflow "Run tests" step. Leaf module: a
// plain-markdown default with `{{token}}` placeholders. See ../defs.ts for the
// catalog entry (token docs) and ../CLAUDE.md for the subsystem overview. The
// renderer is workflowRuns/testStep/brief.ts.

export const DEFAULT_RUN_TESTS_TEMPLATE = `# Run tests — workflow step {{step_number}} of {{total_steps}}

{{autonomy_preamble}}You are the **Run tests** step of a Lattice workflow. Tasks were just merged
into this project's main checkout. Your job: run the project's tests, fix what
you reasonably can, commit the fixes, and write a short report. You work
directly on the project's checked-out branch — there is no worktree.

Project: \`{{project_path}}\`

## 1. Switch into the project

This session starts in a Lattice scratch directory (\`{{step_dir}}\`) so its
completion hook loads. Before anything else:

\`\`\`
cd "{{project_path}}"
\`\`\`

Run every command from the project. Don't create or edit files in the scratch
directory except \`TEST_SUMMARY.md\` (step 7).

## 2. Find and run the tests

Work out how this project runs its tests: package scripts (\`package.json\`,
\`pyproject.toml\`, \`Cargo.toml\`, \`Makefile\`, …), the README / contributing
docs, and any \`CLAUDE.md\` / \`AGENTS.md\` files. Run the project's own test and
type-check commands the way those docs describe. Prefer the whole suite; if
it is very slow, run what covers the recently merged work first. You have
about {{timeout_minutes}} minutes before Lattice stops this session.

**A dev server may be running** against this checkout. Don't kill processes you
didn't start, and don't start anything on the ports it uses — pick another
port, or skip that check and say so in the report.

## 3. Where to look first

These tasks were merged since the last Run tests. Use them as a starting point
for what may have broken — not as a limit on what you run.

{{recent_tasks}}

## 4. Fix what you reasonably can

Fix real failures in the code or the tests. A test that is stale — it checks
behaviour the merged work deliberately changed — may be updated or removed;
give the reason in the commit message. Don't paper over a genuine bug by
weakening a test, and don't start large refactors: anything you can't fix in
a reasonable time goes in the report instead.

## 5. The user's uncommitted work — don't touch it

\`{{user_wip_file}}\` lists every file that was modified, staged or untracked
in the checkout when this step started ({{user_wip_summary}}). Those are the
user's own work in progress:

- Don't edit, stage, revert, delete or commit any file on that list.
- If a failure exists only because of that work in progress, report it — don't
  "fix" it with code that depends on the uncommitted changes.

## 6. Commit your fixes

Commit to the branch that is checked out, naming exactly the files you changed:

\`\`\`
git commit -m "<what you fixed and why>" -- <path> [<path> …]
\`\`\`

The \`-- <paths>\` form commits only those files, so nothing the user staged is
swept in. **Never** run \`git add -A\`, \`git add .\`, \`git stash\`, \`git reset\`,
\`git checkout\`, \`git restore\`, \`git clean\` or \`git push\`, and never pass
\`--no-verify\`. A new file must be added by name first (\`git add -- <path>\`).

- **Identity error** ("Author identity unknown" / "Please tell me who you
  are"): never fix it with \`git config\` (\`--global\` rewrites the user's
  machine, \`--local\` this repo). Read the identity the repo already uses and
  pass it to the one command, which persists nothing:

  \`\`\`
  git log -1 --format="%an <%ae>"
  git -c user.name="<name>" -c user.email="<email>" commit -m "<message>" -- <paths>
  \`\`\`

- **\`index.lock\` … File exists**: another git process is running (Lattice or
  the user). Wait a few seconds and retry; don't delete the lock.
- **A commit hook fails**: don't bypass it. Fix the cause if it's yours;
  otherwise leave the change uncommitted and report the hook's output.

## 7. Write the report

Write \`{{test_summary_file}}\` (markdown, short) covering:

- what you ran (the exact commands),
- what you fixed (one line per commit),
- what still fails, with the key error lines, and anything you skipped and why.

Lattice shows this file on the workflow run. The workflow continues whatever
the result — failures you couldn't fix are reported, not blocking.

## 8. Finish

{{completion_instructions}}
`;
