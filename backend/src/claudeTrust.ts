// Pre-seed Claude Code's "trust this folder" dialog (and reconcile Lattice's
// managed MCP servers) for the directories Lattice spawns Claude in — every new
// push-scratch / home worktree dir would otherwise prompt on first spawn (trust
// is per project root). `--dangerously-skip-permissions` does NOT cover it: the
// gate runs before any settings load and has no documented CLI/env/settings.json
// knob (anthropics/claude-code#28506, #29285). Pre-writing `~/.claude.json`
// `projects.<forward-slash-abs-path>.hasTrustDialogAccepted` (what Claude writes
// itself on accept) skips it. That key is undocumented — if Anthropic renames it
// the dialog comes back (annoying, not destructive).
//
// STABLE PUBLIC FACADE over `claudeTrust/` (module map: claudeTrust/CLAUDE.md).
// Keep external imports pointed at `./claudeTrust.js`; only the submodules import
// each other. This file and `claudeTrust/*` are in the terminal-server's content
// fingerprint (terminalFingerprint.ts) — see ../mcp/CLAUDE.md "Injection sites"
// for why the write mechanism is fingerprinted while the MCP policy modules
// deliberately are not.
export {
  CLAUDE_GLOBAL_CONFIG,
  CLAUDE_JSON_BACKUP,
  restoreClaudeConfigFromBackup,
} from './claudeTrust/configFile.js';
export { applyClaudeProjectConfig, seedClaudeTrust } from './claudeTrust/apply.js';
export {
  isLatticeEphemeralProjectKey,
  selectStaleEphemeralProjectKeys,
  pruneStaleClaudeProjectEntries,
  sweepOrphanedClaudeConfigTemps,
} from './claudeTrust/maintenance.js';
