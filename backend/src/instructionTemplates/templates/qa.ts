// QA_INSTRUCTIONS.md — the brief for a QA-lane "run e2e test" session. Leaf
// module: a plain-markdown default with `{{token}}` placeholders. See
// ../defs.ts for the catalog entry (token docs) and ../CLAUDE.md for the
// subsystem overview.

export const DEFAULT_QA_TEMPLATE = `# QA end-to-end test

You are running a **full end-to-end test** of a feature that has already been
merged into this project. Use the **Playwright MCP** browser tools to drive the
running app through the feature like a real user would, then report a verdict.

Project: \`{{project_path}}\`

## The feature under test

**{{task_title}}**

{{task_description}}

## Steps

1. \`cd "{{project_path}}"\` so you are working against the real project tree.
2. Understand what the feature does and where it lives. Skim the relevant
   source / recent git history (\`git log --oneline -15\`) if the description
   above is thin.
3. The project's app should already be running locally — **do not start, stop,
   or restart any dev servers** (the user runs them in their own console).
   Work out its local URL (check the README / \`package.json\` scripts / the
   ports it listens on) and open it with the Playwright browser tools.
4. Exercise the feature **end-to-end** with Playwright: navigate, click, type,
   and assert on what the page actually shows. Cover the main happy path and at
   least one edge/error case where it makes sense. The browser may be headless
   or headed depending on the QA-lane toggle — that's already configured.
5. Decide a verdict: **PASS** (the feature works as described) or **FAIL**
   (it doesn't — capture exactly what broke and how to reproduce it), and how
   **confident** you are in that verdict (\`high\` only if you genuinely
   exercised the feature end-to-end and are sure; otherwise \`low\`).
6. **Append your verdict to the Lattice task** so it stays on the task board
   after this terminal closes:

   \`\`\`bash
   curl -s -X POST {{summary_url}} \\
     -H "Content-Type: text/markdown" \\
     --data-binary @- <<'EOF'
   **QA e2e (Playwright):** PASS — <one-line verdict>
   - <what you tested>
   - <anything notable, or "no issues">
   EOF
   \`\`\`

   Replace the body with your real findings. On FAIL, lead with \`FAIL\` and the
   reproduction steps.

7. **Then report the structured verdict** so Lattice can advance the task.
   A **confident PASS auto-moves the task to Done**; a FAIL — or a PASS you are
   not confident in — leaves it in the QA lane for a human to review. Only send
   \`"confidence":"high"\` when you are genuinely sure the feature works:

   \`\`\`bash
   curl -s -X POST {{verdict_url}} \\
     -H "Content-Type: application/json" \\
     -d '{"verdict":"pass","confidence":"high"}'
   \`\`\`

   Use \`"verdict":"fail"\` if it didn't work, or \`"confidence":"low"\` if you
   couldn't fully verify it.

8. Then stop — Lattice's Stop hook closes this terminal automatically once you
   stop, so make sure both curls above have already run.
`;
