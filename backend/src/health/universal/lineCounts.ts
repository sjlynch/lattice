import type { CommentSyntax } from './commentSyntax.js';

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
    const result = classifyLine(line, syntax, inBlock);
    inBlock = result.inBlock;
    if (result.hasCode) code++;
    else comment++;
  }
  return { total: lines.length, blank, comment, code };
}

// Scan one (already-trimmed, non-blank) line, carrying block-comment state in
// and out. A line counts as code when it has any real code outside comments —
// including code that follows a block comment's `*/` close on the same line.
function classifyLine(
  line: string,
  syntax: CommentSyntax,
  inBlock: boolean,
): { hasCode: boolean; inBlock: boolean } {
  const { blockOpen, blockClose } = syntax;
  const linePrefixes = syntax.line ?? [];
  const n = line.length;
  let i = 0;
  let hasCode = false;

  while (i < n) {
    if (inBlock) {
      if (!blockClose) break;
      const closeAt = line.indexOf(blockClose, i);
      if (closeAt === -1) break;
      inBlock = false;
      i = closeAt + blockClose.length;
      continue;
    }

    const ch = line[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }

    if (blockOpen && line.startsWith(blockOpen, i)) {
      if (!blockClose) break;
      const closeAt = line.indexOf(blockClose, i + blockOpen.length);
      if (closeAt === -1) {
        inBlock = true;
        break;
      }
      i = closeAt + blockClose.length;
      continue;
    }

    const linePrefix = linePrefixes.find((p) => line.startsWith(p, i));
    if (linePrefix) break; // rest of the line is a line comment

    if (ch === '"' || ch === "'" || ch === '`') {
      hasCode = true;
      i = skipStringLiteral(line, i);
      continue;
    }

    hasCode = true;
    i++;
  }

  return { hasCode, inBlock };
}

// Skip a single-line string literal; returns the index just past it (or the
// end of the line if it doesn't close here).
function skipStringLiteral(line: string, start: number): number {
  const quote = line[start];
  const n = line.length;
  let i = start + 1;
  while (i < n) {
    const ch = line[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return n;
}
