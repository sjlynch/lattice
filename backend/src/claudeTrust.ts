// Pre-seed Claude Code's "trust this folder" dialog (and reconcile Lattice's
// managed MCP servers) for the directories Lattice spawns Claude in. Without it,
// every new push-scratch and home-scoped worktree dir prompts the user on first
// spawn, because trust is per-project-root and those dirs are brand new each
// time. `--dangerously-skip-permissions` does NOT cover this — the trust gate
// runs before any settings load and has no documented CLI/env/settings.json knob
// (anthropics/claude-code#28506, #29285). Trust state is persisted in
// `~/.claude.json` under `projects.<forward-slash-abs-path>.hasTrustDialogAccepted`,
// which Claude writes itself on accept; pre-writing it skips the prompt. We
// depend on an undocumented internal key — if Anthropic renames it the dialog
// will come back (not destructive, just annoying).
//
// This file is the STABLE PUBLIC FACADE. The implementation is split into
// `claudeTrust/` (see its CLAUDE.md):
//   - apply.ts        — `applyClaudeProjectConfig` / `seedClaudeTrust`: the
//                       trust + MCP-reconcile write path (the apply mechanism
//                       only — no policy resolution lives here).
//   - configFile.ts   — `~/.claude.json` primitives: parse-on-read with
//                       heal-from-backup, the atomic temp→rename writer, the
//                       restore-from-backup path, and `atomicWriteFile`.
//   - configLock.ts   — the mkdir-based config mutex with bounded retry + steal.
//   - maintenance.ts  — boot/timer sweeps: prune dead ephemeral `projects[<cwd>]`
//                       entries + reclaim orphaned `.lattice-*.tmp` temps.
//   - util.ts         — `sleep` + best-effort remove helpers.
//
// Keep external imports pointed at `./claudeTrust.js`; only the four submodules
// import each other. Both this file and `claudeTrust/*` are in the terminal-
// server's content fingerprint (terminalFingerprint.ts) — see ../mcp/CLAUDE.md
// "Injection sites" for why the write mechanism is fingerprinted while the MCP
// policy modules deliberately are not.
export {
  CLAUDE_GLOBAL_CONFIG,
  CLAUDE_JSON_BACKUP,
  atomicWriteFile,
  restoreClaudeConfigFromBackup,
} from './claudeTrust/configFile.js';
export { applyClaudeProjectConfig, seedClaudeTrust } from './claudeTrust/apply.js';
export {
  isLatticeEphemeralProjectKey,
  selectStaleEphemeralProjectKeys,
  pruneStaleClaudeProjectEntries,
  sweepOrphanedClaudeConfigTemps,
} from './claudeTrust/maintenance.js';
