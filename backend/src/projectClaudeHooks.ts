// Merge Lattice's activity hooks into a project's OWN
// `<project>/.claude/settings.local.json` so that ANY Claude session whose
// working dir is inside the project tree — including ones Lattice didn't
// launch (a `claude` you start in your own terminal) — reports its file
// activity. Claude loads `hooks` from that file (additive with the user's
// other settings) for every session it starts in the project.
//
// Unlike the per-worktree writer (claudeStopHook.ts), this MERGES into an
// existing file: it must preserve the user's `permissions` and any of their
// own hooks. Lattice's entries are tagged by their command URL
// (`/api/project-activity/`) so a re-install strips the old ones and re-adds
// fresh, and an opt-out strips them cleanly. The write is skipped when the
// content is byte-identical, so a stable config never churns (which would
// otherwise risk re-triggering Claude's hook-approval).

import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalProjectPath } from './projectPath.js';
import { encodeAgentToken } from './agentActivity.js';

const URL_MARKER = '/api/project-activity/';
const FILE_TOOL_MATCHER = 'Read|Edit|Write|MultiEdit|NotebookEdit';

type HookHandler = { type: string; command?: string };
type HookGroup = { matcher?: string; hooks: HookHandler[] };
type HooksMap = Record<string, HookGroup[]>;

function settingsLocalFile(projectRoot: string): string {
  return path.join(projectRoot, '.claude', 'settings.local.json');
}

function activityCommand(backendOrigin: string, projectRoot: string): string {
  // The token carries the project + a label; the per-session identity comes
  // from the hook body's `session_id`, so a single project-wide token is
  // enough. `agentId` is unused by the project-activity route but the token
  // shape is shared with agentActivity — pass a stable placeholder.
  const token = encodeAgentToken({
    agentId: 'project',
    projectPath: projectRoot,
    label: 'claude',
  });
  // -d @- forwards the hook JSON (stdin); 204 + -s keeps the agent transcript
  // clean; -m 2 bounds the worst case if the backend is down (never blocks —
  // curl exits 7/28, not 2).
  return (
    `curl -s -m 2 -X POST -H "Content-Type: application/json" -d @- ` +
    `${backendOrigin}${URL_MARKER}${token}`
  );
}

function latticeHookGroups(backendOrigin: string, projectRoot: string): HooksMap {
  const cmd = activityCommand(backendOrigin, projectRoot);
  const command: HookHandler[] = [{ type: 'command', command: cmd }];
  return {
    // File tool-use → focus beams. A subagent's own tool-use fires these too,
    // tagged with `agent_id`, so the backend routes the beam to its satellite.
    PreToolUse: [{ matcher: FILE_TOOL_MATCHER, hooks: command }],
    PostToolUse: [{ matcher: FILE_TOOL_MATCHER, hooks: command }],
    // Session lifecycle → orange node appears/disappears (no matcher).
    SessionStart: [{ hooks: command }],
    SessionEnd: [{ hooks: command }],
    // Subagent lifecycle → satellite nodes around the session's node (no
    // matcher = every agent type).
    SubagentStart: [{ hooks: command }],
    SubagentStop: [{ hooks: command }],
  };
}

function isLatticeGroup(group: HookGroup): boolean {
  return (
    Array.isArray(group?.hooks) &&
    group.hooks.some(
      (h) => typeof h?.command === 'string' && h.command.includes(URL_MARKER),
    )
  );
}

// Remove Lattice's hook groups from a hooks map in place; drop now-empty
// event arrays. Returns the same object.
function stripLatticeEntries(hooks: HooksMap): HooksMap {
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => !isLatticeGroup(g));
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  return hooks;
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Write `next` only if it differs from what's on disk; returns whether it wrote.
async function writeIfChanged(file: string, next: string): Promise<boolean> {
  let prev: string | null = null;
  try {
    prev = await fs.readFile(file, 'utf8');
  } catch {
    /* absent */
  }
  if (prev === next) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, next, 'utf8');
  return true;
}

// Merge Lattice's activity hooks into the project's settings.local.json,
// preserving everything else. Idempotent.
export async function installProjectClaudeHooks(
  projectPath: string,
  backendOrigin: string,
): Promise<void> {
  const root = canonicalProjectPath(projectPath);
  const file = settingsLocalFile(root);
  const settings = (await readJson(file)) ?? {};
  const hooks: HooksMap =
    settings.hooks && typeof settings.hooks === 'object'
      ? (settings.hooks as HooksMap)
      : {};
  // Strip any prior Lattice entries (e.g. an old backendOrigin/token) before
  // re-adding, so we never accumulate duplicates.
  stripLatticeEntries(hooks);
  const fresh = latticeHookGroups(backendOrigin, root);
  for (const [event, groups] of Object.entries(fresh)) {
    hooks[event] = [...(hooks[event] ?? []), ...groups];
  }
  settings.hooks = hooks;
  await writeIfChanged(file, JSON.stringify(settings, null, 2));
}

// Strip Lattice's activity hooks (opt-out). Leaves the user's config intact;
// no-op if the file is absent or unparseable.
export async function removeProjectClaudeHooks(
  projectPath: string,
): Promise<void> {
  const root = canonicalProjectPath(projectPath);
  const file = settingsLocalFile(root);
  const settings = await readJson(file);
  if (!settings || typeof settings.hooks !== 'object' || !settings.hooks) return;
  stripLatticeEntries(settings.hooks as HooksMap);
  if (Object.keys(settings.hooks as HooksMap).length === 0) delete settings.hooks;
  await writeIfChanged(file, JSON.stringify(settings, null, 2));
}

// Reconcile the `autoMemoryEnabled` flag in the project's OWN
// settings.local.json so Claude sessions you launch yourself in the project
// tree have auto-memory off (or on), matching the per-project setting. Local
// scope: it overrides the machine-global ~/.claude/settings.json but never
// modifies it. Preserves every other key (hooks, permissions, …) and only
// manages the value Lattice writes (`false`), so a user's explicit `true` is
// left untouched when re-enabling. Idempotent; no-op write when unchanged.
export async function setProjectClaudeMemoryDisabled(
  projectPath: string,
  disabled: boolean,
): Promise<void> {
  const root = canonicalProjectPath(projectPath);
  const file = settingsLocalFile(root);
  const settings = (await readJson(file)) ?? {};
  if (disabled) {
    if (settings.autoMemoryEnabled === false) return;
    settings.autoMemoryEnabled = false;
  } else {
    // Re-enabling: strip only the value we manage. If our `false` isn't there,
    // do nothing (and don't create an otherwise-empty settings file).
    if (settings.autoMemoryEnabled !== false) return;
    delete settings.autoMemoryEnabled;
  }
  await writeIfChanged(file, JSON.stringify(settings, null, 2));
}
