// Regex-based universal helpers used alongside the AST analyzer:
//   - line counting (blank/comment/code split for `commentRatio`)
//   - TODO/FIXME detection
//   - long string literal detection (>200 chars)
//   - magic number detection (numeric literals other than -1/0/1/2)
//   - commented-out code detection (3+ consecutive comment lines that
//     contain code-like constructs, with a tighter heuristic than the
//     prior version to avoid flagging ordinary explanatory prose)
//
// The AST does most of the work; this file exists for the bits that
// are simpler/cheaper to express on the raw text or that need to run
// for fallback (non-AST) languages.

import type { HealthSmellId } from './types.js';

export type CommentSyntax = {
  line?: string[];
  blockOpen?: string;
  blockClose?: string;
};

export const COMMENT_BY_EXT: Record<string, CommentSyntax> = {
  '.ts': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.tsx': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.js': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.jsx': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.mjs': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.cjs': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.go': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.rs': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.java': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.kt': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.kts': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.scala': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.cs': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.c': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.cc': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.cpp': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.cxx': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.h': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.hpp': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.swift': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.dart': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.php': { line: ['//', '#'], blockOpen: '/*', blockClose: '*/' },
  '.py': { line: ['#'] },
  '.pyi': { line: ['#'] },
  '.rb': { line: ['#'] },
  '.sh': { line: ['#'] },
  '.bash': { line: ['#'] },
  '.zsh': { line: ['#'] },
  '.ps1': { line: ['#'] },
  '.r': { line: ['#'] },
  '.toml': { line: ['#'] },
  '.yaml': { line: ['#'] },
  '.yml': { line: ['#'] },
  '.sql': { line: ['--'], blockOpen: '/*', blockClose: '*/' },
  '.lua': { line: ['--'], blockOpen: '--[[', blockClose: ']]' },
  '.html': { blockOpen: '<!--', blockClose: '-->' },
  '.xml': { blockOpen: '<!--', blockClose: '-->' },
  '.css': { blockOpen: '/*', blockClose: '*/' },
  '.scss': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.sass': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.less': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
};

export type SmellCounter = Map<HealthSmellId, number>;

export function bump(smells: SmellCounter, id: HealthSmellId, by = 1): void {
  smells.set(id, (smells.get(id) ?? 0) + by);
}

export type LineCounts = {
  total: number;
  blank: number;
  comment: number;
  code: number;
};

// Counts blank/comment/code lines using the language's comment markers.
export function countLineKinds(content: string, syntax: CommentSyntax): LineCounts {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let blank = 0;
  let comment = 0;
  let code = 0;
  let inBlock = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      blank++;
      continue;
    }
    if (inBlock) {
      comment++;
      if (syntax.blockClose && line.includes(syntax.blockClose)) inBlock = false;
      continue;
    }
    if (syntax.blockOpen && line.startsWith(syntax.blockOpen)) {
      comment++;
      if (!syntax.blockClose || !line.includes(syntax.blockClose, syntax.blockOpen.length)) {
        inBlock = true;
      }
      continue;
    }
    let matchedComment = false;
    if (syntax.line) {
      for (const prefix of syntax.line) {
        if (line.startsWith(prefix)) {
          matchedComment = true;
          break;
        }
      }
    }
    if (matchedComment) comment++;
    else code++;
  }
  return { total: lines.length, blank, comment, code };
}

// ---------- Text-only smells ----------

const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b/g;
const LONG_STRING_RE = /(["'`])(?:\\.|(?!\1).){200,}\1/g;
const MAGIC_NUM_RE = /(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g;
const MAGIC_NUM_ALLOW = new Set(['0', '1', '-1', '2', '10', '100', '1000']);

// "Looks like code, not prose": at least one of these patterns is
// required for a line to count as code-shaped. Just having a paren or
// equals sign — common in explanatory English — no longer qualifies,
// which fixes the false-positive flood we saw on richly-commented
// React files.
const CODE_LINE_RE =
  /(?:[;{}](?:\s*(?:\/\/|#).*)?$)|^\s*(?:const|let|var|function|if\s*\(|for\s*\(|while\s*\(|return\b|import\b|export\b|class\s+\w|switch\s*\(|case\b|else\b|try\b|catch\b|throw\b|await\b|async\b|def\s+\w|class\s+\w)|=>|::/;

export function countUniversalSmells(
  content: string,
  syntax: CommentSyntax,
): SmellCounter {
  const smells: SmellCounter = new Map();

  const todoMatches = content.match(TODO_RE);
  if (todoMatches && todoMatches.length > 0) {
    bump(smells, 'todo_fixme', todoMatches.length);
  }

  const longStrings = content.match(LONG_STRING_RE);
  if (longStrings && longStrings.length > 0) {
    bump(smells, 'long_string_literal', longStrings.length);
  }

  // Magic numbers — only count outside string literals + comments.
  const stripped = stripStringsAndComments(content, syntax);
  let magicCount = 0;
  let m: RegExpExecArray | null;
  MAGIC_NUM_RE.lastIndex = 0;
  while ((m = MAGIC_NUM_RE.exec(stripped)) !== null) {
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

// Replace strings + comments with whitespace (preserving newlines).
// Best-effort lexer; sufficient for keyword-counting heuristics.
export function stripStringsAndComments(
  content: string,
  syntax: CommentSyntax,
): string {
  const out: string[] = [];
  let i = 0;
  const n = content.length;
  const lineCommentPrefixes = syntax.line ?? [];
  const blockOpen = syntax.blockOpen;
  const blockClose = syntax.blockClose;

  while (i < n) {
    const c = content[i];

    if (blockOpen && content.startsWith(blockOpen, i)) {
      const closeIdx = blockClose
        ? content.indexOf(blockClose, i + blockOpen.length)
        : -1;
      const end = closeIdx === -1 ? n : closeIdx + (blockClose?.length ?? 0);
      for (let j = i; j < end; j++) {
        out.push(content[j] === '\n' ? '\n' : ' ');
      }
      i = end;
      continue;
    }

    let matchedLineComment = false;
    for (const prefix of lineCommentPrefixes) {
      if (content.startsWith(prefix, i)) {
        const eol = content.indexOf('\n', i);
        const end = eol === -1 ? n : eol;
        for (let j = i; j < end; j++) out.push(' ');
        i = end;
        matchedLineComment = true;
        break;
      }
    }
    if (matchedLineComment) continue;

    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out.push(' ');
      i++;
      while (i < n) {
        const ch = content[i];
        if (ch === '\\' && i + 1 < n) {
          out.push(content[i + 1] === '\n' ? '\n' : ' ');
          out.push(' ');
          i += 2;
          continue;
        }
        if (ch === quote) {
          out.push(' ');
          i++;
          break;
        }
        out.push(ch === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }

    out.push(c);
    i++;
  }
  return out.join('');
}
