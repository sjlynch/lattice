// Which files a PreToolUse/PostToolUse hook body is about — across harnesses.
//
// All three harnesses deliver a Claude-shaped hook body (`hook_event_name`,
// `tool_name`, `tool_input`, optional `agent_id`/`agent_type`) to the activity
// routes, but they name files differently:
//
//   - Claude (and the Pi activity extension, which mimics it): Read / Edit /
//     Write / MultiEdit carry ONE `tool_input.file_path`; NotebookEdit carries
//     `notebook_path`.
//   - Codex: edits go through `apply_patch`, whose `tool_input.command` is the
//     patch text — every touched file is named on a `*** Add File:` /
//     `*** Update File:` / `*** Delete File:` / `*** Move to:` header. Codex has
//     no read tool at all: it reads with the shell (`Bash`, `tool_input.command`
//     — `cat`, `sed -n`, `rg`, `Get-Content`, …).
//
// Shell commands are free text, so their paths are only CANDIDATES
// (`speculative: true`): the routes keep one only if it names an existing file
// inside the project/worktree. Anything the graph can't find would otherwise
// show a label for a file that isn't there.

import fs from 'node:fs';
import { fileFromHookBody, toolFromHookBody } from './claudeHookBody.js';

export type HookFiles = {
  files: string[];
  // True when `files` were guessed from free text (a shell command) and must be
  // confirmed to exist before they're drawn.
  speculative: boolean;
};

// At most this many files per tool use. A patch touching 30 files, or a
// `cat` of a whole directory glob, would otherwise open 30 beams at once.
export const MAX_FILES_PER_TOOL_USE = 8;

// Tool names a harness uses for "run a shell command".
const SHELL_TOOLS = new Set([
  'bash',
  'shell',
  'local_shell',
  'exec_command',
  'unified_exec',
  'powershell',
]);

const PATCH_HEADER_RE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm;

function toolInput(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const input = (body as Record<string, unknown>).tool_input;
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
}

// A command-ish field as text: a string as-is, an argv array joined by spaces.
function commandText(v: unknown): string | null {
  if (typeof v === 'string') return v || null;
  if (Array.isArray(v)) {
    const parts = v.filter((p): p is string => typeof p === 'string');
    return parts.length ? parts.join(' ') : null;
  }
  return null;
}

function dedupeCap(files: string[]): string[] {
  return [...new Set(files)].slice(0, MAX_FILES_PER_TOOL_USE);
}

// Every path named on an apply_patch file header, in patch order.
export function filesFromApplyPatch(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(PATCH_HEADER_RE)) out.push(m[1]);
  return dedupeCap(out);
}

// A token that could be a file path: has a file extension, and isn't a flag,
// a URL, a glob, a variable, an assignment or a sed/awk program.
const FILE_EXT_RE = /\.[A-Za-z0-9_-]{1,10}$/;
const NOT_A_PATH_RE = /^-|^[a-z][a-z0-9+.-]*:\/\/|[*?$={}`]/i;

// Candidate file paths in a shell command: whitespace/operator-split tokens,
// quotes stripped, that look like `something.ext`. Deliberately loose — the
// route keeps only the candidates that exist on disk.
export function candidateFilesFromShell(command: string): string[] {
  const out: string[] = [];
  for (const raw of command.split(/[\s|;&<>()]+/)) {
    const tok = raw.replace(/^['"]+|['",]+$/g, '');
    if (!tok || tok.length > 400) continue;
    // (`--file=src/a.ts` style is rejected by the `-`/`=` rule — a miss, not a
    // wrong beam.)
    if (NOT_A_PATH_RE.test(tok) || !FILE_EXT_RE.test(tok)) continue;
    out.push(tok);
  }
  return dedupeCap(out);
}

// The files one tool-use hook is about (empty when it names none).
export function filesFromHookBody(body: unknown): HookFiles {
  const direct = fileFromHookBody(body);
  if (direct) return { files: [direct], speculative: false };
  const input = toolInput(body);
  if (!input) return { files: [], speculative: false };
  const tool = toolFromHookBody(body).toLowerCase();
  if (tool === 'apply_patch') {
    const patch = commandText(input.command) ?? commandText(input.patch) ?? commandText(input.input);
    return { files: patch ? filesFromApplyPatch(patch) : [], speculative: false };
  }
  if (SHELL_TOOLS.has(tool)) {
    const cmd = commandText(input.command) ?? commandText(input.cmd);
    return { files: cmd ? candidateFilesFromShell(cmd) : [], speculative: true };
  }
  return { files: [], speculative: false };
}

// Whether `abs` is an existing regular file (never throws). The routes use it
// to confirm a speculative (shell-command) path before beaming to it.
export function isExistingFile(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}
