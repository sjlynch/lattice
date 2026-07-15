import type { HealthSmellId } from '../types.js';
import type { CommentSyntax } from './commentSyntax.js';
import { stripStringsAndComments } from './strip.js';

export type SmellCounter = Map<HealthSmellId, number>;

export function bump(smells: SmellCounter, id: HealthSmellId, by = 1): void {
  smells.set(id, (smells.get(id) ?? 0) + by);
}

const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b/g;
// NB: the non-escape branch is `[^\\\r\n]`, NOT `.` — a backslash must be
// consumable by ONLY the `\\.` escape branch. Allowing `.` to also match a lone
// backslash makes a backslash run tileable in exponentially many ways, so a line
// like an unterminated Windows path (`"C:\a\a\a…` with no closing quote) triggers
// catastrophic backtracking and hangs the whole health scan (ReDoS). Excluding
// `\r\n` (which `.` already skips) keeps the match single-line as before, so it
// can't run past a missing closing quote into the next line's quote.
const LONG_STRING_RE = /(["'`])(?:\\.|(?!\1)[^\\\r\n]){200,}\1/g;
const MAGIC_NUM_RE = /(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g;
const MAGIC_NUM_ALLOW = new Set(['0', '1', '-1', '2', '10', '100', '1000']);

// "Looks like code, not prose": at least one of these patterns is required for
// a line to count as code-shaped. Just having a paren or equals sign — common in
// explanatory English — no longer qualifies.
const CODE_LINE_RE =
  /(?:[;{}](?:\s*(?:\/\/|#).*)?$)|^\s*(?:const|let|var|function|if\s*\(|for\s*\(|while\s*\(|return\b|import\b|export\b|class\s+\w|switch\s*\(|case\b|else\b|try\b|catch\b|throw\b|await\b|async\b|def\s+\w|class\s+\w)|=>|::/;

export function countUniversalSmells(
  content: string,
  syntax: CommentSyntax,
): SmellCounter {
  const smells: SmellCounter = new Map();

  // Each smell is measured in the context where it's meaningful:
  //  - TODO/FIXME markers ("TODO/FIXME comments"): comments + code, never
  //    string data → blank strings, keep comments.
  //  - long string literals: real string/template literals, not a long run
  //    that merely sits inside a comment → blank comments, keep strings.
  //  - magic numbers: code only → blank both strings and comments.
  const codeOnly = stripStringsAndComments(content, syntax);
  const commentsKept = stripStringsAndComments(content, syntax, { comments: false });
  const stringsKept = stripStringsAndComments(content, syntax, { strings: false });

  const todoMatches = commentsKept.match(TODO_RE);
  if (todoMatches && todoMatches.length > 0) {
    bump(smells, 'todo_fixme', todoMatches.length);
  }

  const longStrings = stringsKept.match(LONG_STRING_RE);
  if (longStrings && longStrings.length > 0) {
    bump(smells, 'long_string_literal', longStrings.length);
  }

  // Magic numbers — only count outside string literals + comments.
  let magicCount = 0;
  let m: RegExpExecArray | null;
  MAGIC_NUM_RE.lastIndex = 0;
  while ((m = MAGIC_NUM_RE.exec(codeOnly)) !== null) {
    const tok = m[0];
    if (MAGIC_NUM_ALLOW.has(tok)) continue;
    magicCount++;
  }
  if (magicCount > 0) bump(smells, 'magic_number', magicCount);

  const codeCommentBlocks = countCommentedCodeBlocks(content, syntax);
  if (codeCommentBlocks > 0) bump(smells, 'commented_code', codeCommentBlocks);

  return smells;
}

function countCommentedCodeBlocks(content: string, syntax: CommentSyntax): number {
  if (!syntax.line || syntax.line.length === 0) return 0;
  const lines = content.split(/\r?\n/);
  let blocks = 0;
  let run = 0;
  let runHasCode = false;
  const prefixes = syntax.line;

  for (const raw of lines) {
    const line = raw.trim();
    let stripped: string | null = null;
    for (const p of prefixes) {
      if (line.startsWith(p)) {
        stripped = line.slice(p.length).trim();
        break;
      }
    }
    if (stripped !== null) {
      run++;
      if (CODE_LINE_RE.test(stripped)) runHasCode = true;
    } else {
      if (run >= 3 && runHasCode) blocks++;
      run = 0;
      runHasCode = false;
    }
  }
  if (run >= 3 && runHasCode) blocks++;
  return blocks;
}
