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
// Shell commands are free text, so their paths are only CANDIDATES: the routes
// keep one only if it names an existing file inside the project/worktree.
// Anything the graph can't find would otherwise show a label for a file that
// isn't there. Patch headers are checked the same way (see `HookFiles`).
//
// Relative paths come back relative to the hook's `cwd`: a shell tool's
// `workdir` and a leading `cd <dir> &&` are folded in here, so the routes only
// ever resolve against the session's own working directory.

import fs from 'node:fs';
import path from 'node:path';
import { fileFromHookBody, toolFromHookBody } from './claudeHookBody.js';

export type HookFiles = {
  files: string[];
  // True when every one of `files` must be confirmed to exist before it's
  // drawn: paths guessed from free text (a shell command), and apply_patch
  // headers — an Add / Move-to target doesn't exist yet at PreToolUse, and a
  // Delete target or a moved-away source no longer exists at PostToolUse, so
  // each phase keeps exactly the paths that exist at that moment.
  mustExist: boolean;
};

// At most this many files per tool use — applied by `decodeActivityHook` AFTER
// mapping + the existence check. A patch touching 30 files, or a `cat` of a
// whole directory glob, would otherwise open 30 beams at once.
export const MAX_FILES_PER_TOOL_USE = 8;

// Bound on the raw candidates one tool use yields. Well above
// MAX_FILES_PER_TOOL_USE on purpose: most file-looking shell tokens aren't
// files (an `rg "foo.bar"` pattern, import specifiers in a heredoc), and
// capping before the existence check let eight non-files crowd out the real one.
export const MAX_CANDIDATES_PER_TOOL_USE = 64;

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

function dedupeBound(files: string[]): string[] {
  return [...new Set(files)].slice(0, MAX_CANDIDATES_PER_TOOL_USE);
}

// Git Bash / MSYS spells `C:\x` as `/c/x`, which Node on Windows reads as
// `C:\c\x`. Shell text from a Windows agent uses that form for `cd` targets
// and absolute paths alike.
function nativePath(p: string): string {
  if (process.platform !== 'win32') return p;
  const m = /^\/([A-Za-z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${m[2] ?? '/'}` : p;
}

// `rel` taken relative to `dir`. A relative `dir` keeps the result relative
// (the route resolves it against the hook's cwd); an absolute `rel` wins.
function under(dir: string | null, rel: string): string {
  const r = nativePath(rel);
  return dir && !path.isAbsolute(r) ? path.join(nativePath(dir), r) : r;
}

// Every path named on an apply_patch file header, in patch order.
export function filesFromApplyPatch(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(PATCH_HEADER_RE)) out.push(m[1]);
  return dedupeBound(out);
}

// A token that could be a file path: has a file extension, and isn't a flag,
// a URL, a glob, a variable, an assignment or a sed/awk program.
const FILE_EXT_RE = /\.[A-Za-z0-9_-]{1,10}$/;
const NOT_A_PATH_RE = /^-|^[a-z][a-z0-9+.-]*:\/\/|[*?$={}`]/i;

// A shell wrapper around the real script — `bash -lc "…"`, `pwsh -Command …`,
// `cmd /c …` (optionally path-qualified / `.exe`). Codex's shell tool often
// sends its command this way.
const SHELL_WRAPPER_RES = [
  /^(?:\S*[\\/])?(?:bash|sh|zsh|dash|ksh)(?:\.exe)?\s+(?:-[A-Za-z]+\s+)*?-[A-Za-z]*c\s+/,
  /^(?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?\s+(?:\S+\s+)*?-c(?:ommand)?\s+/i,
  /^(?:\S*[\\/])?cmd(?:\.exe)?\s+\/[ck]\s+/i,
];

// The script inside any shell wrappers, outer quotes removed.
function unwrapShell(command: string): string {
  let script = command.trim();
  for (let changed = true; changed; ) {
    changed = false;
    for (const re of SHELL_WRAPPER_RES) {
      const m = re.exec(script);
      if (!m) continue;
      script = script.slice(m[0].length).trim();
      const q = script[0];
      if ((q === '"' || q === "'") && script.length > 1 && script.endsWith(q)) {
        script = script.slice(1, -1).trim();
      }
      changed = true;
    }
  }
  return script;
}

// A leading `cd <dir> &&` / `cd <dir>;` / `Set-Location [-Path] <dir>;` (and
// cmd's `cd /d <dir> &&`). The dir is group 1 (double-quoted), 2
// (single-quoted) or 3 (bare).
const LEADING_CD_RE =
  /^(?:cd|chdir|Set-Location|sl)\s+(?:\/d\s+|-(?:Literal)?Path\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|'"]+))\s*(?:&&|;|\r?\n)/i;
// Any directory change in what's left of the script. Past that one leading
// `cd`, a command that moves around (a second cd, pushd, a subshell
// `(cd x && …)`) leaves later relative paths unresolvable, so its candidates
// are dropped — a missed beam beats a wrong one.
const DIR_CHANGE_RE =
  /(?:^|[\s;&|("'{`])(?:cd|chdir|pushd|popd|Set-Location|Push-Location|Pop-Location|sl)(?=$|[\s;&|)"'`])/i;
// A cd target we can't resolve textually: `cd -`, `cd ~/x`, `cd $DIR`, `cd %X%`.
const UNRESOLVABLE_DIR_RE = /^[-~]|[$%`*?]/;

// Split a script into its leading cd target (null when none) and the rest.
// Null when that target can't be resolved textually.
function splitLeadingCd(script: string): { dir: string | null; rest: string } | null {
  const m = LEADING_CD_RE.exec(script);
  if (!m) return { dir: null, rest: script };
  const dir = m[1] ?? m[2] ?? m[3];
  if (UNRESOLVABLE_DIR_RE.test(dir)) return null;
  return { dir, rest: script.slice(m[0].length) };
}

// Whitespace/operator-split tokens of a script, quotes stripped, that look
// like `something.ext`.
function fileLikeTokens(script: string): string[] {
  const out: string[] = [];
  for (const raw of script.split(/[\s|;&<>()]+/)) {
    const tok = raw.replace(/^['"]+|['",]+$/g, '');
    if (!tok || tok.length > 400) continue;
    // (`--file=src/a.ts` style is rejected by the `-`/`=` rule — a miss, not a
    // wrong beam.)
    if (NOT_A_PATH_RE.test(tok) || !FILE_EXT_RE.test(tok)) continue;
    out.push(tok);
  }
  return out;
}

// Candidate file paths in a shell command, relative to the directory the shell
// starts in. Deliberately loose — the route keeps only the candidates that
// exist on disk. A leading `cd <dir> &&` is followed (later tokens resolve
// under it); any other directory change yields nothing. A script that is an
// `apply_patch` heredoc is read as the patch it is.
export function candidateFilesFromShell(command: string): string[] {
  const split = splitLeadingCd(unwrapShell(command));
  if (!split) return [];
  const { dir, rest } = split;
  let files: string[];
  // A patch's headers are authoritative whatever its body says (a `cd` in a
  // hunk is text, not a directory change).
  if (/^\s*apply_patch\b/.test(rest)) files = filesFromApplyPatch(rest);
  else if (DIR_CHANGE_RE.test(rest)) return [];
  else files = fileLikeTokens(rest);
  return dedupeBound(files.map((f) => under(dir, f)));
}

// The files one tool-use hook is about (empty when it names none).
export function filesFromHookBody(body: unknown): HookFiles {
  const direct = fileFromHookBody(body);
  if (direct) return { files: [direct], mustExist: false };
  const input = toolInput(body);
  if (!input) return { files: [], mustExist: false };
  // Codex's `exec_command` runs in `workdir` (absolute, or relative to the
  // hook's cwd) rather than the session cwd.
  const workdir = typeof input.workdir === 'string' && input.workdir ? input.workdir : null;
  const tool = toolFromHookBody(body).toLowerCase();
  if (tool === 'apply_patch') {
    const patch = commandText(input.command) ?? commandText(input.patch) ?? commandText(input.input);
    const files = patch ? filesFromApplyPatch(patch) : [];
    return { files: files.map((f) => under(workdir, f)), mustExist: true };
  }
  if (SHELL_TOOLS.has(tool)) {
    const cmd = commandText(input.command) ?? commandText(input.cmd);
    const files = cmd ? candidateFilesFromShell(cmd) : [];
    return { files: files.map((f) => under(workdir, f)), mustExist: true };
  }
  return { files: [], mustExist: false };
}

// Whether `abs` is an existing regular file (never throws). The routes use it
// to confirm a shell-command / patch path before beaming to it.
export function isExistingFile(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}
