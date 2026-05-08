// Drops a single markdown cheatsheet into <project>/.lattice/LATTICE_API.md
// so AI agents running inside Lattice-spawned terminals can discover the
// HTTP API without any per-machine setup, harness-specific config, or
// pollution of the user's repo or shell. The terminal-server points
// $LATTICE_DOCS at this file so the agent can `cat $LATTICE_DOCS` whenever
// the user mentions Lattice / tasks / merging.
//
// Conservative creation: only writes if `<project>/.lattice/` already
// exists, so non-Lattice projects (and the user's $HOME) aren't seeded
// with stray folders. Once written, the file is left alone — the user can
// edit it without fear of overwrite.

import fs from 'node:fs';
import path from 'node:path';

export const LATTICE_API_DOC_FILENAME = 'LATTICE_API.md';
const LATTICE_DIR = '.lattice';

function buildDocContent(apiPort: number): string {
  return `# Lattice API

This terminal was spawned by Lattice — a local task / worktree orchestrator
running on this machine. The Lattice HTTP API is reachable from this shell.

The following environment variables are set in this terminal session only
(they are NOT in the user's global env):

- \`LATTICE_API_URL\` — base URL of the API (default \`http://127.0.0.1:${apiPort}\`)
- \`LATTICE_PROJECT\` — absolute path of the active Lattice project
- \`LATTICE_DOCS\` — absolute path to this file

If the user asks you to add tasks to "the lattice taskboard", "the
taskboard", or otherwise references Lattice's task / merge pipeline, use
the API below instead of asking how to reach it.

## Creating a task

\`\`\`bash
curl -s -X POST "$LATTICE_API_URL/api/tasks" \\
  -H "Content-Type: application/json" \\
  -d "{
    \\"project\\": \\"$LATTICE_PROJECT\\",
    \\"title\\": \\"<short title>\\",
    \\"description\\": \\"<details, including any file paths or constraints>\\"
  }"
\`\`\`

The response is the new task with its \`id\`.

## Creating many tasks at once

\`\`\`bash
curl -s -X POST "$LATTICE_API_URL/api/tasks/batch" \\
  -H "Content-Type: application/json" \\
  -d "{
    \\"project\\": \\"$LATTICE_PROJECT\\",
    \\"tasks\\": [
      { \\"title\\": \\"first\\",  \\"description\\": \\"...\\" },
      { \\"title\\": \\"second\\", \\"description\\": \\"...\\" }
    ]
  }"
\`\`\`

## Endpoint reference

| Method | Path | Purpose |
|--------|------|---------|
| GET    | /api/tasks?project=                  | List tasks for a project |
| GET    | /api/tasks/:id                       | Fetch a single task |
| POST   | /api/tasks                           | Create one task |
| POST   | /api/tasks/batch                     | Create many tasks |
| PATCH  | /api/tasks/:id                       | Update title / description / status |
| DELETE | /api/tasks/:id                       | Remove a task |
| POST   | /api/tasks/:id/run                   | Spawn worktree + Claude on an Open task |
| POST   | /api/tasks/:id/resume                | Re-spawn Claude in an existing worktree |
| POST   | /api/tasks/:id/merge                 | Attempt git merge of a Ready-to-Merge task |
| POST   | /api/merge-runs                      | Body \`{project}\` — merge every Ready-to-Merge task |
| GET    | /api/merge-runs/active?project=      | Active merge run, or \`null\` |
| POST   | /api/merge-runs/:id/cancel           | Cancel a merge run |
| GET    | /api/workflow-runs/active?project=   | Active workflow runs |
| POST   | /api/workflows/:id/run               | Start a workflow run |
| GET    | /api/settings?project=               | Read per-project user settings |
| PATCH  | /api/settings?project=               | Update per-project user settings |

Task statuses: \`backlog | open | in_progress | ready_to_merge | qa | done | deleted\`

Pipeline: \`open → in_progress → ready_to_merge → qa → done\`. Tasks land in
\`open\` when created. Click ▶ in the UI (or POST \`/run\`) to spawn a Claude
in an isolated worktree branch. When that Claude finishes, the task moves
to \`ready_to_merge\`. POST \`/merge\` (or use \`/merge-runs\` for batch) to
land the changes on main.

## Tips when seeding tasks programmatically

- Pass \`$LATTICE_PROJECT\` verbatim as the \`project\` field on every
  request — that's the canonical path Lattice uses to key its state.
- Group related changes into a single task. Multiple tasks editing the
  same lines of the same file will conflict during the auto-merge, which
  spawns a resolver Claude in each conflicted worktree (slow + brittle).
- Put concrete file paths and acceptance criteria in \`description\` —
  every task spawns a fresh Claude with no memory of the user's prior
  conversation.
- On Windows, JSON bodies need escaped backslashes (\`C:\\\\foo\\\\bar\`).

This file is auto-created by Lattice once per project and not touched
again. Edit freely.
`;
}

export function ensureLatticeApiDoc(
  projectPath: string,
  apiPort: number,
): string | null {
  if (!projectPath) return null;
  const latticeDir = path.join(projectPath, LATTICE_DIR);
  try {
    if (!fs.existsSync(latticeDir)) return null;
  } catch {
    return null;
  }
  const docPath = path.join(latticeDir, LATTICE_API_DOC_FILENAME);
  try {
    if (fs.existsSync(docPath)) return docPath;
  } catch {
    return null;
  }
  try {
    fs.writeFileSync(docPath, buildDocContent(apiPort), 'utf8');
    return docPath;
  } catch {
    return null;
  }
}
