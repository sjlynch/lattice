// Drops a single markdown cheatsheet into <project>/.lattice/LATTICE_API.md
// so AI agents running inside Lattice-spawned terminals can discover the
// HTTP API without any per-machine setup, harness-specific config, or
// pollution of the user's repo or shell. The terminal-server points
// $LATTICE_DOCS at this file so the agent can `cat $LATTICE_DOCS` whenever
// the user mentions Lattice / tasks / merging.
//
// Conservative creation: only writes if `<project>/.lattice/` already
// exists, so non-Lattice projects (and the user's $HOME) aren't seeded
// with stray folders.
//
// Version-aware regeneration: a hash of the current content is stamped
// into the first line. If the on-disk file's hash doesn't match, we
// rewrite — so existing projects pick up doc improvements on the next
// pty spawn instead of being stuck with whatever shipped first.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LATTICE_API_DOC_FILENAME = 'LATTICE_API.md';
const LATTICE_DIR = '.lattice';
const VERSION_PREFIX = '<!-- lattice-docs-version: ';
const VERSION_SUFFIX = ' -->';

function buildBody(apiPort: number): string {
  return `# Lattice API

Lattice is a local task / worktree orchestrator running on this machine.
This terminal has these env vars set (this session only — not your global env):

- \`$LATTICE_API_URL\` — API base URL (default \`http://127.0.0.1:${apiPort}\`)
- \`$LATTICE_PROJECT\` — active project's absolute path
- \`$LATTICE_DOCS\` — absolute path to this file

If the user mentions tasks / taskboard / merging / worktrees, drive the
HTTP API below directly — don't ask how to reach it.

## Hard rules

1. **Don't write helper scripts into \`.lattice/\`.** That folder is
   Lattice's managed state — leftover \`.py\` / \`.sh\` / \`.js\` files
   there are a mess for the user. If you need a temp script, put it in
   \`$env:TEMP\` (Windows) or \`/tmp\` (POSIX) and delete it when done.
   Most operations below are one-liners and need no script at all.
2. **Use forward slashes in JSON paths.** Lattice canonicalizes
   \`F:/rust_etl\` and \`F:\\\\rust_etl\` to the same project, so the
   forward-slash form sidesteps every JSON / shell escape headache.
   For URL query strings, let the HTTP client URL-encode the raw value.

## Recipes

### Seeding many tasks at once — markdown body (any shell, zero escaping)

The simplest way to batch-create tasks. A heredoc with single-quoted
\`'EOF'\` passes the body through *literally* — no JSON, no escaping,
no \`jq\`, no python. Each \`# Heading\` is a task title; lines below it
become the description until the next heading.

\`\`\`bash
curl -s -X POST "$LATTICE_API_URL/api/tasks/batch?project=$LATTICE_PROJECT" \\
  -H "Content-Type: text/markdown" --data-binary @- <<'EOF'
# Resolve readme.md merge-conflict markers
Lines 418 and 471-598 still have <<<<<<</>>>>>>> markers from a prior merge.
Reconcile both sections and ensure the docs reflect the current code.

# Refactor PartitionWriters concurrency contract
The doc claims "concurrency-friendly" but write_with takes &mut self,
preventing real cross-thread use. Either:
- Change to &self (sound, since each partition is already Mutex<...>)
- Or strip the docs and per-partition mutexes (former preferred).
EOF
\`\`\`

### Creating a single task — form-encoded (no JSON at all)

\`\`\`bash
curl -X POST "$LATTICE_API_URL/api/tasks?project=$LATTICE_PROJECT" \\
  --data-urlencode "title=<short title>" \\
  --data-urlencode "description=<details, multi-line OK>"
\`\`\`

### List & count (no script needed)

PowerShell — \`Invoke-RestMethod\` (alias \`irm\`) handles JSON automatically:
\`\`\`pwsh
# all open tasks
$proj = $env:LATTICE_PROJECT.Replace('\\','/')
irm "$env:LATTICE_API_URL/api/tasks?project=$([uri]::EscapeDataString($proj))&status=open"

# counts by status (one round trip, no client-side tally)
irm "$env:LATTICE_API_URL/api/tasks/summary?project=$([uri]::EscapeDataString($proj))"
# → @{ total = 36; byStatus = @{ open = 8; done = 28 } }
\`\`\`

bash — \`curl --data-urlencode\` does the encoding for you:
\`\`\`bash
curl -sG "$LATTICE_API_URL/api/tasks" \\
  --data-urlencode "project=$LATTICE_PROJECT" \\
  --data-urlencode "status=open"

curl -sG "$LATTICE_API_URL/api/tasks/summary" \\
  --data-urlencode "project=$LATTICE_PROJECT"
\`\`\`

You can also pass multiple statuses: \`?status=open,in_progress\`.

### Create one task

PowerShell — hashtable + \`ConvertTo-Json\`. No quote escaping, no
backslash gymnastics, multi-line descriptions just work:
\`\`\`pwsh
$body = @{
  project = $env:LATTICE_PROJECT.Replace('\\','/')
  title = '<short title>'
  description = @'
Multi-line is fine. "Quotes" and \\backslashes\\ pass through untouched.
For paths inside the description, use forward slashes: F:/rust_etl/src/foo.rs
'@
} | ConvertTo-Json -Depth 5
irm -Method Post -Uri "$env:LATTICE_API_URL/api/tasks" -ContentType 'application/json' -Body $body
\`\`\`

bash — if \`jq\` is available, pipe its output as the body; otherwise
write JSON to \`$TMPDIR/lattice_*.json\`, POST it, then delete:
\`\`\`bash
jq -nc \\
  --arg project   "$LATTICE_PROJECT" \\
  --arg title     "<short title>" \\
  --arg description "<details>" \\
  '{project:$project, title:$title, description:$description}' |
curl -s -X POST "$LATTICE_API_URL/api/tasks" \\
  -H "Content-Type: application/json" --data-binary @-
\`\`\`

### Create many tasks at once

PowerShell scales naturally — same hashtable pattern, with a list:
\`\`\`pwsh
$body = @{
  project = $env:LATTICE_PROJECT.Replace('\\','/')
  tasks = @(
    @{ title = 'first';  description = 'details 1' },
    @{ title = 'second'; description = 'details 2' }
  )
} | ConvertTo-Json -Depth 5
irm -Method Post -Uri "$env:LATTICE_API_URL/api/tasks/batch" -ContentType 'application/json' -Body $body
\`\`\`

### Update a task

\`\`\`pwsh
irm -Method Patch -Uri "$env:LATTICE_API_URL/api/tasks/$id" \`
    -ContentType 'application/json' -Body (@{ status = 'qa' } | ConvertTo-Json)
\`\`\`

\`\`\`bash
curl -s -X PATCH "$LATTICE_API_URL/api/tasks/$id" \\
  -H "Content-Type: application/json" -d '{"status":"qa"}'
\`\`\`

### Bulk status transition

Move many tasks to a new status in one call — by explicit IDs or by the
lane they're currently in. Idempotent (tasks already at the target are
no-op):

\`\`\`bash
# Mark every "qa" task as done in one round trip
curl -s -X POST "$LATTICE_API_URL/api/tasks/transition?project=$LATTICE_PROJECT" \\
  -H "Content-Type: application/json" \\
  -d '{"fromStatus":"qa","status":"done"}'

# Or by explicit ids
curl -s -X POST "$LATTICE_API_URL/api/tasks/transition" \\
  -H "Content-Type: application/json" \\
  -d '{"ids":["t_abc","t_def"],"status":"done"}'
\`\`\`

## Endpoint reference

| Method | Path | Purpose |
|--------|------|---------|
| GET    | /api/tasks?project=&status=        | List tasks; \`status\` optional, comma-separated |
| GET    | /api/tasks/summary?project=        | \`{ total, byStatus }\` counts |
| GET    | /api/tasks/:id                     | Fetch one task |
| POST   | /api/tasks                         | Create one (JSON, form-encoded, or query-string \`project\`) |
| POST   | /api/tasks/batch                   | Create many — JSON \`{tasks:[...]}\` OR \`text/markdown\` body |
| POST   | /api/tasks/transition              | Bulk status move \`{ids?, fromStatus?, status}\` |
| PATCH  | /api/tasks/:id                     | Update title / description / status |
| POST   | /api/tasks/:id/append-summary      | Append a summary section to the existing description |
| DELETE | /api/tasks/:id                     | Remove a task |
| POST   | /api/tasks/:id/run                 | Spawn worktree + Claude on an open task |
| POST   | /api/tasks/:id/resume              | Re-spawn Claude in an existing worktree |
| POST   | /api/tasks/:id/merge               | Attempt git merge of a Ready-to-Merge task |
| POST   | /api/merge-runs                    | Body \`{project}\` — merge every Ready-to-Merge task |
| GET    | /api/merge-runs/active?project=    | Active merge run, or \`null\` |
| POST   | /api/merge-runs/:id/cancel         | Cancel a merge run |
| GET    | /api/workflow-runs/active?project= | Active workflow runs |
| POST   | /api/workflows/:id/run             | Start a workflow run |
| GET    | /api/settings?project=             | Per-project user settings (read) |
| PATCH  | /api/settings?project=             | Per-project user settings (update) |

Statuses: \`backlog | open | in_progress | ready_to_merge | qa | done | deleted\`.
Pipeline: \`open → in_progress → ready_to_merge → qa → done\` (drag-and-drop
in the UI moves \`qa → done\`; everything else is automated).

## Working with the board

- Group related changes into ONE task. Multiple tasks editing the same
  lines of the same file conflict during the auto-merge, which spawns a
  resolver Claude in each conflicted worktree (slow + brittle).
- Put concrete file paths and acceptance criteria in \`description\`.
  Each task spawns a fresh Claude with no memory of the user's prior
  conversation.
- Pass \`$LATTICE_PROJECT\` (or its forward-slash form) verbatim as the
  \`project\` field. Lattice canonicalizes drive-letter casing.

This file is auto-managed by Lattice. It's regenerated whenever its
content changes upstream — don't edit; fork it elsewhere if you need a
customized copy.
`;
}

function hashContent(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
}

function buildDocContent(apiPort: number): { content: string; hash: string } {
  const body = buildBody(apiPort);
  const hash = hashContent(body);
  return {
    content: `${VERSION_PREFIX}${hash}${VERSION_SUFFIX}\n${body}`,
    hash,
  };
}

function readDocVersion(content: string): string | null {
  const firstLine = content.split('\n', 1)[0];
  if (!firstLine.startsWith(VERSION_PREFIX) || !firstLine.endsWith(VERSION_SUFFIX)) {
    return null;
  }
  return firstLine
    .slice(VERSION_PREFIX.length, firstLine.length - VERSION_SUFFIX.length)
    .trim();
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
  const { content, hash } = buildDocContent(apiPort);
  try {
    if (fs.existsSync(docPath)) {
      const existing = fs.readFileSync(docPath, 'utf8');
      if (readDocVersion(existing) === hash) return docPath;
    }
  } catch {
    // fall through to write
  }
  try {
    fs.writeFileSync(docPath, content, 'utf8');
    return docPath;
  } catch {
    return null;
  }
}
