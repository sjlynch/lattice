// The always-on Lattice discovery preamble: one short paragraph folded into
// every harness's system prompt at the spawn chokepoint, naming Lattice's
// trigger words and the absolute path of this project's LATTICE_API.md.
//
// Why the system prompt, and not something cheaper:
//   - Env vars can't work. The old `LATTICE_DOCS`/`LATTICE_PROJECT`/… pty
//     breadcrumbs were invisible to every harness — none of them read the
//     environment into context, so the pointer never reached a model.
//   - The terminal banner (../terminalBanner.ts) can't work either. It is
//     appended to the session's SCROLLBACK, which is the browser's replay
//     buffer; the pty child never receives those bytes. It's human-only chrome.
//   - Writing the pointer INTO the pty would reach the model, but it arrives as
//     the session's first user turn — which Claude Code then uses to name the
//     session, and which the user sees in their terminal.
// A system prompt is the only channel that is invisible to the user, takes no
// part in session naming, and exists on all three harnesses.
//
// Cost discipline: this rides on EVERY spawn in EVERY project, so it stays one
// short paragraph that does nothing but point. The reference body is read on
// demand, if and only if the model follows the pointer.

import { ensureLatticeApiDoc } from '../latticeApiDocs.js';
import { getBackendServerConfig } from '../server/config.js';

// ONE line, and no double quotes. For Codex this text rides a
// `-c developer_instructions='''…'''` override through a `"%VAR%"` expansion,
// and cmd.exe (the Windows pty default) strips inner double quotes and breaks
// on an embedded newline. See inject.ts's tomlMultilineLiteral.
export function buildLatticePreamble(docPath: string): string {
  return (
    'This session runs inside Lattice, a local orchestrator that runs coding ' +
    'agents in git worktrees and tracks their work on a task board. If the user ' +
    'asks about Lattice itself — the task board or its lanes, tasks, worktrees, ' +
    'merging, workflows, startup terminals, or the Lattice HTTP API — read the ' +
    `reference at ${docPath} before answering or acting, and drive the API from ` +
    'it instead of guessing or searching the filesystem for task files.'
  );
}

// Resolve the preamble for a project, generating/refreshing its
// `.lattice/LATTICE_API.md` in the process. Returns null when there is nothing
// to point at (no `.lattice/` dir — Lattice never seeds one into a project it
// doesn't manage) so an unmanaged cwd spawns with a stock system prompt.
export function resolveLatticePreamble(projectPath: string): string | null {
  if (!projectPath) return null;
  try {
    const docPath = ensureLatticeApiDoc(projectPath, getBackendServerConfig().port);
    if (!docPath) return null;
    const text = buildLatticePreamble(docPath);
    // Defensive: a `"` or a TOML `'''` inside the project path would break the
    // Codex `-c` transit described above. Both are essentially impossible in a
    // real path (a `"` is illegal in Windows filenames), but dropping the
    // preamble is strictly better than emitting a command that fails to parse.
    if (text.includes('"') || text.includes("'''")) return null;
    return text;
  } catch {
    return null;
  }
}

// Join the Lattice preamble with the project's own Append override, preserving
// that order — Lattice's pointer is context the agent needs regardless, and the
// user's text reads as the more specific instruction when it comes last.
// Either side may be absent; returns undefined when both are.
export function composeSystemPromptAppend(
  preamble: string | null,
  userAppend: string | undefined,
  separator = '\n\n',
): string | undefined {
  const parts = [preamble, userAppend].filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0,
  );
  if (parts.length === 0) return undefined;
  return parts.join(separator);
}
