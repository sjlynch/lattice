// The QA_INSTRUCTIONS.md brief handed to a Playwright-enabled Claude session
// that exercises a merged QA-lane task end-to-end. By the time a task reaches
// the QA lane its branch has merged into the project's default branch and the
// worktree is gone, so this session operates against the real project tree.
//
// Like the push-run brief, the pty runs with `cwd = scratchDir` (so Claude
// reads the Stop hook from cwd) and the agent `cd`s into the project as
// step 1. The Playwright MCP is injected automatically at spawn because the
// QA-lane toggle (`qaPlaywright.enabled`) is on for this project; its
// headless/headed mode is already configured there, so the brief doesn't set
// it.

export function renderQaInstructions(args: {
  projectPath: string;
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  backendOrigin: string;
}): string {
  const { projectPath, taskId, taskTitle, taskDescription, backendOrigin } = args;
  const description = taskDescription?.trim()
    ? taskDescription.trim()
    : '_(no description provided)_';
  const summaryUrl = `${backendOrigin}/api/tasks/${taskId}/append-summary`;

  return `# QA end-to-end test

You are running a **full end-to-end test** of a feature that has already been
merged into this project. Use the **Playwright MCP** browser tools to drive the
running app through the feature like a real user would, then report a verdict.

Project: \`${projectPath}\`

## The feature under test

**${taskTitle}**

${description}

## Steps

1. \`cd "${projectPath}"\` so you are working against the real project tree.
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
   (it doesn't — capture exactly what broke and how to reproduce it).
6. **As your final step, append your verdict to the Lattice task** so it stays
   on the task board after this terminal closes:

   \`\`\`bash
   curl -s -X POST ${summaryUrl} \\
     -H "Content-Type: text/markdown" \\
     --data-binary @- <<'EOF'
   **QA e2e (Playwright):** PASS — <one-line verdict>
   - <what you tested>
   - <anything notable, or "no issues">
   EOF
   \`\`\`

   Replace the body with your real findings. On FAIL, lead with \`FAIL\` and the
   reproduction steps.

7. Then stop — Lattice's Stop hook closes this terminal automatically once you
   stop, so make sure the summary curl has already run.
`;
}
