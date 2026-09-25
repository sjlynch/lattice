import { canonicalProjectPath } from '../projectPath.js';
import { getUserSettings } from '../userSettings.js';
import { ensureLatticeRepoExclude } from '../worktree.js';
import {
  ensurePiSubagentsInstalled,
  getPiSubagentsEntry,
  installPiSubagentsShim,
} from '../piSubagents.js';
import { ensurePiMcpInstalled } from '../piMcp.js';
import { applyClaudeProjectConfig } from '../claudeTrust.js';
import { resolveManagedClaudeServers } from '../mcp/registry.js';
import {
  installProjectClaudeHooks,
  projectActivityUrl,
  removeProjectClaudeHooks,
  setProjectClaudeMemoryDisabled,
} from '../projectClaudeHooks.js';
import { installPiActivityExtension, removeProjectPiActivityExtension } from '../piActivity.js';
import { detectHarnesses } from '../harnessDetect.js';

export type ProjectInstrumentationResult = {
  enabled: boolean;
  memoryDisabled: boolean;
};

export async function reconcileProjectInstrumentation(
  project: string,
  backendOrigin: string,
): Promise<ProjectInstrumentationResult> {
  // Both default ON — absent settings count as enabled (opt-out model).
  const settings = await getUserSettings(project);
  const enabled = settings.instrumentProjectClaudeSessions !== false;
  const memoryDisabled = settings.disableClaudeMemory !== false;
  const root = canonicalProjectPath(project);

  // Either feature writes <project>/.claude/settings.local.json; keep it out
  // of the user's `git status` via the repo-local, untracked
  // `.git/info/exclude` — never by editing their tracked `.gitignore` (see
  // worktree/setupProject.ts). Not a git repo / nested project → no-op.
  if (enabled || memoryDisabled) {
    await ensureLatticeRepoExclude(root).catch(() => {});
  }

  await reconcileProjectClaudeMcp(root, project);
  await reconcileProjectClaudeHooks(project, backendOrigin, enabled);
  await setProjectClaudeMemoryDisabled(project, memoryDisabled);
  installProjectPiSubagentsShim(root);
  reconcileProjectPiActivity(root, backendOrigin, enabled);

  return { enabled, memoryDisabled };
}

async function reconcileProjectClaudeMcp(
  root: string,
  project: string,
): Promise<void> {
  // Reconcile the project's GLOBAL MCP servers (`mcpOverrides`, incl. the
  // Settings → MCP Playwright toggle) into the user's own project-root
  // `~/.claude.json` entry, so a `claude` the user starts themselves at the
  // project root — or a Lattice sidebar terminal (cwd = project root) — picks
  // them up in `/mcp`. This is the ONE place Lattice intentionally writes the
  // canonical project-root entry (everything else injects into ephemeral
  // worktree/scratch cwds); `reconcileMcpServers` only manages Lattice's own
  // servers (the `__latticeManagedMcp` marker), so the user's hand-added MCP
  // entries are never touched, and turning a global toggle off strips it back
  // out. Runs regardless of the instrumentation toggle, and `isQaRun` is left
  // false so the QA-only Playwright never lands here. Best-effort.
  // NB: Claude keys config by launch cwd, so this covers sessions started AT
  // the project root, not ones launched from a subdirectory.
  const managed = await resolveManagedClaudeServers(project, { isQaRun: false });
  await applyClaudeProjectConfig(root, { managed });
}

async function reconcileProjectClaudeHooks(
  project: string,
  backendOrigin: string,
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    await installProjectClaudeHooks(project, backendOrigin);
  } else {
    await removeProjectClaudeHooks(project);
  }
}

// The Pi analogue of the project Claude hooks: `.pi/extensions/lattice-activity.ts`
// at the project ROOT in project mode (piActivity.ts), so a `pi` the user runs
// in a sidebar tab (cwd = project root; Pi extension discovery is cwd-exact)
// gets a graph node + beams. (Codex tabs get theirs per launch instead — see
// projectCodexHooks.ts.) Written only when `pi` is installed, so a project
// never grows a `.pi/` dir for a harness nobody uses; the file is in the repo
// exclude list (worktree/managedFiles.ts). Best-effort and backgrounded.
function reconcileProjectPiActivity(root: string, backendOrigin: string, enabled: boolean): void {
  if (!enabled) {
    void removeProjectPiActivityExtension(root);
    return;
  }
  void detectHarnesses()
    .then(async (available) => {
      if (!available.pi) return;
      await ensureLatticeRepoExclude(root).catch(() => {});
      await installPiActivityExtension({
        dir: root,
        activityUrl: projectActivityUrl(backendOrigin, root, 'pi'),
        projectSession: true,
      });
    })
    .catch(() => {});
}

function installProjectPiSubagentsShim(root: string): void {
  // pi-subagents (best-effort, non-blocking): ensure the shared install,
  // then drop the loader shim at the project ROOT so a `pi` the user starts
  // in the Lattice terminal panel (cwd = project root) gets sub-agents — Pi
  // extension discovery is cwd-exact, so this is the only way to reach a
  // manually-typed `pi`. Backgrounded so a cold first-time install (~20s)
  // doesn't delay this response; the shim still lands once it resolves.
  void ensurePiSubagentsInstalled()
    .then(async () => {
      if (!getPiSubagentsEntry()) return;
      await ensureLatticeRepoExclude(root).catch(() => {});
      await installPiSubagentsShim({ dir: root }).catch(() => {});
    })
    .catch(() => {});
  // Also pre-warm the pi-mcp-adapter install so a sidebar `pi` at the project
  // root that has an MCP server enabled finds a shim target on first spawn. We
  // do NOT drop the MCP shim / .pi/mcp.json at the project root here — that's
  // done at the spawn chokepoint (applyPiMcpForSpawn), gated on the toggle, so
  // a project with no Pi MCP enabled never gets the files (see plan D8).
  void ensurePiMcpInstalled().catch(() => {});
}
