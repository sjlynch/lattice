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
import { encodeAgentToken } from './agentActivityTokens.js';
import { atomicWriteFile } from './claudeTrust/configFile.js';

const URL_MARKER = '/api/project-activity/';
const FILE_TOOL_MATCHER = 'Read|Edit|Write|MultiEdit|NotebookEdit';

type HookHandler = { type: string; command?: string };
type HookGroup = { matcher?: string; hooks: HookHandler[] };
type HooksMap = Record<string, HookGroup[]>;

function settingsLocalFile(projectRoot: string): string {
  return path.join(projectRoot, '.claude', 'settings.local.json');
}

// The project-activity hook URL. The token carries the project + a label (the
// graph node's name); the per-session identity comes from the hook body's
// `session_id`, so a single project-wide token is enough. `agentId` is unused
// by the project-activity route but the token shape is shared with
// agentActivity — pass a stable placeholder. Also used for sidebar Codex
// sessions (projectCodexHooks.ts), with label 'codex'.
export function projectActivityUrl(
  backendOrigin: string,
  projectRoot: string,
  label = 'claude',
): string {
  const token = encodeAgentToken({ agentId: 'project', projectPath: projectRoot, label });
  return `${backendOrigin}${URL_MARKER}${token}`;
}

function activityCommand(backendOrigin: string, projectRoot: string): string {
  // -d @- forwards the hook JSON (stdin); 204 + -s keeps the agent transcript
  // clean; -m 2 bounds the worst case if the backend is down (never blocks —
  // curl exits 7/28, not 2).
  return (
    `curl -s -m 2 -X POST -H "Content-Type: application/json" -d @- ` +
    projectActivityUrl(backendOrigin, projectRoot)
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
    // Turn + session lifecycle (no matcher): the node shows while a turn runs
    // — UserPromptSubmit brings it up, Stop takes it down after a grace — and
    // SessionEnd removes it for good (projectClaude/lifecycle.ts).
    UserPromptSubmit: [{ hooks: command }],
    Stop: [{ hooks: command }],
    SessionStart: [{ hooks: command }],
    SessionEnd: [{ hooks: command }],
    // Subagent lifecycle → satellite nodes around the session's node (no
    // matcher = every agent type).
    SubagentStart: [{ hooks: command }],
    SubagentStop: [{ hooks: command }],
  };
}

function isLatticeHandler(handler: HookHandler): boolean {
  return typeof handler?.command === 'string' && handler.command.includes(URL_MARKER);
}

// Remove Lattice's hook handlers from a hooks map in place. Filters per
// HANDLER, not per group: a group can hold the user's own handler beside ours
// (hand-edited, or a tool that files hooks by event + matcher), and dropping
// the whole group silently deleted theirs. A group is dropped only once its
// `hooks` array is empty, and an event only once it has no groups left.
// Returns the same object.
function stripLatticeEntries(hooks: HooksMap): HooksMap {
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept: HookGroup[] = [];
    for (const group of groups) {
      if (!Array.isArray(group?.hooks) || !group.hooks.some(isLatticeHandler)) {
        kept.push(group);
        continue;
      }
      const handlers = group.hooks.filter((h) => !isLatticeHandler(h));
      if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
    }
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  return hooks;
}

// A settings file that exists but does not parse (the user mid-edit, a stray
// trailing comma, a non-object root). Distinct from ABSENT: every writer below
// must leave such a file alone — treating it as `{}` and writing back used to
// replace the user's whole `settings.local.json` (permissions, env, their own
// hooks) with just Lattice's entries.
//
// A file that exists but can't be READ right now (EBUSY/EPERM/EACCES — on
// Windows an antivirus scan, an editor or a sync tool briefly holding it) is
// MALFORMED too, not absent: only ENOENT means absent. Treating any read error
// as "absent" built the settings from `{}` and renamed that over the user's
// file.
const MALFORMED = Symbol('malformed-settings');

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

async function readJson(
  file: string,
): Promise<Record<string, unknown> | null | typeof MALFORMED> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    return isNotFound(err) ? null : MALFORMED;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : MALFORMED;
  } catch {
    return MALFORMED;
  }
}

function warnMalformed(file: string, action: string): void {
  console.warn(
    `[project-claude-hooks] ${file} exists but is not a readable JSON object; ${action} skipped so the file is never overwritten`,
  );
}

// Write `next` only if it differs from what's on disk; returns whether it wrote.
// A non-ENOENT read error skips the write: the file exists but we can't see
// it, so writing could only clobber it.
async function writeIfChanged(file: string, next: string): Promise<boolean> {
  let prev: string | null = null;
  try {
    prev = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (!isNotFound(err)) {
      console.warn(
        `[project-claude-hooks] could not read ${file} (${(err as NodeJS.ErrnoException)?.code ?? err}); write skipped so the file is never overwritten`,
      );
      return false;
    }
  }
  if (prev === next) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  // This is the USER's own `.claude/settings.local.json` (their permissions,
  // hooks, env). Temp + rename, never an in-place write: a crash or a
  // force-kill mid-write would otherwise leave it truncated.
  await atomicWriteFile(file, next);
  return true;
}

// Every writer below is a read-modify-write of the same file, and a project
// open runs the hook reconcile and the auto-memory reconcile back to back — a
// second open / settings save overlapping them used to interleave the two
// read-modify-writes, so the later write (built from a stale read) dropped the
// other's change (the hooks, or `autoMemoryEnabled: false`) until the next
// reconcile. Serialize per file.
const fileQueues = new Map<string, Promise<void>>();

function withSettingsFile(file: string, fn: () => Promise<void>): Promise<void> {
  const previous = fileQueues.get(file) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const settled = run.catch(() => {});
  fileQueues.set(file, settled);
  void settled.then(() => {
    if (fileQueues.get(file) === settled) fileQueues.delete(file);
  });
  return run;
}

// Merge Lattice's activity hooks into the project's settings.local.json,
// preserving everything else. Idempotent.
export async function installProjectClaudeHooks(
  projectPath: string,
  backendOrigin: string,
): Promise<void> {
  const root = canonicalProjectPath(projectPath);
  const file = settingsLocalFile(root);
  return withSettingsFile(file, () => installHooksLocked(file, root, backendOrigin));
}

async function installHooksLocked(
  file: string,
  root: string,
  backendOrigin: string,
): Promise<void> {
  const existing = await readJson(file);
  if (existing === MALFORMED) return warnMalformed(file, 'hook install');
  const settings = existing ?? {};
  const fresh = latticeHookGroups(backendOrigin, root);
  // A `hooks` value (or one of the events we add to) that isn't the documented
  // shape is the user's mistake to fix, not ours to "repair": spreading a
  // string event value splices it into characters, and an array `hooks` loses
  // our keys in JSON.stringify. Leave the file alone, like a malformed one.
  if (
    settings.hooks != null &&
    (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks) ||
      Object.keys(fresh).some((event) => {
        const groups = (settings.hooks as Record<string, unknown>)[event];
        return groups !== undefined && !Array.isArray(groups);
      }))
  ) {
    return warnMalformed(file, 'hook install');
  }
  const hooks: HooksMap = (settings.hooks as HooksMap | null | undefined) ?? {};
  // Strip any prior Lattice entries (e.g. an old backendOrigin/token) before
  // re-adding, so we never accumulate duplicates.
  stripLatticeEntries(hooks);
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
  return withSettingsFile(file, async () => {
    const settings = await readJson(file);
    if (settings === MALFORMED) return warnMalformed(file, 'hook removal');
    if (!settings || typeof settings.hooks !== 'object' || !settings.hooks) return;
    if (Array.isArray(settings.hooks)) return warnMalformed(file, 'hook removal');
    stripLatticeEntries(settings.hooks as HooksMap);
    if (Object.keys(settings.hooks as HooksMap).length === 0) delete settings.hooks;
    await writeIfChanged(file, JSON.stringify(settings, null, 2));
  });
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
  return withSettingsFile(file, async () => {
    const existing = await readJson(file);
    if (existing === MALFORMED) return warnMalformed(file, 'auto-memory reconcile');
    const settings = existing ?? {};
    if (disabled) {
      if (settings.autoMemoryEnabled === false) return;
      settings.autoMemoryEnabled = false;
    } else {
      // Re-enabling: strip only the value we manage. If our `false` isn't
      // there, do nothing (and don't create an otherwise-empty settings file).
      if (settings.autoMemoryEnabled !== false) return;
      delete settings.autoMemoryEnabled;
    }
    await writeIfChanged(file, JSON.stringify(settings, null, 2));
  });
}
