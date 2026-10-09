// The machine-global settings shape (`~/.lattice/globalSettings.json`, served
// by `GET`/`PATCH /api/global-settings`). Types only, and node-free — the
// frontend re-exports it through `../shared/wireTypes.ts`. The facade
// `../globalSettings.ts` imports node, so the declaration lives HERE and the
// facade re-exports it; backend importers keep their old path. Never import a
// non-type module from here.

import type { McpServerEntry } from '../mcp/types.js';
import type { OpengrepGlobalSettings } from '../opengrep/types.js';
import type { PiProvider } from '../piModels/types.js';

export type GlobalSettings = {
  // Max agents Lattice runs concurrently — the spawn queue's softCap. Spawns
  // above this are deferred in the queue, never dropped.
  maxConcurrentAgents: number;
  // User-added MCP servers (the built-in catalog stays in code). Definitions
  // only — secret VALUES live in `~/.lattice/mcpSecrets.json`, never here.
  mcpCustomServers?: McpServerEntry[];
  // Per-id partial overrides of built-in catalog entries (e.g. edited args).
  mcpBuiltinOverrides?: Record<string, Partial<McpServerEntry>>;
  // Curated Pi model menu — `provider/model` patterns surfaced as "Pi — X"
  // rows in the harness dropdowns. Empty/absent → the default menu (every
  // models.json-declared model + Pi's current default; see piModels.ts).
  // Machine-global because Pi config (~/.pi/agent/) is machine-global.
  piModelMenu?: string[];
  // Lattice-managed Pi providers (OpenAI-compatible endpoints — e.g. vLLM).
  // Reconciled INTO `~/.pi/agent/models.json` on save/boot (Lattice owns these
  // provider ids there; hand-written providers are preserved). Secret VALUES
  // are stored inline here per the v1-simple decision: literal, an env-var
  // name, or a `!command` — all resolved by Pi natively. See piModels.ts.
  piProviders?: PiProvider[];
  // Opengrep (SAST) rule-pack enables — machine-global because the packs are
  // installed once per machine under `~/.lattice/opengrep/rules/`. See
  // opengrep/settings.ts (`packs: { [packId]: boolean }`, absent = the pack's
  // default).
  opengrep?: OpengrepGlobalSettings;
  // Free disk space (GB) that creating a task worktree must leave on the
  // volume holding `~/.lattice/worktrees/`. A run whose checkout would dip
  // below it waits in the spawn queue instead of filling the disk (see
  // worktree/diskSpace.ts). Absent → DEFAULT_MIN_FREE_DISK_GB. 0 still defers
  // a checkout that cannot fit at all.
  minFreeDiskGb?: number;
  // When a task run is deferred for disk space and the project has
  // Ready-to-Merge tasks (whose worktrees are what fills the disk), start a
  // merge run to free them — unless a merge run, workflow run, or post-merge
  // hook is already active there. Absent counts as true; false opts out. See
  // diskPressureMerge.ts.
  autoMergeOnLowDisk?: boolean;
  // Hold new fan-out spawns (task runs, workflow steps) while system CPU is
  // saturated or RAM is low, beneath the `maxConcurrentAgents` ceiling. Absent
  // counts as true; false opts out. See spawnQueue/resourceGovernor.ts.
  resourceGovernor?: boolean;
};
